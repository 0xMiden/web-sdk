// @ts-nocheck
import { test, expect } from "./test-setup";

// A sync that patches an account with a discarded transaction prepares the patch against the
// post-undo state, which exists only in the store's SMT forest until the sync write lands. A
// local read of that account rebuilds the forest from the tables, so it must not run between
// the undo preview and the patch. This test forces exactly that interleaving: it starts the
// read while the preview transaction is open, and holds back every later read of the account
// headers until it has resolved.
test.describe("sync patch of a discarded account during a local read", () => {
  test("commits the node's state", async ({ run }) => {
    test.setTimeout(600_000);

    const result = await run(async ({ sdk }) => {
      const SLOT = "miden::testing::sync_race::map";
      const NAMESPACE = "external_contract::sync_race";
      // Above the mock node's 1000-entry limit, so sync sends incremental patches.
      const ENTRIES = 1001;

      const setter = (name, n) => `
        @account_procedure
        pub proc ${name}
          push.${n}.${n}.${n}.${n}
          push.${n}.${n}.${n}.${n}
          push.MAP_SLOT[0..2]
          exec.::miden::protocol::native_account::set_map_item
          dropw dropw
        end
      `;
      const accountCode = `
        use miden::core::word
        const MAP_SLOT = word("${SLOT}")
        ${setter("set_deploy", 5001)}
        ${setter("set_local", 5002)}
        ${setter("set_remote_one", 5003)}
        ${setter("set_remote_two", 5004)}
      `;

      // Installed before any client opens a database: Dexie binds the connection's
      // `transaction` during open, so a later patch would see nothing. Armed for one sync.
      const PREVIEW_STORES = [
        "accountCode",
        "historicalAccountAssets",
        "historicalAccountHeaders",
        "historicalAccountStorage",
        "historicalStorageMapEntries",
        "latestAccountAssets",
        "latestAccountHeaders",
        "latestAccountStorage",
        "latestStorageMapEntries",
      ].join();
      const probe = {
        previews: 0,
        previewEnded: false,
        readQueuedDuringPreview: false,
        readSettled: false,
      };
      let concurrentRead;
      let awaitingReadTransaction = false;
      let armed = false;
      let reopened;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (stores, mode, options) {
        const tx = original.call(this, stores, mode, options);
        if (!armed) return tx;
        const names = [stores].flat().sort();
        if (mode === "readwrite" && names.join() === PREVIEW_STORES) {
          probe.previews++;
          const ended = () => (probe.previewEnded = true);
          tx.addEventListener("abort", ended);
          tx.addEventListener("complete", ended);
          setTimeout(() => {
            awaitingReadTransaction = true;
            concurrentRead = reopened
              .getAccount(id(second.id))
              .catch(() => undefined)
              .finally(() => (probe.readSettled = true));
          }, 0);
        } else if (
          awaitingReadTransaction &&
          mode === "readonly" &&
          names.includes("latestStorageMapEntries") &&
          names.includes("latestAccountAssets")
        ) {
          awaitingReadTransaction = false;
          probe.readQueuedDuringPreview = !probe.previewEnded;
          // Queued behind the read and ahead of the sync's next header read.
          const gate = original.call(
            this,
            ["latestAccountHeaders"],
            "readwrite"
          );
          const hold = () => {
            if (!probe.readSettled) {
              gate.objectStore("latestAccountHeaders").count().onsuccess = hold;
            }
          };
          hold();
        }
        return tx;
      };

      const createClient = async (chain, storeName) => {
        const client = await window.MockWasmWebClient.createClient(
          chain,
          undefined,
          undefined,
          undefined,
          storeName
        );
        // Sync must run in this realm, where the IndexedDB hook is installed.
        client.worker?.terminate();
        client.worker = null;
        return client;
      };

      const buildAccount = async (client, seedByte) => {
        const map = new sdk.StorageMap();
        for (let i = 1; i <= ENTRIES; i++) {
          map.insert(
            new sdk.Word(sdk.u64Array([i, 0, 0, 1])),
            new sdk.Word(sdk.u64Array([0, 0, 0, i]))
          );
        }
        const builder = await client.createCodeBuilder();
        const component = sdk.AccountComponent.compile(
          builder.compileAccountComponentCodeWithPath(NAMESPACE, accountCode),
          [sdk.StorageSlot.map(SLOT, map)]
        ).withSupportsAllTypes();

        const seed = new Uint8Array(32).fill(seedByte);
        const key = sdk.AuthSecretKey.rpoFalconWithRNG(seed);
        const { account } = new sdk.AccountBuilder(seed)
          .withAuthComponent(
            sdk.AccountComponent.createAuthComponentFromSecretKey(key)
          )
          .withComponent(component)
          .storageMode(sdk.AccountStorageMode.public())
          .build();
        await client.addAccountSecretKeyToWebStore(account.id(), key);
        await client.newAccount(account, false);
        return { id: account.id().toString(), key, component };
      };

      const request = async (client, component, procedure) => {
        const builder = await client.createCodeBuilder();
        builder.linkDynamicAccountComponentCode(component.componentCode());
        const script = builder.compileTxScript(
          `use ${NAMESPACE}
           @transaction_script
           pub proc main
             call.sync_race::${procedure}
           end`
        );
        return new sdk.TransactionRequestBuilder()
          .withCustomScript(script)
          .build();
      };

      const id = (hex) => sdk.AccountId.fromHex(hex);
      const commitment = async (client, hex) =>
        (await client.getAccount(id(hex))).to_commitment().toHex();
      const submit = async (client, account, procedure) => {
        await client.submitNewTransaction(
          id(account.id),
          await request(client, account.component, procedure)
        );
        await client.proveBlock();
        await client.syncState();
      };

      const suffix = Math.random().toString(36).slice(2, 8);
      const localStore = `sync_race_local_${suffix}`;
      const local = await createClient(undefined, localStore);
      await local.syncState();

      const accounts = [
        await buildAccount(local, 0x41),
        await buildAccount(local, 0x42),
      ];
      for (const account of accounts) {
        await submit(local, account, "set_deploy");
      }
      // Sync applies patches in account id order. `first` has no discarded transaction, so in
      // that order its header read sits between the undo preview and the patch of `second`.
      const [first, second] = [...accounts].sort((a, b) =>
        a.id.localeCompare(b.id)
      );

      const remote = await createClient(
        await local.serializeMockChain(),
        `sync_race_remote_${suffix}`
      );
      await remote.syncState();
      for (const account of accounts) {
        await remote.addAccountSecretKeyToWebStore(id(account.id), account.key);
        await remote.newAccount(await local.getAccount(id(account.id)), false);
      }

      // Applied locally and never submitted, so it goes stale and sync discards it.
      const pending = await local.executeTransaction(
        id(second.id),
        await request(local, second.component, "set_local")
      );
      const pendingId = pending.id().toHex();
      await local.applyTransaction(pending, await local.getSyncHeight());

      // Two transactions put the node's nonce past the pending one.
      await submit(remote, second, "set_remote_one");
      await submit(remote, second, "set_remote_two");
      await submit(remote, first, "set_remote_one");
      for (let i = 0; i < 25; i++) await remote.proveBlock();

      const expected = {
        first: await commitment(remote, first.id),
        second: await commitment(remote, second.id),
      };
      const chain = await remote.serializeMockChain();
      local.terminate();
      reopened = await createClient(chain, localStore);

      let syncError = null;
      try {
        armed = true;
        await reopened.syncState();
        await concurrentRead;
      } catch (error) {
        syncError = String(error?.message ?? error);
      } finally {
        armed = false;
        IDBDatabase.prototype.transaction = original;
      }

      const loaded = {};
      let loadError = null;
      try {
        loaded.first = await commitment(reopened, first.id);
        loaded.second = await commitment(reopened, second.id);
      } catch (error) {
        loadError = String(error?.message ?? error);
      }
      const record = (
        await reopened.getTransactions(sdk.TransactionFilter.all())
      ).find((tx) => tx.id().toHex() === pendingId);

      return {
        probe,
        syncError,
        loadError,
        loaded,
        expected,
        discarded: record?.transactionStatus().isDiscarded(),
      };
    });

    // One object, so a failure shows every outcome. `probe` proves the interleaving
    // happened: one undo preview, and the read queued while it was open.
    const { expected, ...outcome } = result;
    expect(outcome).toEqual({
      probe: {
        previews: 1,
        previewEnded: true,
        readQueuedDuringPreview: true,
        readSettled: true,
      },
      syncError: null,
      discarded: true,
      loadError: null,
      loaded: expected,
    });
  });
});
