// @ts-nocheck
import { test, expect } from "./test-setup";

// Regression for the "invalid type: unit value, expected struct
// AccountCodeIdxdbObject" crash. This runs against the real WASM IndexedDB
// store and deliberately removes the code row referenced by an account header.
test.describe("account code dangling regression", () => {
  test("getAccount reports the missing code row instead of a serde error", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const walletId = wallet.id();

      const codeStoreState = await new Promise<{
        countBefore: number;
        countAfter: number;
      }>((resolve, reject) => {
        const request = indexedDB.open("mock_client_db");
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("accountCode", "readwrite");
          const store = tx.objectStore("accountCode");
          const countRequest = store.count();
          let countBefore = 0;

          countRequest.onsuccess = () => {
            countBefore = countRequest.result;
            store.clear();
          };
          tx.oncomplete = () => {
            db.close();
            resolve({ countBefore, countAfter: 0 });
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });

      // Use a fresh client so the read cannot be satisfied by in-memory state.
      const client2 = await helpers.createFreshMockClient();
      let errorMessage: string | null = null;
      let hasAccount = false;
      try {
        const account = await client2.getAccount(walletId);
        hasAccount = account !== undefined && account !== null;
      } catch (error) {
        errorMessage = String(error?.message ?? error);
      }

      return { codeStoreState, errorMessage, hasAccount };
    });

    expect(result.codeStoreState.countBefore).toBeGreaterThan(0);
    expect(result.codeStoreState.countAfter).toBe(0);
    expect(result.hasAccount).toBe(false);
    expect(result.errorMessage).toMatch(/account code.*not found/i);
    expect(result.errorMessage).not.toContain("unit value");
  });
});
