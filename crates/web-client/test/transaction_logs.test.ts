// @ts-nocheck
import { test, expect } from "./test-setup";

// TRANSACTION LOGS TESTS
// =======================================================================================================

test.describe("transaction logs", () => {
  // The browser store keeps the logs in IndexedDB and the Node.js store keeps
  // them in SQLite, so this runs the write and the read of both. A log read
  // back with a different emitter, topic, content or position would have a
  // different commitment.
  test("the store returns the logs that a transaction emitted", async ({
    run,
  }, testInfo) => {
    const result = await run(async ({ client: rawClient, sdk, helpers }) => {
      const content = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      // Emits two logs with different topics: one with one content word and
      // one without content.
      const code = `
        use miden::protocol::tx

        @account_procedure
        @locals(4)
        pub proc emit_logs
            push.${content.toHex()} loc_storew_le.0 dropw

            locaddr.0 push.1 push.29.17
            # => [topic_suffix, topic_prefix, num_words, content_ptr]
            exec.tx::add_log_from_memory

            locaddr.0 push.0 push.31.19
            # => [topic_suffix, topic_prefix, num_words, content_ptr]
            exec.tx::add_log_from_memory
        end
      `;

      // In the browser every mock client of a page opens the same IndexedDB
      // store, so this client starts from the chain of the page's client.
      const client = await helpers.createMidenMockClient({
        serializedMockChain: await rawClient.serializeMockChain(),
      });
      const component = await client.compile.component({
        code,
        namespace: "external_contract::log_contract",
      });
      const seed = new Uint8Array(32);
      seed.fill(0x51);
      const account = await client.accounts.create({
        type: "ImmutableContract",
        storage: "public",
        seed,
        auth: sdk.AuthSecretKey.rpoFalconWithRNG(seed),
        components: [component],
      });
      await client.proveBlock();
      await client.sync();

      const describe = (logs) =>
        logs && {
          numLogs: logs.numLogs(),
          numContentWords: logs.numContentWords(),
          isEmpty: logs.isEmpty(),
          commitment: logs.commitment().toHex(),
          logs: logs.logs().map((log) => ({
            emitter: log.emitter().toString(),
            topicSuffix: log.topicSuffix().asInt().toString(),
            topicPrefix: log.topicPrefix().asInt().toString(),
            content: log.content().map((word) => word.toHex()),
          })),
        };

      const emitScript = await client.compile.txScript({
        code: `
          use external_contract::log_contract
          @transaction_script
          pub proc main
            call.log_contract::emit_logs
          end
        `,
        libraries: [{ component }],
      });
      const emitting = await client.transactions.execute({
        account: account.id(),
        script: emitScript,
      });
      const executed = describe(emitting.result.executedTransaction().logs());

      // The store has the logs as soon as the transaction is applied.
      const pending = describe(
        await client.transactions.logs(emitting.txId.toHex())
      );
      await client.proveBlock();
      await client.sync();
      // The status update of the sync keeps them. This read passes the ID as
      // an object.
      const committed = describe(await client.transactions.logs(emitting.txId));

      const quietScript = await client.compile.txScript({
        code: `
          @transaction_script
          pub proc main
            push.0 drop
          end
        `,
      });
      const quiet = await client.transactions.execute({
        account: account.id(),
        script: quietScript,
      });
      const quietExecuted = describe(quiet.result.executedTransaction().logs());
      const quietStored = describe(
        await client.transactions.logs(quiet.txId.toHex())
      );

      const unknownId = `0x${"07".repeat(32)}`;
      const unknown = await client.transactions.logs(unknownId);
      // The binding resolves to undefined on both platforms.
      const unknownOnBinding = await rawClient.getTransactionLogs(
        sdk.TransactionId.fromHex(unknownId)
      );

      // The browser store decodes each row in Rust. A row that does not
      // decode must fail the read, and not return a part of the logs. The
      // Node.js store is the SQLite store of the client, so this part runs
      // only where IndexedDB exists.
      let corruptReads = null;
      if (typeof indexedDB !== "undefined") {
        const request = (idbRequest) =>
          new Promise((resolve, reject) => {
            idbRequest.onsuccess = () => resolve(idbRequest.result);
            idbRequest.onerror = () => reject(idbRequest.error);
          });
        const db = await request(indexedDB.open("mock_client_db"));
        const putRow = async (row) => {
          const tx = db.transaction("transactionLogs", "readwrite");
          await request(tx.objectStore("transactionLogs").put(row));
        };
        const key = [emitting.txId.toHex(), 0];
        const original = await request(
          db
            .transaction("transactionLogs")
            .objectStore("transactionLogs")
            .get(key)
        );

        corruptReads = {};
        for (const [column, value] of [
          ["emitter", "0xnot-an-account-id"],
          ["topic", "AQID"],
          ["content", new Uint8Array([1, 2, 3])],
        ]) {
          await putRow({ ...original, [column]: value });
          try {
            await client.transactions.logs(emitting.txId);
            corruptReads[column] = "the read returned logs";
          } catch (error) {
            corruptReads[column] = error?.message ?? String(error);
          }
        }
        await putRow(original);
        db.close();
      }
      const restored = describe(await client.transactions.logs(emitting.txId));

      return {
        accountId: account.id().toString(),
        content: content.toHex(),
        executed,
        pending,
        committed,
        quietExecuted,
        quietStored,
        unknown,
        bindingReturnsUndefined: unknownOnBinding === undefined,
        corruptReads,
        restored,
      };
    });

    expect(result.executed).toEqual({
      numLogs: 2,
      numContentWords: 1,
      isEmpty: false,
      commitment: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      logs: [
        {
          emitter: result.accountId,
          topicSuffix: "17",
          topicPrefix: "29",
          content: [result.content],
        },
        {
          emitter: result.accountId,
          topicSuffix: "19",
          topicPrefix: "31",
          content: [],
        },
      ],
    });
    expect(result.pending).toEqual(result.executed);
    expect(result.committed).toEqual(result.executed);

    // A transaction without logs has an empty collection, and a transaction
    // that the client does not track has none.
    expect(result.quietExecuted.isEmpty).toBe(true);
    expect(result.quietStored).toEqual({
      numLogs: 0,
      numContentWords: 0,
      isEmpty: true,
      commitment: result.quietExecuted.commitment,
      logs: [],
    });
    expect(result.quietStored.commitment).not.toBe(result.executed.commitment);
    expect(result.unknown).toBeNull();
    expect(result.bindingReturnsUndefined).toBe(true);

    if (testInfo.project.name === "nodejs") {
      expect(result.corruptReads).toBeNull();
    } else {
      for (const column of ["emitter", "topic", "content"]) {
        expect(result.corruptReads[column]).toContain(
          "failed to get transaction logs"
        );
      }
      expect(result.corruptReads.topic).toContain(
        "log topic must have 16 bytes, but has 3"
      );
      expect(result.corruptReads.content).toContain("log content has 3 bytes");
    }
    expect(result.restored).toEqual(result.executed);
  });
});
