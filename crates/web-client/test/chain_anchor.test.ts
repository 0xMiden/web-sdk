// @ts-nocheck
import { test, expect } from "./test-setup";

// CHAIN ANCHOR TESTS
// =======================================================================================================

test.describe("chain anchor", () => {
  test("anchored execution references the anchor block, not the tip", async ({
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

      // Capture at the current tip. A mint consumes no notes, so nothing
      // beyond the reference block needs tracking.
      const anchor = await client.chainAnchorForRequest(request);
      const anchorBlock = anchor.blockNum();

      // Advance past the anchor so the local tip no longer matches it. Two
      // blocks rather than one, so "used the tip" and "off by one from the
      // anchor" are distinguishable failures.
      await client.proveBlock();
      await client.proveBlock();
      await client.syncState();
      const tip = await client.getSyncHeight();

      const anchored = await client.executeTransactionAt(
        faucet.id(),
        request,
        anchor
      );
      const anchoredBlock = anchored
        .executedTransaction()
        .blockHeader()
        .blockNum();

      // The same anchor handle is still usable — the binding borrows it.
      const atTip = await client.executeTransaction(faucet.id(), request);
      const tipBlock = atTip.executedTransaction().blockHeader().blockNum();

      return {
        anchorBlock,
        tip,
        anchoredBlock,
        tipBlock,
        anchorStillReadable: anchor.blockNum(),
      };
    });

    expect(result.tip).toBeGreaterThan(result.anchorBlock);
    expect(result.anchoredBlock).toEqual(result.anchorBlock);
    expect(result.tipBlock).toEqual(result.tip);
    expect(result.anchorStillReadable).toEqual(result.anchorBlock);
  });

  test("an anchor round-trips through serialization", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const request = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );

      const anchor = await client.chainAnchorForRequest(request);
      const restored = sdk.ChainAnchor.deserialize(anchor.serialize());

      // Executing against the restored anchor still pins the reference block,
      // which is the whole point of shipping it to a co-signer.
      await client.proveBlock();
      await client.syncState();
      const executed = await client.executeTransactionAt(
        faucet.id(),
        request,
        restored
      );

      return {
        blockNum: anchor.blockNum(),
        restoredBlockNum: restored.blockNum(),
        commitment: anchor.commitment().toHex(),
        restoredCommitment: restored.commitment().toHex(),
        headerBlockNum: restored.blockHeader().blockNum(),
        executedBlock: executed.executedTransaction().blockHeader().blockNum(),
        // The bytes are a transport format between parties, so re-encoding a
        // decoded anchor has to reproduce them exactly.
        bytes: Array.from(anchor.serialize()),
        restoredBytes: Array.from(restored.serialize()),
      };
    });

    expect(result.restoredBlockNum).toEqual(result.blockNum);
    expect(result.restoredCommitment).toEqual(result.commitment);
    expect(result.headerBlockNum).toEqual(result.blockNum);
    expect(result.executedBlock).toEqual(result.blockNum);
    expect(result.restoredBytes).toEqual(result.bytes);
  });

  test("an anchor that tracks blocks round-trips through serialization", async ({
    run,
  }) => {
    // The anchors above are captured for mint requests, which have no
    // authenticated input notes and so track no blocks. Only a request that
    // consumes a note exercises the populated partial blockchain, which is the
    // shape every real anchored flow uses.
    //
    // This covers the codec, not the worker plumbing: the harness terminates
    // the worker, so the serialize/deserialize pair below runs on the main
    // thread. That is the same pair the worker performs, so a codec regression
    // is caught here; the postMessage wiring itself is not exercised.
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      const { createdNoteId } = await helpers.mockMint(
        wallet.id(),
        faucet.id()
      );

      const inputNote = await client.getInputNote(createdNoteId);
      const consumeRequest = await client.newConsumeTransactionRequest(
        [inputNote.toNote()],
        wallet.id()
      );

      const anchor = await client.chainAnchorForRequest(consumeRequest);
      const bytes = anchor.serialize();
      const restored = sdk.ChainAnchor.deserialize(bytes);

      // Move the tip away from the anchor before executing. Without this the
      // anchor block and the tip coincide, and the assertion below would hold
      // even if the anchor were ignored entirely.
      await client.proveBlock();
      await client.proveBlock();
      await client.syncState();
      const tip = await client.getSyncHeight();

      const executed = await client.executeTransactionAt(
        wallet.id(),
        consumeRequest,
        restored
      );

      return {
        blockNum: anchor.blockNum(),
        restoredBlockNum: restored.blockNum(),
        commitment: anchor.commitment().toHex(),
        restoredCommitment: restored.commitment().toHex(),
        bytes: Array.from(bytes),
        restoredBytes: Array.from(restored.serialize()),
        tip,
        executedBlock: executed.executedTransaction().blockHeader().blockNum(),
      };
    });

    expect(result.restoredBlockNum).toEqual(result.blockNum);
    expect(result.restoredCommitment).toEqual(result.commitment);
    expect(result.restoredBytes).toEqual(result.bytes);
    expect(result.tip).toBeGreaterThan(result.blockNum);
    expect(result.executedBlock).toEqual(result.blockNum);
  });

  test("execution rejects a note created after the anchored block", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      // Anchor at the tip *before* the note exists.
      const probe = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );
      const anchor = await client.chainAnchorForRequest(probe);
      const anchorBlock = anchor.blockNum();

      // Mint a note, which lands in a block after the anchor.
      const { createdNoteId } = await helpers.mockMint(
        wallet.id(),
        faucet.id()
      );

      const inputNote = await client.getInputNote(createdNoteId);
      const consumeRequest = await client.newConsumeTransactionRequest(
        [inputNote.toNote()],
        wallet.id()
      );

      let errorMessage = null;
      try {
        await client.executeTransactionAt(wallet.id(), consumeRequest, anchor);
      } catch (e) {
        errorMessage = String(e);
      }

      return { errorMessage, anchorBlock };
    });

    expect(result.errorMessage).toMatch(
      /created in a block past the transaction reference block/
    );
    // The reference block it complains about is the anchor's, not the tip —
    // proof the anchor was honored rather than silently ignored.
    expect(result.errorMessage).toContain(`(${result.anchorBlock})`);
  });

  test("deserialize rejects bytes that are not a valid anchor", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const attempt = (bytes: Uint8Array) => {
        try {
          sdk.ChainAnchor.deserialize(bytes);
          return null;
        } catch (e) {
          return String(e);
        }
      };
      return {
        garbage: attempt(new Uint8Array([1, 2, 3, 4])),
        empty: attempt(new Uint8Array()),
        truncated: attempt(new Uint8Array(64)),
      };
    });

    expect(result.garbage).toMatch(/failed to deserialize/);
    expect(result.empty).toMatch(/failed to deserialize/);
    expect(result.truncated).toMatch(/failed to deserialize/);
  });

  test("deserialize rejects an anchor with bytes appended", async ({ run }) => {
    // The bytes travel between mutually distrusting parties, so the decoder
    // must not accept a suffix it silently ignores — that would make two
    // different blobs decode to one anchor.
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const request = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );

      const bytes = (await client.chainAnchorForRequest(request)).serialize();
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes);

      let errorMessage = null;
      try {
        sdk.ChainAnchor.deserialize(padded);
      } catch (e) {
        errorMessage = String(e);
      }
      // The unpadded bytes must still be accepted.
      const cleanBlockNum = sdk.ChainAnchor.deserialize(bytes).blockNum();
      return { errorMessage, cleanBlockNum };
    });

    expect(result.errorMessage).toMatch(/trailing bytes/);
    expect(result.cleanBlockNum).toBeGreaterThanOrEqual(0);
  });

  // The co-signing path this feature exists for: a summary derived at an
  // anchor, on an account whose transactions are not self-authorizing. A
  // fee-aware multisig request declares its bound block and so reproduces its
  // summary at any tip, which would hide an ignored anchor. This test drops the
  // declaration and moves the bound block off the note's creation block, so
  // only the anchor can supply it: swapping the implementation to the
  // unanchored `executeForSummary` fails here.
  test("a summary derived at an anchor references the anchor block", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId, notes } =
        await helpers.setupMultisigWithConsumableNote();

      // The fixture ends synced at the note's creation block, which the
      // request would track through its authenticated input note.
      const noteBlock = (await client.getSyncHeight()) as number;
      await client.proveBlock();
      await client.syncState();

      const request = await client.newConsumeTransactionRequest(
        notes,
        multisigAccountId
      );
      const undeclared = new sdk.TransactionRequestBuilder()
        .withInputNotes(
          new sdk.NoteAndArgsArray(
            notes.map((note) => new sdk.NoteAndArgs(note))
          )
        )
        .withAuthArg(request.authArg())
        .extendAdviceMap(request.adviceMap())
        .build();
      const anchor = await client.chainAnchorForRequest(undeclared);
      const anchorBlock = anchor.blockNum();
      const anchorCommitment = anchor.commitment().toHex();

      // Move the tip past the anchor so the two commitments cannot coincide.
      await client.proveBlock();
      await client.proveBlock();
      await client.syncState();
      const tip = (await client.getSyncHeight()) as number;

      const summary = await client.executeForSummaryAt(
        multisigAccountId,
        undeclared,
        anchor
      );

      let unanchoredError = null;
      try {
        await client.executeForSummary(multisigAccountId, undeclared);
      } catch (err) {
        unanchoredError = String(err?.message ?? err);
      }

      return {
        noteBlock,
        anchorBlock,
        anchorCommitment,
        tip,
        undeclaredBlocks: Array.from(undeclared.blockNumbers()),
        summaryBlockCommitment: summary.blockCommitment().toHex(),
        expirationDelta: summary.expirationDelta(),
        inputNotesCount: summary.inputNotes().numNotes(),
        unanchoredError,
      };
    });

    expect(result.anchorBlock).toBeGreaterThan(result.noteBlock);
    expect(result.tip).toBeGreaterThan(result.anchorBlock);
    expect(result.undeclaredBlocks).toEqual([]);
    // The assertion the test exists for: the summary's own reference block is
    // the anchor's, not the tip it would have used unanchored.
    expect(result.summaryBlockCommitment).toBe(result.anchorCommitment);
    expect(result.inputNotesCount).toBe(1);
    // Reported as 0 for a request that sets no expiration, which is this one.
    // Asserted to pin that the accessor reads the summary rather than throwing.
    expect(result.expirationDelta).toBe(0);
    // Without the anchor the bound block is not in the partial blockchain.
    expect(result.unanchoredError).toContain(
      "failed to lookup value in Merkle store"
    );
  });
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
  // the fee-aware builder declares that block on the request. Re-executing at a
  // later tip, with no anchor, must reproduce the summary the approvers signed.
  test("a multisig proposal reproduces its summary at a later tip without an anchor", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
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

      // An anchor captured now, well after the bound block, tracks it too.
      const lateAnchor = await client.chainAnchorForRequest(request);
      const atLateAnchor = await client.executeForSummaryAt(
        multisigAccountId,
        request,
        lateAnchor
      );

      // The same auth args without the declared block: the kernel cannot
      // authenticate the bound block at the tip, which is what the declaration
      // on the fee-aware request fixes.
      const undeclared = new sdk.TransactionRequestBuilder()
        .withAuthArg(request.authArg())
        .extendAdviceMap(request.adviceMap())
        .build();
      let undeclaredError = null;
      try {
        await client.executeForSummary(multisigAccountId, undeclared);
      } catch (err) {
        undeclaredError = String(err?.message ?? err);
      }

      return {
        boundBlock,
        declared: Array.from(request.blockNumbers()),
        tip,
        lateAnchorBlock: lateAnchor.blockNum(),
        original: original.toCommitment().toHex(),
        atTip: atTip.toCommitment().toHex(),
        atLateAnchor: atLateAnchor.toCommitment().toHex(),
        undeclaredBlocks: Array.from(undeclared.blockNumbers()),
        undeclaredError,
      };
    });

    expect(result.declared).toEqual([result.boundBlock]);
    expect(result.tip).toBeGreaterThan(result.boundBlock);
    expect(result.lateAnchorBlock).toBe(result.tip);
    expect(result.atTip).toBe(result.original);
    expect(result.atLateAnchor).toBe(result.original);
    // The control differs from the request only by the declaration, and fails
    // for exactly that reason.
    expect(result.undeclaredBlocks).toEqual([]);
    expect(result.undeclaredError).toContain(
      "failed to lookup value in Merkle store"
    );
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
