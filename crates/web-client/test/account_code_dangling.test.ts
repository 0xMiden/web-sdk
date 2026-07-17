// @ts-nocheck
import { test, expect } from "./test-setup";

// Regression for the "invalid type: unit value, expected struct
// AccountCodeIdxdbObject" crash: when an account header points at a code root
// with no `accountCode` row, get_account_code used to hand serde a JS `null`
// and panic. It now surfaces a clean, diagnosable store error, and the sync
// path (applyFullAccountState) persists the code so the row is never missing.
//
// Runs fully offline against the in-process mock client (no node), exercising
// the real WASM idxdb-store read path (IndexedDB "mock_client_db").
test.describe("account code dangling regression", () => {
  test("getAccount surfaces a clean error instead of a serde panic when the code row is missing", async ({
    run,
  }, testInfo) => {
    // Browser-only: exercises the WASM idxdb-store over IndexedDB. The nodejs
    // project uses the SQLite store and has no `indexedDB`.
    test.skip(
      testInfo.project.name === "nodejs",
      "browser-only: exercises IndexedDB idxdb-store"
    );

    const result = await run(async ({ client, sdk, helpers }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const walletId = wallet.id();

      // Inspect the store, then delete the account code rows to reproduce the
      // dangling header -> missing code row state the buggy sync produced.
      const codeStoreState = await new Promise<{
        countBefore: number;
        countAfter: number;
      }>((resolve, reject) => {
        const req = indexedDB.open("mock_client_db");
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("accountCode")) {
            db.close();
            resolve({ countBefore: -1, countAfter: -1 });
            return;
          }
          const tx = db.transaction("accountCode", "readwrite");
          const store = tx.objectStore("accountCode");
          const countReq = store.count();
          let countBefore = 0;
          countReq.onsuccess = () => {
            countBefore = countReq.result;
            store.clear();
          };
          tx.oncomplete = () => {
            db.close();
            resolve({ countBefore, countAfter: 0 });
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });

      // A fresh client on the same store forces a read straight from the store
      // (no in-memory account cache), driving get_account_code.
      const client2 = await helpers.createFreshMockClient();

      let errorMessage: string | null = null;
      let hasAccount = false;
      try {
        const account = await client2.getAccount(walletId);
        hasAccount = account !== undefined && account !== null;
      } catch (e: any) {
        errorMessage = String(e?.message ?? e);
      }

      return {
        walletId: walletId.toString(),
        codeStoreState,
        errorMessage,
        hasAccount,
      };
    });

    // The code row must have existed (proves newWallet persisted it) and we
    // cleared it — otherwise the test isn't exercising the crash path.
    expect(result.codeStoreState.countBefore).toBeGreaterThan(0);

    // Post-fix contract: never the raw serde panic. Either a clean store error
    // naming the missing code root (StoreError::AccountCodeDataNotFound), or a
    // graceful empty result.
    expect(result.errorMessage ?? "").not.toContain("unit value");
    if (result.errorMessage !== null) {
      expect(result.errorMessage).toMatch(
        /account code data with root .* not found|failed to fetch account code/i
      );
    }
  });
});
