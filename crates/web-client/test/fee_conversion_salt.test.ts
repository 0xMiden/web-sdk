// @ts-nocheck
import { test, expect } from "./test-setup";

// FEE CONVERSION SALT TESTS
// =======================================================================================================
//
// Since protocol 0.16 the auth args of a signature-authenticated transaction
// carry the commitment `hash(CONVERSION_INFO || SALT)` that
// `miden::standards::fee::load_conversion_info` requires, with the preimage in
// the advice map. Without it `fee::pay_fee` aborts with
// `ERR_FEE_CONVERSION_INFO_MISSING` on any chain whose `verification_base_fee`
// is non-zero.
//
// Callers no longer supply the conversion info: fees are always settled in the
// chain's native fee asset at rate 1/1, and miden-client builds that info and
// commits it through the auth args itself while preparing the transaction. What
// a caller may still declare is the SALT it is committed under, which matters
// only for the multisig flavours that reuse the salt as their transaction
// summary's replay guard.
//
// That is why these assertions are about the DECLARATION rather than the
// commitment. The commitment does not exist at build time — it is written
// during preparation, after anything here can observe it — so a request only
// ever reports the salt it declared. These tests also run against the mock
// chain, which builds its blocks with `verification_base_fee = 0`, so the fee
// branch is skipped entirely; assertions are expressed against the base fee the
// header actually reports rather than the zero the mock chain happens to use,
// so the file stays correct if the mock chain is ever changed to charge.

test.describe("multisig auth args", () => {
  // The auth args are what the approvers sign over, so every value the SDK
  // injects into them has to be pinnable by a caller who is REPRODUCING a
  // proposal rather than receiving one. These run against the mock chain: the
  // assertions are about the request the builder produces, not execution.
  test("the same salt and bound block reproduce the same auth arg", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const salt = new sdk.Word([1n, 2n, 3n, 4n]);

      const pinned = async () =>
        (
          await client.feeAwareTransactionRequestBuilder(multisigAccountId, {
            feeConversionSalt: salt,
            boundBlockNum: 1,
          })
        )
          .build()
          .authArg()
          ?.toHex();

      const defaulted = async () =>
        (await client.feeAwareTransactionRequestBuilder(multisigAccountId))
          .build()
          .authArg()
          ?.toHex();

      return {
        pinnedA: await pinned(),
        pinnedB: await pinned(),
        defaultedA: await defaulted(),
        defaultedB: await defaulted(),
      };
    });

    // Two parties who agree on both values derive the same summary.
    expect(result.pinnedA).toBeTruthy();
    expect(result.pinnedA).toBe(result.pinnedB);
    // Two who agree on neither cannot: the salt is drawn fresh per build. This
    // is the assertion that makes the pinning above non-vacuous.
    expect(result.defaultedA).not.toBe(result.defaultedB);
    expect(result.defaultedA).not.toBe(result.pinnedA);
  });

  test("the approval expiration is off by default and rejects zero", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const salt = new sdk.Word([5n, 6n, 7n, 8n]);
      const common = { feeConversionSalt: salt, boundBlockNum: 1 };

      const authArgFor = async (options) =>
        (
          await client.feeAwareTransactionRequestBuilder(
            multisigAccountId,
            options
          )
        )
          .build()
          .authArg()
          ?.toHex();

      let zeroError = null;
      try {
        await authArgFor({ ...common, approvalExpirationDelta: 0 });
      } catch (err) {
        zeroError = String(err?.message ?? err);
      }

      return {
        withoutExpiry: await authArgFor(common),
        withExpiry: await authArgFor({
          ...common,
          approvalExpirationDelta: 100,
        }),
        zeroError,
      };
    });

    // A delta is part of the signed preimage, so setting one must change the
    // commitment. Equal values would mean the option never reached the kernel.
    expect(result.withoutExpiry).toBeTruthy();
    expect(result.withExpiry).toBeTruthy();
    expect(result.withExpiry).not.toBe(result.withoutExpiry);
    // Zero is refused where the caller can see why, not silently read as "never".
    expect(result.zeroError).toContain("approvalExpirationDelta");
    // And the message is the one intended, with no whitespace artefact: this is
    // the guard for a literal that three reviewers read as malformed and that
    // really was, because the tooling that wrote it ate the line continuation.
    expect(result.zeroError).not.toMatch(/ {2,}/);
  });
});

test.describe("fee conversion salt", () => {
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

      // Since 0.17 the fee asset lives in the protocol configuration, not in the
      // header, so the client reports it rather than the block.
      const feeFaucetId = await client.feeFaucetId();

      return {
        baseFee: header.verificationBaseFee(),
        // Round-trip the id through the SDK's own parser rather than pattern
        // matching the string: a garbled or all-zero id would still look like
        // an account id to a regex.
        feeFaucetRoundTrips:
          sdk.AccountId.fromHex(feeFaucetId.toString()).toString() ===
          feeFaucetId.toString(),
        // Pinning the value to the faucet the client was configured with needs
        // an input the test chose, which the mock chain does not give it; that
        // assertion lives in miden_client_api.test.ts against a client created
        // with a known faucet.
      };
    });

    // `verification_base_fee` is a u32 on the wire, so it must survive as an
    // exact non-negative integer rather than an arbitrary JS number.
    expect(Number.isInteger(result.baseFee)).toBe(true);
    expect(result.baseFee).toBeGreaterThanOrEqual(0);
    expect(result.baseFee).toBeLessThanOrEqual(0xffffffff);
    expect(result.feeFaucetRoundTrips).toBe(true);
  });

  test("withFeeConversionSalt declares the salt and survives serialization", async ({
    run,
  }) => {
    // The salt is DECLARED, not committed: miden-client writes the commitment
    // into the auth args while preparing the transaction, so a freshly built
    // request reports the salt and no auth arg. Round-tripping through
    // serialization is the property the multisig transport flow depends on —
    // a proposal reaches its co-signers as bytes, and the salt their summary
    // was derived under has to survive the trip.
    const result = await run(async ({ sdk }) => {
      const salt = sdk.Word.newFromFelts([
        new sdk.Felt(11n),
        new sdk.Felt(22n),
        new sdk.Felt(33n),
        new sdk.Felt(44n),
      ]);

      const built = new sdk.TransactionRequestBuilder()
        .withFeeConversionSalt(salt)
        .build();

      const roundTripped = sdk.TransactionRequest.deserialize(
        built.serialize()
      );

      return {
        // Compared with `== null` so the napi path (which yields `null` for a
        // Rust `Option::None`) and the wasm-bindgen path (`undefined`) agree.
        declaredSalt: built.feeConversionSalt()?.toHex() ?? null,
        expectedSalt: salt.toHex(),
        // No commitment yet: the client writes it during preparation. A request
        // reporting one here would mean the binding committed too early, under a
        // salt the account may never agree to.
        hasAuthArg: built.authArg() != null,
        roundTrippedSalt: roundTripped.feeConversionSalt()?.toHex() ?? null,
      };
    });

    expect(result.declaredSalt).toBe(result.expectedSalt);
    expect(result.hasAuthArg).toBe(false);
    expect(result.roundTrippedSalt).toBe(result.expectedSalt);
  });

  test("withAuthArg and withFeeConversionSalt are mutually exclusive", async ({
    run,
  }) => {
    // miden-client keeps these two in the same slot and has each setter clear
    // the other, so the exclusion is enforced by construction and the last call
    // simply wins. This used to be an error case in this binding — a request
    // could declare conversion info and then have its commitment replaced,
    // leaving the preimage keyed by a word nothing looked up — and the guard
    // that caught it was deleted because the shape can no longer be built.
    // This test is what pins that claim.
    const result = await run(async ({ sdk }) => {
      const salt = sdk.Word.newFromFelts([
        new sdk.Felt(11n),
        new sdk.Felt(22n),
        new sdk.Felt(33n),
        new sdk.Felt(44n),
      ]);
      const authArg = sdk.Word.newFromFelts([
        new sdk.Felt(55n),
        new sdk.Felt(66n),
        new sdk.Felt(77n),
        new sdk.Felt(88n),
      ]);

      const saltLast = new sdk.TransactionRequestBuilder()
        .withAuthArg(authArg)
        .withFeeConversionSalt(salt)
        .build();

      const authArgLast = new sdk.TransactionRequestBuilder()
        .withFeeConversionSalt(salt)
        .withAuthArg(authArg)
        .build();

      return {
        saltLastSalt: saltLast.feeConversionSalt()?.toHex() ?? null,
        saltLastAuthArg: saltLast.authArg()?.toHex() ?? null,
        authArgLastSalt: authArgLast.feeConversionSalt()?.toHex() ?? null,
        authArgLastAuthArg: authArgLast.authArg()?.toHex() ?? null,
        expectedSalt: salt.toHex(),
        expectedAuthArg: authArg.toHex(),
      };
    });

    // Salt called last: it wins and the auth arg is cleared.
    expect(result.saltLastSalt).toBe(result.expectedSalt);
    expect(result.saltLastAuthArg).toBeNull();

    // Auth arg called last: it wins and the declaration is cleared.
    expect(result.authArgLastAuthArg).toBe(result.expectedAuthArg);
    expect(result.authArgLastSalt).toBeNull();
  });

  test("feeNote and userOutputNotes split the kernel's fee note off", async ({
    run,
  }) => {
    // STRUCTURAL, like the rest of this file: the mock chain builds blocks with
    // verification_base_fee = 0, so no fee note exists and `feeNote()` must be undefined.
    // What that DOES prove is the half that regressed in practice -- that the split never
    // drops a user note -- and it pins the invariant the wallet now depends on: index 0 of
    // `userOutputNotes()` is the author's note, whatever order the kernel used. The
    // fee-present case needs a charging chain and is covered wallet-side.
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const request = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Public,
        BigInt(7)
      );
      const executed = (
        await client.executeTransaction(faucet.id(), request)
      ).executedTransaction();

      const all = executed.outputNotes().notes();
      const user = executed.userOutputNotes();
      return {
        allIds: all.map((n) => n.id().toString()),
        userIds: user.map((n) => n.id().toString()),
        // Compared with `== null` so the napi (`null`) and wasm-bindgen (`undefined`)
        // bindings agree.
        hasFeeNote: executed.feeNote() != null,
      };
    });

    expect(result.hasFeeNote).toBe(false);
    // No fee note on this chain, so the split is the identity -- and critically it did not
    // swallow the mint's own output note, which is the failure a bad predicate produces.
    expect(result.userIds).toEqual(result.allIds);
    expect(result.userIds.length).toBeGreaterThan(0);
  });

  test("an untouched builder declares neither auth arg nor salt", async ({
    run,
  }) => {
    // Without an explicit call the builder must invent neither, or a caller
    // choosing its own (the multisig flow, where the salt is the replay guard)
    // would be silently overridden — and miden-client would stop committing the
    // native conversion info it commits precisely when both are absent.
    const result = await run(async ({ sdk }) => {
      const request = new sdk.TransactionRequestBuilder().build();
      return {
        hasAuthArg: request.authArg() != null,
        hasSalt: request.feeConversionSalt() != null,
      };
    });

    expect(result.hasAuthArg).toBe(false);
    expect(result.hasSalt).toBe(false);
  });

  test("convenience constructors leave the fee to miden-client on this account", async ({
    run,
  }) => {
    // The constructors declare nothing unless the executing account must choose
    // its own salt — the multisig flavours. `setupWalletAndFaucet` yields a
    // single-sig wallet, so the request must come back byte-identical to one
    // from a bare builder: no salt, and no auth arg. The mock chain's zero base
    // fee is not what makes that true; since 0.17 a multisig would carry auth
    // args here too. miden-client commits
    // the native conversion info itself under its fixed default salt, which is
    // exactly what a single-sig account wants and what keeps its signed summary
    // reproducible.
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const request = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );
      const anchor = await client.chainAnchorForRequest(request);

      return {
        baseFee: anchor.blockHeader().verificationBaseFee(),
        hasAuthArg: request.authArg() != null,
        hasSalt: request.feeConversionSalt() != null,
      };
    });

    // Pin the type before comparing. `verificationBaseFee` is a `u32`, so it
    // arrives as a number; were it ever `undefined`, `undefined > 0` is `false`
    // and the assertions below would pass for the wrong reason on every chain.
    expect(typeof result.baseFee).toBe("number");
    expect(result.baseFee).toBe(0);

    // A single-sig account never needs a declared salt, at any base fee.
    expect(result.hasSalt).toBe(false);
    expect(result.hasAuthArg).toBe(false);
  });
});
