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
// These assertions are deliberately STRUCTURAL rather than behavioural. These
// tests run against the mock chain, which builds its blocks with
// `verification_base_fee = 0`, so the fee branch is skipped entirely and a
// transaction succeeds whether or not it commits anything — a "the transfer
// worked" test would pass identically with the bindings removed. Asserting on
// the request's own auth arg and advice map keeps these honest at any fee level.
//
// Every assertion about the convenience constructors is therefore expressed
// against the base fee the header actually reports, rather than against the
// zero the mock chain happens to use. That way the file stays correct if the
// mock chain is ever changed to charge — and the attach path, which no test
// here can currently reach, starts being exercised the moment it is.

test.describe("fee conversion info", () => {
  test("block headers expose the chain's fee parameters", async ({ run }) => {
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

      const feeFaucetId = header.feeFaucetId();

      return {
        baseFee: header.verificationBaseFee(),
        // Round-trip the id through the SDK's own parser rather than pattern
        // matching the string: a garbled or all-zero id would still look like
        // an account id to a regex.
        feeFaucetRoundTrips:
          sdk.AccountId.fromHex(feeFaucetId.toString()).toString() ===
          feeFaucetId.toString(),
        // Reading the header twice must agree — a fee faucet that changes
        // between reads would mean we are not reading the header's own field.
        feeFaucetIsStable:
          anchor.blockHeader().feeFaucetId().toString() ===
          feeFaucetId.toString(),
      };
    });

    // `verification_base_fee` is a u32 on the wire, so it must survive as an
    // exact non-negative integer rather than an arbitrary JS number.
    expect(Number.isInteger(result.baseFee)).toBe(true);
    expect(result.baseFee).toBeGreaterThanOrEqual(0);
    expect(result.baseFee).toBeLessThanOrEqual(0xffffffff);
    expect(result.feeFaucetRoundTrips).toBe(true);
    expect(result.feeFaucetIsStable).toBe(true);
  });

  test("withFeeConversionInfo commits the conversion info to the auth arg", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      // Pay in the chain's own fee asset. `oneToOne` applies the identity rate,
      // which is only meaningful for the faucet the chain actually charges in —
      // so take it from the header rather than reusing an arbitrary token.
      const probe = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );
      const anchor = await client.chainAnchorForRequest(probe);
      const feeFaucetId = anchor.blockHeader().feeFaucetId();

      const salt = sdk.Word.newFromFelts([
        new sdk.Felt(11n),
        new sdk.Felt(22n),
        new sdk.Felt(33n),
        new sdk.Felt(44n),
      ]);

      const info = sdk.FeeConversionInfo.oneToOne(feeFaucetId);

      const built = new sdk.TransactionRequestBuilder()
        .withFeeConversionInfo(info, salt)
        .build();

      const authArg = built.authArg();

      return {
        // `oneToOne` names the asset the fee is paid in, so the faucet it was
        // given has to be the faucet it reports back.
        faucetRoundTrips: info.faucetId().toString() === feeFaucetId.toString(),
        // Compared with `== null` so the napi path (which yields `null` for a
        // Rust `Option::None`) and the wasm-bindgen path (`undefined`) agree.
        hasAuthArg: authArg != null,
        // The commitment must not be the salt passed through bare — that is
        // precisely the pre-0.16 shape the MASM rejects.
        authArgIsSalt: authArg != null && authArg.toHex() === salt.toHex(),
        // The preimage has to be reachable, keyed by the commitment, or
        // `load_conversion_info`'s advice-map lookup misses and the
        // transaction aborts.
        preimageIsKeyedByCommitment:
          authArg != null && built.adviceMap().get(authArg) != null,
        // A word unrelated to the commitment must NOT resolve, or the lookup
        // above would pass against any non-empty advice map.
        unrelatedKeyMisses: built.adviceMap().get(salt) == null,
      };
    });

    expect(result.faucetRoundTrips).toBe(true);
    expect(result.hasAuthArg).toBe(true);
    expect(result.authArgIsSalt).toBe(false);
    expect(result.preimageIsKeyedByCommitment).toBe(true);
    expect(result.unrelatedKeyMisses).toBe(true);
  });

  test("an untouched builder declares no auth arg", async ({ run }) => {
    // Without an explicit call the builder must not invent an auth arg, or a
    // caller committing its own (the multisig flow, where the salt is the
    // replay guard) would be silently overridden.
    const result = await run(async ({ sdk }) => {
      const request = new sdk.TransactionRequestBuilder().build();
      return { hasAuthArg: request.authArg() != null };
    });

    expect(result.hasAuthArg).toBe(false);
  });

  test("convenience constructors attach conversion info exactly when the chain charges", async ({
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
      const baseFee = anchor.blockHeader().verificationBaseFee();
      const authArg = request.authArg();

      return {
        baseFee,
        hasAuthArg: authArg != null,
        // When one is attached it must carry a reachable preimage, exactly as
        // an explicit `withFeeConversionInfo` call would.
        preimageIsKeyedByCommitment:
          authArg != null && request.adviceMap().get(authArg) != null,
      };
    });

    // Pin the type before comparing. `verificationBaseFee` is a `u32`, so it
    // arrives as a number; were it ever `undefined`, `undefined > 0` is `false`
    // and the assertion below would pass for the wrong reason on every chain.
    expect(typeof result.baseFee).toBe("number");

    // Zero-fee chains stay byte-identical to the pre-0.16 shape: no auth arg,
    // no advice entry. Anywhere else the constructor must have attached one.
    expect(result.hasAuthArg).toBe(result.baseFee > 0);
    if (result.baseFee > 0) {
      expect(result.preimageIsKeyedByCommitment).toBe(true);
    }
  });
});
