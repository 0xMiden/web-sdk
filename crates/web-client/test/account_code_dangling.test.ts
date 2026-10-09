// @ts-nocheck
import { test, expect } from "./test-setup";

// Runs against the real WASM IndexedDB store and removes the code row an
// account header names. getAccountCode and feeAwareTransactionRequestBuilder
// both read that row through IdxdbStore::get_account_code, which must report
// the missing root rather than a serde "invalid type: unit value" error.
test.describe("account code dangling regression", () => {
  test("getAccountCode and feeAwareTransactionRequestBuilder report the missing code row", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const walletId = wallet.id();
      const codeRoot = wallet.code().commitment().toHex();

      const codeRowsRemoved = await new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("mock_client_db");
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("accountCode", "readwrite");
          const store = tx.objectStore("accountCode");
          const countRequest = store.count();
          let removed = 0;

          countRequest.onsuccess = () => {
            removed = countRequest.result;
            store.clear();
          };
          tx.oncomplete = () => {
            db.close();
            resolve(removed);
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });

      // Use a fresh client so the read cannot be satisfied by in-memory state.
      const client2 = await helpers.createFreshMockClient();
      const errorOf = async (call) => {
        try {
          await call();
          return null;
        } catch (error) {
          return String(error?.message ?? error);
        }
      };

      return {
        codeRoot,
        codeRowsRemoved,
        getAccountCodeError: await errorOf(() =>
          client2.getAccountCode(walletId)
        ),
        builderError: await errorOf(() =>
          client2.feeAwareTransactionRequestBuilder(walletId)
        ),
      };
    });

    expect(result.codeRowsRemoved).toBeGreaterThan(0);
    for (const message of [result.getAccountCodeError, result.builderError]) {
      expect(message).not.toContain("unit value");
      expect(message).toContain(
        `account code with root ${result.codeRoot} not found`
      );
    }
  });
});
