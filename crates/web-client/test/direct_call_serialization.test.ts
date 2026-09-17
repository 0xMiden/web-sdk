// @ts-nocheck
import { test, expect } from "./test-setup";

// DIRECT-PATH CALL SERIALIZATION TESTS
// =======================================================================================================
//
// On the direct (no-worker) path every client call holds the WASM client's
// internal RefCell across its awaits. Proxy-fallback methods (getAccount,
// getAccounts, ... — everything without an explicit JS wrapper) must route
// through `_serializeWasmCall` like the wrapped methods do; a raw-bound
// fallback lets two in-flight calls overlap, which panics the WASM instance
// with "RefCell already borrowed" and poisons it for every later call.
// miden-wallet hit exactly this on mobile (front + back share one client),
// see 0xMiden/web-sdk#180.

test.describe("direct-path call serialization", () => {
  test("concurrent proxy-fallback and wrapped calls do not panic the client", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(wallet.id(), faucet.id());

      // Fire a burst of overlapping calls WITHOUT awaiting in between:
      // syncState (wrapped) holds the client across its awaits while the
      // proxy-fallback reads (getAccount / getAccounts / getTransactions)
      // land mid-flight. Unserialized, this panics the RefCell.
      const rounds = [];
      for (let i = 0; i < 5; i++) {
        rounds.push(
          client.syncState(),
          client.getAccount(wallet.id()),
          client.getAccounts(),
          client.getTransactions(sdk.TransactionFilter.all())
        );
      }
      // A poisoned instance can leave calls pending forever (the panic
      // aborts the WASM mid-call and nothing settles their promises), so
      // race against a sentinel instead of awaiting unconditionally.
      const settled = await Promise.race([
        Promise.allSettled(rounds),
        new Promise((resolve) => setTimeout(() => resolve("STALLED"), 90_000)),
      ]);
      if (settled === "STALLED") {
        return {
          failures: ["calls never settled within 90s"],
          accountCountAfter: -1,
        };
      }
      const failures = settled
        .filter((r) => r.status === "rejected")
        .map((r) => String(r.reason?.message ?? r.reason));

      // The client must still be usable afterwards — a poisoned instance
      // throws "Unreachable code should not be executed" on any call.
      const accountsAfter = await client.getAccounts();

      return { failures, accountCountAfter: accountsAfter.length };
    });

    expect(result.failures).toEqual([]);
    expect(result.accountCountAfter).toBeGreaterThan(0);
  });
});
