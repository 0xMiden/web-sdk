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
      // A fresh Word per call, every call: the salt parameter is OWNED, so
      // wasm-bindgen moves the handle and a second call passes a consumed one,
      // which arrives as `None` and silently draws a salt instead. Reusing one
      // Word here made this very test measure nothing after its first call.
      const salt = () => new sdk.Word(sdk.u64Array([1, 2, 3, 4]));

      // `run` hands the callback the RAW client, not MidenClient, so this is the
      // positional export: (account, approvalExpirationDelta, feeConversionSalt,
      // boundBlockNum). MidenClient's options object fails loudly in napi here
      // and is silently coerced to Some(0) in wasm.
      const authArgAt = async (block) =>
        (
          await client.feeAwareTransactionRequestBuilder(
            multisigAccountId,
            undefined,
            salt(),
            block
          )
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
        pinnedA: await authArgAt(1),
        pinnedB: await authArgAt(1),
        otherBlock: await authArgAt(2),
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
    // And the bound block is really pinned, not merely passed: the equality
    // above would hold even if the override were ignored, because this closure
    // produces no blocks, so the default bound block is the same for both
    // builds. Varying it alone is what makes that impossible.
    expect(result.otherBlock).not.toBe(result.pinnedA);
  });

  // The bound block has to be in the transaction's partial blockchain, and
  // declaring it on the request is what lets the proposal execute at a later
  // tip. A plain account binds no block and gets no auth args, so its request
  // declares nothing a bare builder would not.
  test("the bound block is declared for a multisig and nothing for a plain account", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const { wallet } = await helpers.setupWalletAndFaucet();
      const salt = () => new sdk.Word(sdk.u64Array([9, 10, 11, 12]));

      const pinned = (
        await client.feeAwareTransactionRequestBuilder(
          multisigAccountId,
          undefined,
          salt(),
          1
        )
      ).build();
      const defaulted = (
        await client.feeAwareTransactionRequestBuilder(multisigAccountId)
      ).build();
      const syncHeight = await client.getSyncHeight();

      const plain = (
        await client.feeAwareTransactionRequestBuilder(wallet.id())
      ).build();

      return {
        pinned: Array.from(pinned.blockNumbers()),
        defaulted: Array.from(defaulted.blockNumbers()),
        syncHeight,
        plain: Array.from(plain.blockNumbers()),
        plainHasAuthArg: plain.authArg() != null,
        plainHasSalt: plain.feeConversionSalt() != null,
      };
    });

    expect(result.pinned).toEqual([1]);
    // The mock chain is past its genesis here, so the default cannot collide
    // with the pinned block and the two assertions test different paths.
    expect(result.syncHeight).toBeGreaterThan(1);
    expect(result.defaulted).toEqual([result.syncHeight]);
    expect(result.plain).toEqual([]);
    expect(result.plainHasAuthArg).toBe(false);
    expect(result.plainHasSalt).toBe(false);
  });

  test("the approval expiration is off by default and rejects zero", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      // Fresh per call, for the reason given in the previous test: reusing one
      // made `withExpiry !== withoutExpiry` pass because the salts differed,
      // not because the delta reached the preimage.
      const salt = () => new sdk.Word(sdk.u64Array([5, 6, 7, 8]));
      const authArgFor = async (delta) =>
        (
          await client.feeAwareTransactionRequestBuilder(
            multisigAccountId,
            delta,
            salt(),
            1
          )
        )
          .build()
          .authArg()
          ?.toHex();

      let zeroError = null;
      try {
        await authArgFor(0);
      } catch (err) {
        zeroError = String(err?.message ?? err);
      }

      return {
        withoutExpiry: await authArgFor(undefined),
        withExpiry: await authArgFor(100),
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
    // The message is assembled from string literals concatenated across source
    // lines. A stray run of spaces at a join would survive silently into what
    // the caller sees, so assert there is none.
    expect(result.zeroError).not.toMatch(/ {2,}/);
  });
});

test.describe("auth args on a finished request", () => {
  // A wallet receives a finished request from a dApp and must set the
  // multisig auth args on it without a rebuild. `withAuthArgs` is the generic
  // setter and `withFeeAwareAuth` builds the multisig args on top of it. These
  // run against the mock chain.

  test("withAuthArgs commits the preimage and keeps every other field", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();

      // The fee-aware builder gives a real multisig preimage and the
      // commitment that miden-client computes for it.
      const reference = (
        await client.feeAwareTransactionRequestBuilder(
          multisigAccountId,
          undefined,
          new sdk.Word(sdk.u64Array([1, 2, 3, 4])),
          1
        )
      ).build();
      const commitment = reference.authArg();
      const preimage = reference.adviceMap().get(commitment);

      const salt = new sdk.Word(sdk.u64Array([7, 7, 7, 7]));
      const original = sdk.TransactionRequest.deserialize(
        new sdk.TransactionRequestBuilder()
          .withBlockNumbers([3])
          .withFeeConversionSalt(salt)
          .build()
          .serialize()
      );
      // `withAuthArgs` takes the Felts by value, so the browser build consumes
      // them. Read every value compared below before the call.
      const expected = {
        expectedAuthArg: commitment.toHex(),
        expectedPreimage: preimage.map((felt) => felt.asInt().toString()),
        expectedSalt: salt.toHex(),
      };
      const withArgs = original.withAuthArgs(preimage);
      const restored = sdk.TransactionRequest.deserialize(withArgs.serialize());

      return {
        ...expected,
        authArg: withArgs.authArg()?.toHex() ?? null,
        storedPreimage: (
          withArgs.adviceMap().get(withArgs.authArg()) ?? []
        ).map((felt) => felt.asInt().toString()),
        salt: withArgs.feeConversionSalt()?.toHex() ?? null,
        blockNumbers: Array.from(withArgs.blockNumbers()),
        originalAuthArg: original.authArg()?.toHex() ?? null,
        originalSalt: original.feeConversionSalt()?.toHex() ?? null,
        restoredAuthArg: restored.authArg()?.toHex() ?? null,
      };
    });

    // The commitment is the one miden-client computes for the same preimage.
    expect(result.authArg).toBe(result.expectedAuthArg);
    expect(result.storedPreimage).toEqual(result.expectedPreimage);
    // The auth args replace the declared salt, and nothing else changes.
    expect(result.salt).toBeNull();
    expect(result.blockNumbers).toEqual([3]);
    // The request that was passed in stays the same.
    expect(result.originalAuthArg).toBeNull();
    expect(result.originalSalt).toBe(result.expectedSalt);
    expect(result.restoredAuthArg).toBe(result.expectedAuthArg);
  });

  test("withFeeAwareAuth sets the builder's auth args on a multisig request", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const { wallet } = await helpers.setupWalletAndFaucet();
      // A fresh Word per call: the salt parameter is owned and moved across
      // the WASM boundary.
      const salt = () => new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const declaredSalt = () => new sdk.Word(sdk.u64Array([9, 9, 9, 9]));
      const builderAuthArg = async (saltWord) =>
        (
          await client.feeAwareTransactionRequestBuilder(
            multisigAccountId,
            undefined,
            saltWord,
            1
          )
        )
          .build()
          .authArg()
          .toHex();

      // The dApp's request, received as bytes.
      const dappRequest = () =>
        sdk.TransactionRequest.deserialize(
          new sdk.TransactionRequestBuilder()
            .withBlockNumbers([2])
            .build()
            .serialize()
        );
      const dappRequestWithSalt = () =>
        sdk.TransactionRequest.deserialize(
          new sdk.TransactionRequestBuilder()
            .withFeeConversionSalt(declaredSalt())
            .build()
            .serialize()
        );

      // `run` gives the raw client, so the options are positional:
      // (request, account, approvalExpirationDelta, feeConversionSalt,
      // boundBlockNum).
      const pinned = await client.withFeeAwareAuth(
        dappRequest(),
        multisigAccountId,
        undefined,
        salt(),
        1
      );
      const fromDeclaredSalt = await client.withFeeAwareAuth(
        dappRequestWithSalt(),
        multisigAccountId,
        undefined,
        undefined,
        1
      );
      const plain = await client.withFeeAwareAuth(
        dappRequestWithSalt(),
        wallet.id()
      );

      return {
        pinnedAuthArg: pinned.authArg()?.toHex() ?? null,
        pinnedExpected: await builderAuthArg(salt()),
        pinnedSalt: pinned.feeConversionSalt()?.toHex() ?? null,
        pinnedBlockNumbers: Array.from(pinned.blockNumbers()),
        declaredAuthArg: fromDeclaredSalt.authArg()?.toHex() ?? null,
        declaredExpected: await builderAuthArg(declaredSalt()),
        plainAuthArg: plain.authArg()?.toHex() ?? null,
        plainSalt: plain.feeConversionSalt()?.toHex() ?? null,
        expectedDeclaredSalt: declaredSalt().toHex(),
      };
    });

    // The same salt and bound block give the same auth arg as the builder.
    expect(result.pinnedAuthArg).toBeTruthy();
    expect(result.pinnedAuthArg).toBe(result.pinnedExpected);
    expect(result.pinnedSalt).toBeNull();
    // The bound block is not declared. miden-client adds it at execution.
    expect(result.pinnedBlockNumbers).toEqual([2]);
    // Without a salt option, the salt that the request declares is used.
    expect(result.declaredAuthArg).toBe(result.declaredExpected);
    // A plain account gets the request back unchanged.
    expect(result.plainAuthArg).toBeNull();
    expect(result.plainSalt).toBe(result.expectedDeclaredSalt);
  });

  test("withFeeAwareAuth refuses a request that already has an auth arg", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const request = new sdk.TransactionRequestBuilder()
        .withAuthArg(new sdk.Word(sdk.u64Array([5, 6, 7, 8])))
        .build();
      try {
        await client.withFeeAwareAuth(request, multisigAccountId);
        return { threw: false };
      } catch (error) {
        return {
          threw: true,
          code: error.code ?? null,
          message: String(error.message ?? error),
        };
      }
    });

    expect(result.threw).toBe(true);
    // The WASM build attaches the code; the Node binding prefixes the message.
    expect(
      result.code === "AUTH_ALREADY_SET" ||
        result.message.startsWith("AUTH_ALREADY_SET")
    ).toBe(true);
    expect(result.message).not.toMatch(/ {2,}/);
  });

  test("withFeeAwareAuth takes approvalExpirationDelta and refuses zero like the builder", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      // A fresh Word per call: the salt parameter is owned and moved across
      // the WASM boundary.
      const salt = () => new sdk.Word(sdk.u64Array([5, 6, 7, 8]));
      const dappRequest = () =>
        sdk.TransactionRequest.deserialize(
          new sdk.TransactionRequestBuilder().build().serialize()
        );
      // Positional, as above, with the salt and the bound block pinned.
      const finishedAuthArg = async (delta) =>
        (
          await client.withFeeAwareAuth(
            dappRequest(),
            multisigAccountId,
            delta,
            salt(),
            1
          )
        )
          .authArg()
          ?.toHex();
      const builderAuthArg = async (delta) =>
        (
          await client.feeAwareTransactionRequestBuilder(
            multisigAccountId,
            delta,
            salt(),
            1
          )
        )
          .build()
          .authArg()
          ?.toHex();
      const errorOf = async (call) => {
        try {
          await call();
          return null;
        } catch (err) {
          return String(err?.message ?? err);
        }
      };

      return {
        withExpiry: await finishedAuthArg(100),
        withExpiryExpected: await builderAuthArg(100),
        withoutExpiry: await finishedAuthArg(undefined),
        zeroError: await errorOf(() => finishedAuthArg(0)),
        builderZeroError: await errorOf(() => builderAuthArg(0)),
      };
    });

    // The delta reaches the auth args: the builder's auth arg for the same
    // delta, salt and bound block, and not the one without a delta.
    expect(result.withExpiry).toBeTruthy();
    expect(result.withExpiry).toBe(result.withExpiryExpected);
    expect(result.withoutExpiry).toBeTruthy();
    expect(result.withExpiry).not.toBe(result.withoutExpiry);
    // Zero is refused with the builder's error, not read as "never".
    expect(result.zeroError).toContain("approvalExpirationDelta");
    expect(result.zeroError).toBe(result.builderZeroError);
  });

  test("a refused withFeeAwareAuth draws nothing from the client RNG", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      // Two clients with the same seed draw the same salts, so a draw that
      // only one of them makes shows as a difference in the next salt. Mock
      // clients in one browser page share a store, so each client gets its
      // own multisig.
      const addMultisig = async (midenClient) => {
        const seed = new Uint8Array(32);
        crypto.getRandomValues(seed);
        const approvers = [
          sdk.AuthSecretKey.rpoFalconWithRNG(),
          sdk.AuthSecretKey.rpoFalconWithRNG(),
        ];
        const multisigComponent = sdk.createAuthFalcon512RpoMultisig(
          new sdk.AuthFalcon512RpoMultisigConfig(
            approvers.map((key) => key.publicKey().toCommitment()),
            2
          )
        );
        const { account } = new sdk.AccountBuilder(seed)
          .storageMode(sdk.AccountStorageMode.private())
          .withAuthComponent(multisigComponent)
          .withBasicWalletComponent()
          .build();
        const accountId = account.id();
        await midenClient.accounts.insert({ account });
        return accountId;
      };
      // With the bound block pinned, the auth arg differs only by the salt
      // the builder draws for it.
      const nextAuthArg = async (midenClient, multisig) =>
        (
          await midenClient.feeAwareTransactionRequestBuilder(multisig, {
            boundBlockNum: 1,
          })
        )
          .build()
          .authArg()
          .toHex();

      const refusing = await helpers.createMidenMockClient({
        seed: "withFeeAwareAuth refusal",
      });
      const control = await helpers.createMidenMockClient({
        seed: "withFeeAwareAuth refusal",
      });
      const refusingMultisig = await addMultisig(refusing);
      const controlMultisig = await addMultisig(control);

      // An auth arg and no salt option: building the auth args before the
      // refusal would draw a salt.
      const request = new sdk.TransactionRequestBuilder()
        .withAuthArg(new sdk.Word(sdk.u64Array([5, 6, 7, 8])))
        .build();
      let refusal = null;
      try {
        await refusing.withFeeAwareAuth(request, refusingMultisig);
      } catch (error) {
        refusal = {
          code: error.code ?? null,
          message: String(error.message ?? error),
        };
      }

      return {
        refusal,
        afterRefusal: await nextAuthArg(refusing, refusingMultisig),
        control: await nextAuthArg(control, controlMultisig),
        controlNext: await nextAuthArg(control, controlMultisig),
      };
    });

    expect(
      result.refusal?.code === "AUTH_ALREADY_SET" ||
        result.refusal?.message.startsWith("AUTH_ALREADY_SET")
    ).toBe(true);
    // Each build draws a fresh salt, so equal auth args are the same draw.
    expect(result.controlNext).not.toBe(result.control);
    expect(result.afterRefusal).toBe(result.control);
  });

  test("a multisig executes a dApp request without a salt after withFeeAwareAuth", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const dappRequest = sdk.TransactionRequest.deserialize(
        new sdk.TransactionRequestBuilder().build().serialize()
      );

      // Without auth args or a salt, miden-client refuses a multisig request.
      let bareError = null;
      try {
        await client.executeForSummary(multisigAccountId, dappRequest);
      } catch (err) {
        bareError = String(err?.message ?? err);
      }

      const request = await client.withFeeAwareAuth(
        dappRequest,
        multisigAccountId
      );
      const original = await client.executeForSummary(
        multisigAccountId,
        request
      );

      // At a later tip the request declares no bound block, so this works
      // only because miden-client tracks the bound block of the auth args.
      await client.proveBlock();
      await client.proveBlock();
      await client.syncState();
      const atTip = await client.executeForSummary(multisigAccountId, request);

      return {
        bareError,
        declared: Array.from(request.blockNumbers()),
        original: original.toCommitment().toHex(),
        atTip: atTip.toCommitment().toHex(),
      };
    });

    expect(result.bareError).toContain("reuses the fee conversion salt");
    expect(result.declared).toEqual([]);
    expect(result.atTip).toBe(result.original);
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
