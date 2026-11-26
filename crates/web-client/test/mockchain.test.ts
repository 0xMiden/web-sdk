// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("mock chain tests", () => {
  test.describe.configure({ timeout: 720000 });

  test("send transaction with mock chain completes successfully", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      const account = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucetAccount = await client.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const mintTransactionRequest = await client.newMintTransactionRequest(
        account.id(),
        faucetAccount.id(),
        sdk.NoteType.Public,
        sdk.u64(1000)
      );

      const mintTransactionId = await client.submitNewTransaction(
        faucetAccount.id(),
        mintTransactionRequest
      );
      await client.proveBlock();
      await client.syncState();

      const [mintTransactionRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([mintTransactionId])
      );

      const mintedNoteId = mintTransactionRecord
        .outputNotes()
        .notes()[0]
        .id()
        .toString();

      const mintedNoteRecord = await client.getInputNote(mintedNoteId);

      const mintedNote = mintedNoteRecord.toNote();
      const consumeTransactionRequest =
        await client.newConsumeTransactionRequest([mintedNote], account.id());
      await client.submitNewTransaction(
        account.id(),
        consumeTransactionRequest
      );
      await client.proveBlock();
      await client.syncState();

      const changedTargetAccount = await client.getAccount(account.id());

      const finalBalance = changedTargetAccount
        .vault()
        .getBalance(faucetAccount.id())
        .toString();

      return {
        mintTransactionRecordDefined: mintTransactionRecord !== undefined,
        mintedNoteRecordDefined: mintedNoteRecord !== undefined,
        finalBalance,
      };
    });

    expect(result.mintTransactionRecordDefined).toBe(true);
    expect(result.mintedNoteRecordDefined).toBe(true);
    expect(result.finalBalance).toEqual("1000");
  });

  test("note reads page by details commitment and match caller-supplied nullifiers", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      for (let i = 0; i < 7; i++) {
        const request = await client.newMintTransactionRequest(
          wallet.id(),
          faucet.id(),
          sdk.NoteType.Public,
          sdk.u64(1000 + i)
        );
        await client.submitNewTransaction(faucet.id(), request);
      }
      await client.proveBlock();
      await client.syncState();

      const key = (note) => note.detailsCommitment().toHex();
      const all = await client.getInputNotes(
        new sdk.NoteFilter(sdk.NoteFilterTypes.All)
      );
      const pages = [];
      let after;
      for (;;) {
        const page = await client.getInputNotes(
          new sdk.NoteFilter(sdk.NoteFilterTypes.All).page(after, 3)
        );
        if (page.length === 0) break;
        pages.push(page.map(key));
        after = key(page[page.length - 1]);
      }

      const byNullifier = (hex) =>
        client.getInputNotes(
          new sdk.NoteFilter(
            sdk.NoteFilterTypes.Nullifiers,
            undefined,
            undefined,
            [sdk.Word.fromHex(hex)]
          )
        );
      const stored = all[0];
      const matching = await byNullifier(stored.nullifier());
      const nonmatching = await byNullifier("0x" + "11".repeat(32));

      return {
        total: all.length,
        pages,
        matching: matching.map(key),
        expected: key(stored),
        nonmatching: nonmatching.length,
      };
    });

    expect(result.total).toBe(7);
    expect(result.pages.map((page) => page.length)).toEqual([3, 3, 1]);
    const flat = result.pages.flat();
    expect(new Set(flat).size).toBe(7);
    expect(flat).toEqual([...flat].sort());
    expect(result.matching).toEqual([result.expected]);
    expect(result.nonmatching).toBe(0);
  });

  test("transaction query bounds by account, status and limit, newest first", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const newFaucet = (symbol) =>
        client.newFaucet(
          sdk.AccountStorageMode.private(),
          false,
          symbol,
          symbol,
          8,
          sdk.u64(10000000),
          sdk.AuthScheme.AuthRpoFalcon512
        );
      const faucetA = await newFaucet("AAA");
      const faucetB = await newFaucet("BBB");
      const mint = async (faucet) => {
        const request = await client.newMintTransactionRequest(
          wallet.id(),
          faucet.id(),
          sdk.NoteType.Public,
          sdk.u64(1000)
        );
        await client.submitNewTransaction(faucet.id(), request);
      };

      for (let i = 0; i < 4; i++) await mint(faucetA);
      await client.proveBlock();
      await client.syncState();
      await mint(faucetB);

      const hexA = faucetA.id().toString();
      const ids = (records) => records.map((r) => r.id().toHex());
      const newestFirst = (records) =>
        [...records].sort((a, b) => {
          const byTime = a.creationTimestamp() - b.creationTimestamp();
          if (byTime !== 0n && byTime !== 0) return byTime < 0 ? 1 : -1;
          return a.id().toHex() < b.id().toHex() ? 1 : -1;
        });
      const query = (account, status, limit) =>
        client.getTransactions(
          sdk.TransactionFilter.query(account, status, limit)
        );

      const all = await client.getTransactions(sdk.TransactionFilter.all());
      const fromA = all.filter((r) => r.accountId().toString() === hexA);
      const topThree = await query(hexA, undefined, 3);
      const committed = await query(undefined, "committed", 2);
      const pending = await query(undefined, "pending", undefined);
      const pendingFromA = await query(hexA, "pending", undefined);

      return {
        fromA: fromA.length,
        topThree: ids(topThree),
        expectedTopThree: ids(newestFirst(fromA)).slice(0, 3),
        topThreeAccounts: topThree.map((r) => r.accountId().toString()),
        hexA,
        committedCount: committed.length,
        committedAllCommitted: committed.every((r) =>
          r.transactionStatus().isCommitted()
        ),
        pendingAccounts: pending.map((r) => r.accountId().toString()),
        hexB: faucetB.id().toString(),
        pendingFromA: pendingFromA.length,
      };
    });

    expect(result.fromA).toBe(4);
    expect(result.topThree).toEqual(result.expectedTopThree);
    expect(result.topThree).toHaveLength(3);
    expect(result.topThreeAccounts).toEqual(Array(3).fill(result.hexA));
    expect(result.committedCount).toBe(2);
    expect(result.committedAllCommitted).toBe(true);
    expect(result.pendingAccounts).toEqual([result.hexB]);
    expect(result.pendingFromA).toBe(0);
  });

  // Issue #557: a second mock with its own storeName syncs while the fixture
  // mock still holds mock_client_db.
  test("second mock with distinct storeName can syncState beside the fixture", async ({
    run,
  }) => {
    const result = await run(async ({ helpers }) => {
      const fresh = await helpers.createFreshMockClient();
      await fresh.syncState();
      return { synced: true };
    });
    expect(result.synced).toBe(true);
  });

  test("worker-backed mock with distinct storeName can sync beside the fixture", async ({
    run,
  }) => {
    const result = await run(async ({ helpers }) => {
      const isolatedStore = `mock_worker_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const workerMock = await helpers.createMidenMockClient({
        storeName: isolatedStore,
      });
      try {
        await workerMock.sync();
        await workerMock.syncChain();
        await workerMock.syncNoteTransport();
        return {
          synced: true,
          hadWorker: typeof Worker !== "undefined",
          isolatedStore,
          storeIdentifier: await workerMock.storeIdentifier(),
        };
      } finally {
        workerMock.terminate();
      }
    });
    expect(result.synced).toBe(true);
    if (result.hadWorker) {
      expect(result.storeIdentifier).toBe(result.isolatedStore);
    }
  });
});
