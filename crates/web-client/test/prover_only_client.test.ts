// @ts-nocheck
import { test, expect } from "./test-setup";

// PROVER-ONLY CLIENT TESTS
// =======================================================================================================
//
// A bare `WebClient` (raw binding, `createClient()` never called) must be able
// to prove a `TransactionResult` when handed an explicit prover: proving is a
// pure computation and involves no client state. Hosts that only prove rely on
// this — e.g. a chrome.offscreen document that runs proves on its own rayon
// thread pool and receives serialized transactions from a service worker.

test.describe("prover-only client", () => {
  test("proveTransaction with an explicit prover works on a bare WebClient", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      // Execute (but do not submit) a mint on a fully initialized client to
      // obtain a real TransactionResult.
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      const mintRequest = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        sdk.u64(1000)
      );
      const txResult = await client.executeTransaction(
        faucet.id(),
        mintRequest
      );

      // Prove it on a bare client that never ran createClient().
      const bare = new sdk.WebClient();
      const prover = sdk.TransactionProver.newLocalProver();
      const proven = await bare.proveTransaction(txResult, prover);
      return { provenLen: proven.serialize().length };
    });

    expect(result.provenLen).toBeGreaterThan(0);
  });
});
