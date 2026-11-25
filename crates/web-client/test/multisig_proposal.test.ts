// @ts-nocheck
import { test, expect } from "./test-setup";

// MULTISIG PROPOSAL TESTS
// =======================================================================================================

test.describe("multisig proposal", () => {
  // The fee-aware builder declares the bound block of a multisig proposal
  // through these block numbers.
  test("declared block numbers round-trip through the builder and serialization", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const request = new sdk.TransactionRequestBuilder()
        .withBlockNumbers([5, 1])
        .withBlockNumbers([5, 3])
        .build();
      const restored = sdk.TransactionRequest.deserialize(request.serialize());
      const bare = new sdk.TransactionRequestBuilder().build();

      return {
        declared: Array.from(request.blockNumbers()),
        restored: Array.from(restored.blockNumbers()),
        bare: Array.from(bare.blockNumbers()),
        plainArrays: [request, restored, bare].map((r) =>
          Array.isArray(r.blockNumbers())
        ),
      };
    });

    // Repeated calls accumulate, duplicates collapse, and the set is ordered.
    expect(result.declared).toEqual([1, 3, 5]);
    expect(result.restored).toEqual([1, 3, 5]);
    expect(result.bare).toEqual([]);
    // The getter is split per platform so both bindings return number[];
    // wasm-bindgen would otherwise hand the browser a Uint32Array.
    expect(result.plainArrays).toEqual([true, true, true]);
  });

  // A multisig proposal binds its summary to the block its auth args name, and
  // the fee-aware builder declares that block on the request. Re-executing at
  // a later tip must reproduce the summary the approvers signed.
  test("a multisig proposal reproduces its summary at a later tip", async ({
    run,
  }) => {
    const result = await run(async ({ client, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();

      const request = (
        await client.feeAwareTransactionRequestBuilder(multisigAccountId)
      ).build();
      const boundBlock = await client.getSyncHeight();
      const original = await client.executeForSummary(
        multisigAccountId,
        request
      );

      await client.proveBlock();
      await client.proveBlock();
      await client.syncState();
      const tip = await client.getSyncHeight();

      const atTip = await client.executeForSummary(multisigAccountId, request);

      return {
        boundBlock,
        declared: Array.from(request.blockNumbers()),
        tip,
        original: original.toCommitment().toHex(),
        atTip: atTip.toCommitment().toHex(),
        summaryBlockAtTip: atTip.blockNum(),
      };
    });

    expect(result.declared).toEqual([result.boundBlock]);
    expect(result.tip).toBeGreaterThan(result.boundBlock);
    expect(result.atTip).toBe(result.original);
    // The summary names the bound block, not the block the execution ran at.
    expect(result.summaryBlockAtTip).toBe(result.boundBlock);
  });

  // The node-backed counterpart of the test above, and the regression for
  // web-sdk#432. A node serves account state only ~50 blocks back, so a
  // proposal re-executed at its bound block stopped working once the chain
  // moved past that window. Executing at the tip fetches the bound block's
  // header and MMR path from the node instead, which it keeps. Needs a running
  // node (CI's test node, or `TEST_MIDEN_RPC_URL`) and skips without one. The
  // unfunded multisig relies on the fee-free chain CI starts
  // (`MIDEN_VERIFICATION_BASE_FEE=0`); the fee-charging path is covered by
  // rust-sdk's `multisig_proposal_reexecutes_after_bound_account_state_is_pruned`.
  test("a multisig proposal reproduces its summary on a node after the bound block leaves the history window", async ({
    run,
  }) => {
    // ~51 blocks at the test node's 3 s interval, plus setup.
    test.setTimeout(480_000);
    const result = await run(async ({ sdk, helpers }) => {
      const integration = await helpers.createIntegrationClient();
      if (!integration) return { skip: true };
      const { client } = integration;
      await client.syncState();

      const walletSeed = new Uint8Array(32);
      crypto.getRandomValues(walletSeed);
      const approverKeys = [
        sdk.AuthSecretKey.rpoFalconWithRNG(),
        sdk.AuthSecretKey.rpoFalconWithRNG(),
      ];
      const multisigComponent = sdk.createAuthFalcon512RpoMultisig(
        new sdk.AuthFalcon512RpoMultisigConfig(
          approverKeys.map((key) => key.publicKey().toCommitment()),
          2
        )
      );
      const built = new sdk.AccountBuilder(walletSeed)
        .storageMode(sdk.AccountStorageMode.private())
        .withAuthComponent(multisigComponent)
        .withBasicWalletComponent()
        .build();
      const multisigId = built.account.id();
      await client.newAccount(built.account, false);
      for (const key of approverKeys) {
        await client.keystore.insert(multisigId, key);
      }

      const request = (
        await client.feeAwareTransactionRequestBuilder(multisigId)
      ).build();
      const boundBlock = await client.getSyncHeight();
      const original = await client.executeForSummary(multisigId, request);

      // One block past the node's 50-block account history.
      const target = boundBlock + 51;
      const deadline = Date.now() + 360_000;
      let tip = boundBlock;
      while (tip < target) {
        if (Date.now() > deadline) {
          throw new Error(`chain stalled at ${tip}, waiting for ${target}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await client.syncState();
        tip = await client.getSyncHeight();
      }

      const atTip = await client.executeForSummary(multisigId, request);

      return {
        skip: false,
        boundBlock,
        tip,
        original: original.toCommitment().toHex(),
        atTip: atTip.toCommitment().toHex(),
      };
    });
    if (result.skip) {
      test.skip(true, "requires running node");
      return;
    }

    expect(result.tip).toBeGreaterThan(result.boundBlock + 50);
    expect(result.atTip).toBe(result.original);
  });

  // A proposal's bound block has to be at or below the executing client's
  // sync height, so a co-signer that has not synced that far cannot preview
  // it yet. The docs quote this error; pin it, and pin that syncing clears it.
  test("a multisig proposal fails at the tip until the client syncs to its bound block", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId } =
        await helpers.setupMultisigWithConsumableNote();
      const syncHeight = await client.getSyncHeight();

      const request = (
        await client.feeAwareTransactionRequestBuilder(
          multisigAccountId,
          undefined,
          new sdk.Word(sdk.u64Array([5, 6, 7, 8])),
          syncHeight + 1
        )
      ).build();

      let earlyError = null;
      try {
        await client.executeForSummary(multisigAccountId, request);
      } catch (err) {
        earlyError = String(err?.message ?? err);
      }

      await client.proveBlock();
      await client.syncState();
      const synced = await client.getSyncHeight();
      const summary = await client.executeForSummary(
        multisigAccountId,
        request
      );

      return {
        syncHeight,
        declared: Array.from(request.blockNumbers()),
        earlyError,
        synced,
        commitment: summary.toCommitment().toHex(),
      };
    });

    expect(result.declared).toEqual([result.syncHeight + 1]);
    expect(result.earlyError).toContain("is after transaction reference block");
    expect(result.synced).toBeGreaterThanOrEqual(result.syncHeight + 1);
    expect(result.commitment).toMatch(/^0x[0-9a-f]+$/);
  });
});
