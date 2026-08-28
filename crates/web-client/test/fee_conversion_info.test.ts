// @ts-nocheck
import { test, expect } from "./test-setup";

// FEE CONVERSION INFO TESTS
// =======================================================================================================
//
// Since protocol 0.16 the auth args of a signature-authenticated transaction
// carry the commitment `hash(CONVERSION_INFO || SALT)` that
// `miden::standards::fee::load_conversion_info` requires, with the preimage in
// the advice map. Without it `fee::pay_fee` aborts with
// `ERR_FEE_CONVERSION_INFO_MISSING` on any chain whose `verification_base_fee`
// is non-zero.
//
// These assertions are deliberately STRUCTURAL rather than behavioural. The
// local test node runs with `verification_base_fee = 0`, so the fee branch is
// skipped entirely and a transaction succeeds whether or not it commits
// anything — a "the transfer worked" test would pass identically with the
// bindings removed. Asserting on the request's own auth arg and advice map
// keeps these honest at any fee level.

test.describe("fee conversion info", () => {
  test("block headers expose the chain's verification base fee", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const request = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );
      const anchor = await client.chainAnchorForRequest(request);
      const header = anchor.blockHeader();

      return {
        baseFee: header.verificationBaseFee(),
        // Read alongside the faucet id so a header that reports a fee but no
        // faucet (or vice versa) is visible rather than silently half-right.
        feeFaucetId: header.feeFaucetId().toString(),
      };
    });

    expect(typeof result.baseFee).toBe("number");
    expect(result.baseFee).toBeGreaterThanOrEqual(0);
    expect(result.feeFaucetId).toMatch(/^0x|^m/);
  });

  test("withFeeConversionInfo commits the conversion info to the auth arg", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { faucet } = await helpers.setupWalletAndFaucet();

      const salt = sdk.Word.newFromFelts([
        new sdk.Felt(11n),
        new sdk.Felt(22n),
        new sdk.Felt(33n),
        new sdk.Felt(44n),
      ]);

      const built = new sdk.TransactionRequestBuilder()
        .withFeeConversionInfo(
          sdk.FeeConversionInfo.oneToOne(faucet.id()),
          salt
        )
        .build();

      const authArg = built.authArg();

      return {
        hasAuthArg: authArg !== undefined,
        // The commitment must not be the salt passed through bare — that is
        // precisely the pre-0.16 shape the MASM rejects.
        authArgIsSalt: authArg?.toHex() === salt.toHex(),
        // The preimage has to be reachable, keyed by the commitment, or
        // `load_conversion_info`'s advice-map lookup misses and the
        // transaction aborts.
        preimageIsKeyedByCommitment:
          built.adviceMap().get(authArg) !== undefined,
      };
    });

    expect(result.hasAuthArg).toBe(true);
    expect(result.authArgIsSalt).toBe(false);
    expect(result.preimageIsKeyedByCommitment).toBe(true);
  });

  test("a request left alone declares no auth arg", async ({ run }) => {
    // The complement of the test above: without an explicit call the builder
    // must not invent an auth arg, or a caller committing its own (the
    // multisig flow, where the salt is the replay guard) would be silently
    // overridden.
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const request = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );

      return { authArg: request.authArg() };
    });

    expect(result.authArg).toBeUndefined();
  });
});
