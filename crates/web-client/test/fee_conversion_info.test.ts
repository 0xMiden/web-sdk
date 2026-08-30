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
        // `get` is documented to return the stored VALUE, so assert the felts
        // themselves: `load_conversion_info` reads the preimage as
        // [SALT, CONVERSION_INFO], eight felts opening with the salt. Checking
        // presence alone would pass against a binding returning any non-empty
        // sequence for every key.
        preimage:
          authArg == null
            ? null
            : (built
                .adviceMap()
                .get(authArg)
                ?.map((felt) => felt.asInt().toString()) ?? null),
        saltFelts: salt.toFelts().map((felt) => felt.asInt().toString()),
      };
    });

    expect(result.faucetRoundTrips).toBe(true);
    expect(result.hasAuthArg).toBe(true);
    expect(result.authArgIsSalt).toBe(false);
    expect(result.preimageIsKeyedByCommitment).toBe(true);
    expect(result.unrelatedKeyMisses).toBe(true);
    expect(result.preimage).toHaveLength(8);
    expect(result.preimage?.slice(0, 4)).toEqual(result.saltFelts);
    // The conversion-info half must not be all zeros — that is what an empty
    // or defaulted preimage would look like.
    expect(result.preimage?.slice(4)).not.toEqual(["0", "0", "0", "0"]);
  });

  test("building a request whose fee commitment was overwritten is refused", async ({
    run,
  }) => {
    // `withAuthArg` and `withFeeConversionInfo` write the same slot, so calling
    // the former second leaves the preimage keyed by the discarded commitment
    // and `fee::pay_fee` would abort deep in the VM. It cannot be caught later:
    // the native builder clears its own fee-conversion declaration when the
    // auth arg is replaced, so a request built that way arrives at the client
    // declaring nothing and looking ordinary. `build()` is the last point at
    // which the mistake is still visible, and it is refused there. Runs on the
    // zero-fee mock chain because a manual `withFeeConversionInfo` sets the
    // declaration regardless of the chain's base fee.
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const probe = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );
      const feeFaucetId = (await client.chainAnchorForRequest(probe))
        .blockHeader()
        .feeFaucetId();

      const info = sdk.FeeConversionInfo.oneToOne(feeFaucetId);
      const salt = sdk.Word.newFromFelts([
        new sdk.Felt(11n),
        new sdk.Felt(22n),
        new sdk.Felt(33n),
        new sdk.Felt(44n),
      ]);
      const collidingArg = sdk.Word.newFromFelts([
        new sdk.Felt(99n),
        new sdk.Felt(98n),
        new sdk.Felt(97n),
        new sdk.Felt(96n),
      ]);

      let message = "";
      let code: string | undefined;
      let threw = false;
      try {
        new sdk.TransactionRequestBuilder()
          .withFeeConversionInfo(info, salt)
          .withAuthArg(collidingArg)
          .build();
      } catch (err) {
        threw = true;
        message = String((err as Error)?.message ?? err);
        code = (err as { code?: string })?.code;
      }

      // The reverse order is legitimate and must keep working:
      // `withFeeConversionInfo` writes the commitment and its preimage
      // together, so calling it last wins outright.
      const reversed = new sdk.TransactionRequestBuilder()
        .withAuthArg(collidingArg)
        .withFeeConversionInfo(info, salt)
        .build();
      const reversedAuthArg = reversed.authArg();

      return {
        threw,
        message,
        code,
        reversedCommitsConversionInfo:
          reversedAuthArg != null &&
          reversedAuthArg.toHex() !== collidingArg.toHex() &&
          reversed.adviceMap().get(reversedAuthArg) != null,
      };
    });

    expect(result.threw).toBe(true);
    // The code is a `code` property on the browser binding and a message prefix
    // on Node, since napi reserves `code` for its own Status enum.
    expect(
      result.code === "FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN" ||
        result.message.startsWith("FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN")
    ).toBe(true);
    expect(result.reversedCommitsConversionInfo).toBe(true);
  });

  test("executing a built request whose fee commitment was replaced is refused", async ({
    run,
  }) => {
    // `TransactionRequest.withAuthArg` attaches a word to an already-built
    // request WITHOUT touching its fee-conversion declaration — that is the
    // point of it, since it exists for callers who computed a commitment
    // themselves and must not be classified. Used on a request that already
    // committed conversion info, it replaces the commitment and leaves the
    // preimage keyed by the old word. That combination survives to the client,
    // which refuses it before execution rather than letting `pay_fee` abort.
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const probe = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );
      const feeFaucetId = (await client.chainAnchorForRequest(probe))
        .blockHeader()
        .feeFaucetId();

      const info = sdk.FeeConversionInfo.oneToOne(feeFaucetId);
      const salt = sdk.Word.newFromFelts([
        new sdk.Felt(11n),
        new sdk.Felt(22n),
        new sdk.Felt(33n),
        new sdk.Felt(44n),
      ]);
      const collidingArg = sdk.Word.newFromFelts([
        new sdk.Felt(99n),
        new sdk.Felt(98n),
        new sdk.Felt(97n),
        new sdk.Felt(96n),
      ]);

      const request = new sdk.TransactionRequestBuilder()
        .withFeeConversionInfo(info, salt)
        .build()
        .withAuthArg(collidingArg);

      // The overwrite is observable on the request itself: the auth arg is now
      // the colliding word, and nothing in the advice map is keyed by it.
      const authArg = request.authArg();

      let message = "";
      let code: string | undefined;
      let threw = false;
      try {
        await client.executeTransaction(wallet.id(), request);
      } catch (err) {
        threw = true;
        message = String((err as Error)?.message ?? err);
        code = (err as { code?: string })?.code;
      }

      return {
        threw,
        authArgIsCollidingWord:
          authArg != null && authArg.toHex() === collidingArg.toHex(),
        preimageMissesNewArg:
          authArg != null && request.adviceMap().get(authArg) == null,
        message,
        code,
      };
    });

    expect(result.authArgIsCollidingWord).toBe(true);
    expect(result.preimageMissesNewArg).toBe(true);
    expect(result.threw).toBe(true);
    expect(
      result.code === "FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN" ||
        result.message.startsWith("FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN")
    ).toBe(true);
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
