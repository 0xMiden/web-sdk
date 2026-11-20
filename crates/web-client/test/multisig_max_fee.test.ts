// @ts-nocheck
import { test, expect } from "./test-setup";

// MULTISIG MAX FEE TESTS
// =======================================================================================================
//
// The summary of a multisig binds a max fee. The mock chain charges no fee, so
// these tests cover what the SDK does with a max fee: where it puts the value,
// and which summary the request then reproduces. The fee payment under a max
// fee is covered by the tests of miden-client, on a chain that charges a fee.

test.describe("multisig max fee", () => {
  // The max fee is one of the values that the summary binds, like the salt
  // and the bound block. A summary with a max fee does not depend on the fee
  // that one execution estimates.
  test("a request with a max fee binds it and reproduces its summary at a later tip", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const boundBlock = await client.getSyncHeight();
      // The builder consumes the salt, so each call gets a fresh one.
      const salt = () => new sdk.Word(sdk.u64Array([21, 22, 23, 24]));
      const build = async (maxFee) =>
        (
          await client.feeAwareTransactionRequestBuilder(
            multisigAccountId,
            undefined,
            salt(),
            boundBlock,
            maxFee
          )
        ).build();

      const capped = await build(sdk.u64(5000));
      const uncapped = await build(undefined);
      const zero = await build(sdk.u64(0));
      const original = await client.executeForSummary(
        multisigAccountId,
        capped
      );
      const estimated = await client.executeForSummary(
        multisigAccountId,
        uncapped
      );

      // A finished request gets the same auth args.
      const copy = await client.withFeeAwareAuth(
        new sdk.TransactionRequestBuilder().build(),
        multisigAccountId,
        undefined,
        salt(),
        boundBlock,
        sdk.u64(5000)
      );

      await client.proveBlock();
      await client.proveBlock();
      await client.syncState();
      const atTip = await client.executeForSummary(multisigAccountId, capped);

      return {
        boundMaxFee: original.userParams()[1].asInt().toString(),
        estimatedMaxFee: estimated.userParams()[1].asInt().toString(),
        original: original.toCommitment().toHex(),
        estimated: estimated.toCommitment().toHex(),
        atTip: atTip.toCommitment().toHex(),
        authArg: capped.authArg().toHex(),
        uncappedAuthArg: uncapped.authArg().toHex(),
        zeroAuthArg: zero.authArg().toHex(),
        copyAuthArg: copy.authArg().toHex(),
      };
    });

    expect(result.boundMaxFee).toBe("5000");
    expect(result.atTip).toBe(result.original);
    // Without a max fee the summary binds the estimate, which is zero on a
    // chain that charges nothing. A max fee of zero is the same as none.
    expect(result.estimatedMaxFee).toBe("0");
    expect(result.estimated).not.toBe(result.original);
    expect(result.authArg).not.toBe(result.uncappedAuthArg);
    expect(result.zeroAuthArg).toBe(result.uncappedAuthArg);
    expect(result.copyAuthArg).toBe(result.authArg);
  });

  // The estimate is zero on the mock chain, and zero scaled by any margin is
  // still zero. The summary here therefore starts from a max fee that is not
  // zero, so the scaling shows.
  test("withEstimatedMaxFee scales the max fee of a summary and returns the summary to sign", async ({
    run,
  }, testInfo) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const build = async (maxFee, salt) =>
        (
          await client.feeAwareTransactionRequestBuilder(
            multisigAccountId,
            7,
            salt,
            undefined,
            maxFee
          )
        ).build();
      const refusal = (fn) => {
        try {
          fn();
          return null;
        } catch (error) {
          return {
            code: error?.code ?? null,
            message: error?.message ?? String(error),
          };
        }
      };

      const draft = await build(sdk.u64(1001));
      const previewed = await client.executeForSummary(
        multisigAccountId,
        draft
      );
      const capped = draft.withEstimatedMaxFee(previewed, 150);
      const cappedRequest = capped.request();
      const cappedSummary = capped.summary();
      // The returned request reproduces the returned summary, also at a later
      // tip.
      await client.proveBlock();
      await client.syncState();
      const executed = await client.executeForSummary(
        multisigAccountId,
        cappedRequest
      );
      // A preview of the draft at the later tip is still its summary, so the
      // helper takes it and gives the same result.
      const previewedAtTip = await client.executeForSummary(
        multisigAccountId,
        draft
      );
      const cappedAtTip = draft.withEstimatedMaxFee(previewedAtTip, 150);

      // A summary that binds no max fee yields no cap.
      const uncapped = await build(undefined);
      const estimated = await client.executeForSummary(
        multisigAccountId,
        uncapped
      );
      const unchanged = uncapped.withEstimatedMaxFee(estimated, 150);

      const otherSalt = await build(
        sdk.u64(1001),
        new sdk.Word(sdk.u64Array([31, 32, 33, 34]))
      );

      return {
        maxFee: capped.maxFee().toString(),
        boundMaxFee: cappedSummary.userParams()[1].asInt().toString(),
        previewed: previewed.toCommitment().toHex(),
        cappedSummary: cappedSummary.toCommitment().toHex(),
        executed: executed.toCommitment().toHex(),
        previewedAtTip: previewedAtTip.toCommitment().toHex(),
        maxFeeAtTip: cappedAtTip.maxFee().toString(),
        cappedSummaryAtTip: cappedAtTip.summary().toCommitment().toHex(),
        cappedAuthArgAtTip: cappedAtTip.request().authArg().toHex(),
        // Only the auth args of the request change.
        draftBlocks: Array.from(draft.blockNumbers()),
        cappedBlocks: Array.from(cappedRequest.blockNumbers()),
        draftAuthArg: draft.authArg().toHex(),
        cappedAuthArg: cappedRequest.authArg().toHex(),
        // The draft and the summary are still usable after the call.
        draftAuthArgAfter: draft.authArg().toHex(),
        previewedAfter: previewed.toCommitment().toHex(),
        unchangedMaxFee: unchanged.maxFee().toString(),
        unchangedAuthArg: unchanged.request().authArg().toHex(),
        uncappedAuthArg: uncapped.authArg().toHex(),
        unchangedSummary: unchanged.summary().toCommitment().toHex(),
        estimated: estimated.toCommitment().toHex(),
        zeroMargin: refusal(() => draft.withEstimatedMaxFee(previewed, 0)),
        noAuthArgs: refusal(() =>
          new sdk.TransactionRequestBuilder()
            .build()
            .withEstimatedMaxFee(previewed, 150)
        ),
        otherRequest: refusal(() =>
          otherSalt.withEstimatedMaxFee(previewed, 150)
        ),
      };
    });

    // 1001 * 150 / 100, rounded up.
    expect(result.maxFee).toBe("1502");
    expect(result.boundMaxFee).toBe("1502");
    expect(result.cappedSummary).not.toBe(result.previewed);
    expect(result.executed).toBe(result.cappedSummary);
    expect(result.previewedAtTip).toBe(result.previewed);
    expect(result.maxFeeAtTip).toBe("1502");
    expect(result.cappedSummaryAtTip).toBe(result.cappedSummary);
    expect(result.cappedAuthArgAtTip).toBe(result.cappedAuthArg);
    expect(result.cappedBlocks).toEqual(result.draftBlocks);
    expect(result.cappedAuthArg).not.toBe(result.draftAuthArg);
    expect(result.draftAuthArgAfter).toBe(result.draftAuthArg);
    expect(result.previewedAfter).toBe(result.previewed);

    expect(result.unchangedMaxFee).toBe("0");
    expect(result.unchangedAuthArg).toBe(result.uncappedAuthArg);
    expect(result.unchangedSummary).toBe(result.estimated);

    expect(result.zeroMargin.message).toContain(
      "the fee margin percent must be non-zero"
    );
    expect(result.otherRequest.message).toContain(
      "the summary does not belong to the request"
    );
    // The browser sets the code as a property. The Node.js binding puts it in
    // front of the message.
    expect(result.noAuthArgs.message).toContain(
      "the request has no multisig auth args"
    );
    if (testInfo.project.name === "nodejs") {
      expect(result.noAuthArgs.message).toMatch(/^AUTH_ARGS_NOT_MULTISIG: /);
    } else {
      expect(result.noAuthArgs.code).toBe("AUTH_ARGS_NOT_MULTISIG");
    }
  });

  // Two of three approvers sign the summary, and the executor adds the
  // signatures to the advice map of the request.
  test("a signed multisig request executes without a max fee, with one, and with a scaled one", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const approverKeys = [
        sdk.AuthSecretKey.rpoFalconWithRNG(),
        sdk.AuthSecretKey.rpoFalconWithRNG(),
        sdk.AuthSecretKey.rpoFalconWithRNG(),
      ];

      const executeSigned = async (seedByte, maxFee, feeMarginPercent) => {
        const component = sdk.createAuthFalcon512RpoMultisig(
          new sdk.AuthFalcon512RpoMultisigConfig(
            approverKeys.map((key) => key.publicKey().toCommitment()),
            2
          )
        );
        const seed = new Uint8Array(32);
        seed.fill(seedByte);
        const built = new sdk.AccountBuilder(seed)
          .storageMode(sdk.AccountStorageMode.private())
          .withAuthComponent(component)
          .withBasicWalletComponent()
          .build();
        const accountId = built.account.id();
        await client.newAccount(built.account, false);

        let request = (
          await client.feeAwareTransactionRequestBuilder(
            accountId,
            undefined,
            undefined,
            undefined,
            maxFee
          )
        ).build();
        let summary = await client.executeForSummary(accountId, request);
        if (feeMarginPercent !== undefined) {
          // The approvers sign the summary that the helper returns. No
          // execution has produced it.
          const capped = request.withEstimatedMaxFee(summary, feeMarginPercent);
          request = capped.request();
          summary = capped.summary();
        }

        const adviceMap = new sdk.AdviceMap();
        for (const key of approverKeys.slice(0, 2)) {
          const message = summary.toCommitment();
          const bound = new sdk.BoundSignature(
            key.publicKey().toCommitment(),
            message,
            key.sign(message)
          );
          adviceMap.insert(
            bound.toAdviceMapKey(),
            new sdk.FeltArray(bound.toEncodedSignature())
          );
        }
        const signed = request.extendAdviceMap(adviceMap);

        const executed = (
          await client.executeTransaction(accountId, signed)
        ).executedTransaction();

        return {
          boundMaxFee: summary.userParams()[1].asInt().toString(),
          finalNonce: executed.finalAccountHeader().nonce().asInt().toString(),
          outputNotes: executed.outputNotes().numNotes(),
        };
      };

      return {
        withoutMaxFee: await executeSigned(0x61, undefined),
        withMaxFee: await executeSigned(0x62, sdk.u64(5000)),
        withScaledMaxFee: await executeSigned(0x63, sdk.u64(1001), 150),
      };
    });

    expect(result.withoutMaxFee).toEqual({
      boundMaxFee: "0",
      finalNonce: "1",
      outputNotes: 0,
    });
    // The chain charges nothing, so the transaction pays no fee under the cap.
    expect(result.withMaxFee).toEqual({
      boundMaxFee: "5000",
      finalNonce: "1",
      outputNotes: 0,
    });
    // The signatures are over the summary from `withEstimatedMaxFee`, so the
    // signed execution of the returned request built the same summary.
    expect(result.withScaledMaxFee).toEqual({
      boundMaxFee: "1502",
      finalNonce: "1",
      outputNotes: 0,
    });
  });
});
