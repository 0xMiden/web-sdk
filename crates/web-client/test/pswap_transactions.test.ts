// @ts-nocheck
import { test, expect } from "./test-setup";

// PSWAP_TRANSACTION TEST
// =======================================================================================================

test.describe("pswap transaction tests", () => {
  test("pswap full fill completes successfully", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: walletA, faucet: faucetA } =
        await helpers.setupWalletAndFaucet();
      const { wallet: walletB, faucet: faucetB } =
        await helpers.setupWalletAndFaucet();

      // Fund the creator with the offered asset and the filler with the
      // requested asset.
      await helpers.mockMintAndConsume(walletA.id(), faucetA.id());
      await helpers.mockMintAndConsume(walletB.id(), faucetB.id());

      const faucetAId = faucetA.id().toString();
      const faucetBId = faucetB.id().toString();

      const { creatorAssets, fillerAssets, consumeOutputNoteCount } =
        await helpers.mockPswapFullFill(
          walletA.id(),
          walletB.id(),
          faucetA.id(),
          1,
          faucetB.id(),
          25,
          "private",
          "private"
        );

      return {
        creatorAssets,
        fillerAssets,
        consumeOutputNoteCount,
        faucetAId,
        faucetBId,
      };
    });

    // A full fill emits a single payback note — no remainder PSWAP note.
    expect(result.consumeOutputNoteCount).toEqual(1);

    // --- creator (Account A) ---
    const cA = result.creatorAssets.find((a) => a.assetId === result.faucetAId);
    expect(cA, `Expected faucetA asset on the creator`).toBeTruthy();
    expect(BigInt(cA.amount)).toEqual(999n);

    const cB = result.creatorAssets.find((a) => a.assetId === result.faucetBId);
    expect(cB, `Expected faucetB asset on the creator`).toBeTruthy();
    expect(BigInt(cB.amount)).toEqual(25n);

    // --- filler (Account B) ---
    const fA = result.fillerAssets.find((a) => a.assetId === result.faucetAId);
    expect(fA, `Expected faucetA asset on the filler`).toBeTruthy();
    expect(BigInt(fA.amount)).toEqual(1n);

    const fB = result.fillerAssets.find((a) => a.assetId === result.faucetBId);
    expect(fB, `Expected faucetB asset on the filler`).toBeTruthy();
    expect(BigInt(fB.amount)).toEqual(975n);
  });

  test("pswap partial fill emits a remainder note for the unfilled amount", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: walletA, faucet: faucetA } =
        await helpers.setupWalletAndFaucet();
      const { wallet: walletB, faucet: faucetB } =
        await helpers.setupWalletAndFaucet();

      await helpers.mockMintAndConsume(walletA.id(), faucetA.id());
      await helpers.mockMintAndConsume(walletB.id(), faucetB.id());

      const faucetAId = faucetA.id().toString();
      const faucetBId = faucetB.id().toString();

      // Offer 100 of faucetA for 25 of faucetB, but the filler only supplies
      // 10 of faucetB (a 10/25 fill). The filler should receive 40 of faucetA
      // (100 * 10 / 25) and a remainder PSWAP note carrying the other 60.
      const {
        creatorAssets,
        fillerAssets,
        consumeOutputNoteCount,
        remainderOfferedAmount,
      } = await helpers.mockPswapPartialFill(
        walletA.id(),
        walletB.id(),
        faucetA.id(),
        100,
        faucetB.id(),
        25,
        10,
        "private",
        "private"
      );

      return {
        creatorAssets,
        fillerAssets,
        consumeOutputNoteCount,
        remainderOfferedAmount,
        faucetAId,
        faucetBId,
      };
    });

    // A partial fill emits a payback note AND a remainder PSWAP note.
    expect(result.consumeOutputNoteCount).toEqual(2);

    // The remainder PSWAP note carries the unfilled offered amount.
    expect(result.remainderOfferedAmount).toBeTruthy();
    expect(BigInt(result.remainderOfferedAmount)).toEqual(60n);

    // --- creator (Account A): minted 1000 faucetA, locked 100 into the PSWAP
    //     note (→ 900 left), then consumed a payback note carrying 10 faucetB.
    const cA = result.creatorAssets.find((a) => a.assetId === result.faucetAId);
    expect(cA, `Expected faucetA asset on the creator`).toBeTruthy();
    expect(BigInt(cA.amount)).toEqual(900n);

    const cB = result.creatorAssets.find((a) => a.assetId === result.faucetBId);
    expect(cB, `Expected faucetB asset on the creator`).toBeTruthy();
    expect(BigInt(cB.amount)).toEqual(10n);

    // --- filler (Account B): minted 1000 faucetB, supplied 10 (→ 990 left),
    //     received 40 faucetA for the filled portion.
    const fA = result.fillerAssets.find((a) => a.assetId === result.faucetAId);
    expect(fA, `Expected faucetA asset on the filler`).toBeTruthy();
    expect(BigInt(fA.amount)).toEqual(40n);

    const fB = result.fillerAssets.find((a) => a.assetId === result.faucetBId);
    expect(fB, `Expected faucetB asset on the filler`).toBeTruthy();
    expect(BigInt(fB.amount)).toEqual(990n);

    // Conservation: the offered 100 splits into the filler's share plus the
    // remainder note, with nothing created or destroyed.
    expect(BigInt(fA.amount) + BigInt(result.remainderOfferedAmount)).toEqual(
      100n
    );
  });

  test("pswap cancel reclaims the offered asset", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      const { faucet: requestedFaucet } = await helpers.setupWalletAndFaucet();

      // Fund the creator with 1000 of the offered asset.
      await helpers.mockMintAndConsume(wallet.id(), faucet.id());

      const offeredFaucetId = faucet.id().toString();

      const { creatorAssets } = await helpers.mockPswapCancel(
        wallet.id(),
        faucet.id(),
        100,
        requestedFaucet.id(),
        25,
        "private"
      );

      return { creatorAssets, offeredFaucetId };
    });

    // The 100 units locked into the PSWAP note are returned to the creator,
    // leaving the full minted balance intact.
    const offered = result.creatorAssets.find(
      (a) => a.assetId === result.offeredFaucetId
    );
    expect(
      offered,
      `Expected the offered asset back on the creator`
    ).toBeTruthy();
    expect(BigInt(offered.amount)).toEqual(1000n);
  });

  test("pswap create rejects offering and requesting the same asset", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(wallet.id(), faucet.id());

      let threw = false;
      let message = "";
      try {
        await client.newPswapCreateTransactionRequest(
          wallet.id(),
          faucet.id(),
          sdk.u64(100),
          faucet.id(),
          sdk.u64(50),
          sdk.NoteType.Private,
          sdk.NoteType.Private
        );
      } catch (err) {
        threw = true;
        message = String((err && err.message) || err);
      }
      return { threw, message };
    });

    expect(result.threw).toBe(true);
    // Assert it failed for the right reason, not some unrelated throw.
    expect(result.message).toMatch(
      /offered and requested assets must have different faucets/i
    );
  });

  test("pswap consume rejects a fill larger than the requested amount", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: filler, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      await helpers.mockMintAndConsume(filler.id(), requestedFaucet.id());

      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      const createTxId = await client.submitNewTransaction(
        creator.id(),
        createRequest
      );
      await client.proveBlock();
      await client.syncState();
      const [createTxRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([createTxId])
      );
      const pswapNoteId = createTxRecord
        .outputNotes()
        .notes()[0]
        .id()
        .toString();
      const pswapNoteRecord = await client.getInputNote(pswapNoteId);

      let threw = false;
      let message = "";
      try {
        // Fill 50 against a note that only requests 25.
        const consumeRequest = client.newPswapConsumeTransactionRequest(
          pswapNoteRecord.toNote(),
          filler.id(),
          sdk.u64(50),
          sdk.u64(0)
        );
        await client.submitNewTransaction(filler.id(), consumeRequest);
        await client.proveBlock();
        await client.syncState();
      } catch (err) {
        threw = true;
        message = String((err && err.message) || err);
      }
      return { threw, message };
    });

    expect(result.threw).toBe(true);
    // Assert it failed for the right reason, not some unrelated throw.
    expect(result.message).toMatch(/exceeds requested amount/i);
  });

  test("pswap consume rejects a zero fill", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: filler, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      await helpers.mockMintAndConsume(filler.id(), requestedFaucet.id());

      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      const createTxId = await client.submitNewTransaction(
        creator.id(),
        createRequest
      );
      await client.proveBlock();
      await client.syncState();
      const [createTxRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([createTxId])
      );
      const pswapNoteId = createTxRecord
        .outputNotes()
        .notes()[0]
        .id()
        .toString();
      const pswapNoteRecord = await client.getInputNote(pswapNoteId);

      let threw = false;
      let message = "";
      try {
        // Fill 0 against a note that requests 25.
        const consumeRequest = client.newPswapConsumeTransactionRequest(
          pswapNoteRecord.toNote(),
          filler.id(),
          sdk.u64(0),
          sdk.u64(0)
        );
        await client.submitNewTransaction(filler.id(), consumeRequest);
        await client.proveBlock();
        await client.syncState();
      } catch (err) {
        threw = true;
        message = String((err && err.message) || err);
      }
      return { threw, message };
    });

    expect(result.threw).toBe(true);
    // Assert it failed for the right reason, not some unrelated throw.
    expect(result.message).toMatch(/fill amount must be greater than 0/i);
  });

  test("pswap cancel rejects a non-creator", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: stranger, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());

      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      const createTxId = await client.submitNewTransaction(
        creator.id(),
        createRequest
      );
      await client.proveBlock();
      await client.syncState();
      const [createTxRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([createTxId])
      );
      const pswapNoteId = createTxRecord
        .outputNotes()
        .notes()[0]
        .id()
        .toString();
      const pswapNoteRecord = await client.getInputNote(pswapNoteId);

      let threw = false;
      let message = "";
      try {
        // A non-creator account attempts to cancel and reclaim the offer.
        const cancelRequest = client.newPswapCancelTransactionRequest(
          pswapNoteRecord.toNote(),
          stranger.id()
        );
        await client.submitNewTransaction(stranger.id(), cancelRequest);
        await client.proveBlock();
        await client.syncState();
      } catch (err) {
        threw = true;
        message = String((err && err.message) || err);
      }
      return { threw, message };
    });

    expect(result.threw).toBe(true);
    // Assert it failed for the right reason, not some unrelated throw.
    expect(result.message).toMatch(/can only be cancelled by its creator/i);
  });
});

// PSWAP_LINEAGE_TRACKING TEST
// =======================================================================================================
//
// Exercises the order-tracking surface (getPswapLineages / getPswapLineagesFor /
// getPswapLineage / buildPswapCancelByOrder) end-to-end against the mock chain.
// A lineage is registered by the transaction observer when a depth-0 PSWAP note
// is created, then advanced round-by-round by the sync-time chain observer.

test.describe("pswap lineage tracking tests", () => {
  test("pswap create registers a depth-0 lineage queryable by order id and creator", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: other, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());

      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      await client.submitNewTransaction(creator.id(), createRequest);
      await client.proveBlock();
      await client.syncState();

      const lineages = await client.getPswapLineages();
      const lineage = lineages[0];
      const orderId = lineage.orderId();

      const byId = await client.getPswapLineage(orderId);
      // A valid-but-untracked order id resolves to null/undefined, not a throw.
      const missing = await client.getPswapLineage("999999999999");
      const byCreator = await client.getPswapLineagesFor(creator.id());
      const byOther = await client.getPswapLineagesFor(other.id());

      return {
        count: lineages.length,
        orderId,
        depth: Number(lineage.currentDepth()),
        state: Number(lineage.state()),
        remainingOffered: lineage.remainingOffered().amount().toString(),
        remainingRequested: lineage.remainingRequested().amount().toString(),
        offeredFaucet: lineage.remainingOffered().faucetId().toString(),
        requestedFaucet: lineage.remainingRequested().faucetId().toString(),
        creator: lineage.creatorAccountId().toString(),
        tip: lineage.currentTipNoteId().toString(),
        byIdOrderId: byId ? byId.orderId() : null,
        byIdTip: byId ? byId.currentTipNoteId().toString() : null,
        missingResolvesEmpty: missing === undefined || missing === null,
        byCreatorCount: byCreator.length,
        byCreatorOrderId: byCreator[0] ? byCreator[0].orderId() : null,
        byOtherCount: byOther.length,
        offeredFaucetExpected: offeredFaucet.id().toString(),
        requestedFaucetExpected: requestedFaucet.id().toString(),
        creatorExpected: creator.id().toString(),
      };
    });

    // Exactly one lineage, recorded at depth 0 in the Active state.
    expect(result.count).toEqual(1);
    expect(result.depth).toEqual(0);
    expect(result.state).toEqual(0); // PswapLineageState.Active

    // At depth 0 the remaining amounts equal the initial offer.
    expect(BigInt(result.remainingOffered)).toEqual(100n);
    expect(BigInt(result.remainingRequested)).toEqual(25n);

    // The offered/requested faucets ride on the remaining-asset fields
    // (chain-invariant across the order).
    expect(result.offeredFaucet).toEqual(result.offeredFaucetExpected);
    expect(result.requestedFaucet).toEqual(result.requestedFaucetExpected);
    expect(result.creator).toEqual(result.creatorExpected);

    // getPswapLineage(orderId) returns the same lineage.
    expect(result.byIdOrderId).toEqual(result.orderId);
    expect(result.byIdTip).toEqual(result.tip);
    expect(result.missingResolvesEmpty).toBe(true);

    // getPswapLineagesFor filters by creator account.
    expect(result.byCreatorCount).toEqual(1);
    expect(result.byCreatorOrderId).toEqual(result.orderId);
    expect(result.byOtherCount).toEqual(0);
  });

  test("pswap partial fill advances the tracked lineage", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: filler, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      await helpers.mockMintAndConsume(filler.id(), requestedFaucet.id());

      // Offer 100 of faucetA for 25 of faucetB.
      //
      // Public notes — a constraint of the mock backend, not the product.
      // Lineage *advancement* is driven by `PswapChainObserver` during sync,
      // which classifies a round from the depth+1 remainder and payback notes'
      // PSWAP attachments. A real node returns private notes' attachment content
      // via `get_notes_by_id` (rust-client `sync_notes_with_details`), so private
      // chains advance in production. The serialized `MockWebClient` chain used
      // here does not surface that content, so a private fill's depth+1 notes
      // never reach the correlator — it sees a consumed tip and zero depth+1
      // notes, indistinguishable from a reclaim. Public notes carry their bodies
      // in the sync window, so the correlator sees both notes and advances.
      // Depth-0 registration (test above) rides the in-memory transaction
      // observer rather than sync discovery, so it works on a private note.
      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Public,
        sdk.NoteType.Public
      );
      await client.submitNewTransaction(creator.id(), createRequest);
      await client.proveBlock();
      await client.syncState();

      const before = await client.getPswapLineage(
        (await client.getPswapLineages())[0].orderId()
      );
      const orderId = before.orderId();
      const tipBefore = before.currentTipNoteId().toString();

      // Filler supplies 10 of the 25 requested — a partial fill that leaves a
      // remainder PSWAP note carrying 60 of the offered asset.
      const pswapNoteRecord = await client.getInputNote(tipBefore);
      const consumeRequest = client.newPswapConsumeTransactionRequest(
        pswapNoteRecord.toNote(),
        filler.id(),
        sdk.u64(10),
        sdk.u64(0)
      );
      await client.submitNewTransaction(filler.id(), consumeRequest);
      await client.proveBlock();
      await client.syncState();

      const after = await client.getPswapLineage(orderId);

      return {
        orderId,
        tipBefore,
        depthBefore: Number(before.currentDepth()),
        depthAfter: Number(after.currentDepth()),
        stateAfter: Number(after.state()),
        remainingOfferedAfter: after.remainingOffered().amount().toString(),
        remainingRequestedAfter: after.remainingRequested().amount().toString(),
        tipAfter: after.currentTipNoteId().toString(),
      };
    });

    // The fill advances the lineage one round but keeps it Active.
    expect(result.depthBefore).toEqual(0);
    expect(result.depthAfter).toEqual(1);
    expect(result.stateAfter).toEqual(0); // PswapLineageState.Active

    // 100 * 10 / 25 = 40 paid out, leaving 60 offered and 15 requested.
    expect(BigInt(result.remainingOfferedAfter)).toEqual(60n);
    expect(BigInt(result.remainingRequestedAfter)).toEqual(15n);

    // The tip moved to the remainder note.
    expect(result.tipAfter).not.toEqual(result.tipBefore);
  });

  test("pswap full fill marks the tracked lineage fully filled", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: filler, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      await helpers.mockMintAndConsume(filler.id(), requestedFaucet.id());

      // Offer 100 of faucetA for 25 of faucetB. Public notes for the same
      // reason as the partial-fill test: lineage advancement runs through the
      // sync-time `PswapChainObserver`, which needs the depth+1 payback note's
      // PSWAP attachment content — surfaced by the mock backend only for public
      // notes. A complete fill emits a single payback note (no remainder), which
      // the correlator classifies as a full fill.
      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Public,
        sdk.NoteType.Public
      );
      await client.submitNewTransaction(creator.id(), createRequest);
      await client.proveBlock();
      await client.syncState();

      const before = await client.getPswapLineage(
        (await client.getPswapLineages())[0].orderId()
      );
      const orderId = before.orderId();
      const tipBefore = before.currentTipNoteId().toString();

      // Filler supplies the full 25 requested — a complete fill that drains the
      // order. No remainder PSWAP note is emitted, so the lineage goes terminal.
      const pswapNoteRecord = await client.getInputNote(tipBefore);
      const consumeRequest = client.newPswapConsumeTransactionRequest(
        pswapNoteRecord.toNote(),
        filler.id(),
        sdk.u64(25),
        sdk.u64(0)
      );
      await client.submitNewTransaction(filler.id(), consumeRequest);
      await client.proveBlock();
      await client.syncState();

      const after = await client.getPswapLineage(orderId);

      return {
        orderId,
        tipBefore,
        depthBefore: Number(before.currentDepth()),
        depthAfter: Number(after.currentDepth()),
        stateAfter: Number(after.state()),
        remainingOfferedAfter: after.remainingOffered().amount().toString(),
        remainingRequestedAfter: after.remainingRequested().amount().toString(),
        tipAfter: after.currentTipNoteId().toString(),
      };
    });

    // The fill advances the lineage one round and marks it terminal.
    expect(result.depthBefore).toEqual(0);
    expect(result.depthAfter).toEqual(1);
    expect(result.stateAfter).toEqual(1); // PswapLineageState.FullyFilled

    // A complete fill drains both sides to zero.
    expect(BigInt(result.remainingOfferedAfter)).toEqual(0n);
    expect(BigInt(result.remainingRequestedAfter)).toEqual(0n);

    // A terminal round carries no new tip — the tip stays frozen at depth 0.
    expect(result.tipAfter).toEqual(result.tipBefore);
  });

  test("pswap cancel by order reclaims the offered asset and marks the lineage reclaimed", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { faucet: requestedFaucet } = await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      const offeredFaucetId = offeredFaucet.id().toString();

      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      await client.submitNewTransaction(creator.id(), createRequest);
      await client.proveBlock();
      await client.syncState();

      const orderId = (await client.getPswapLineages())[0].orderId();

      // Reclaim by stable order id — the creator account and current tip are
      // resolved from the tracked lineage, so only the order id is supplied.
      const cancelRequest = await client.buildPswapCancelByOrder(orderId);
      await client.submitNewTransaction(creator.id(), cancelRequest);
      await client.proveBlock();
      await client.syncState();

      const after = await client.getPswapLineage(orderId);
      const creatorAccount = await client.getAccount(creator.id());
      const creatorAssets = creatorAccount
        ?.vault()
        .fungibleAssets()
        .map((asset) => ({
          assetId: asset.faucetId().toString(),
          amount: asset.amount().toString(),
        }));

      return {
        orderId,
        stateAfter: after ? Number(after.state()) : null,
        offeredFaucetId,
        creatorAssets,
      };
    });

    // The full minted balance is restored — the 100 locked into the PSWAP note
    // is reclaimed.
    const offered = result.creatorAssets.find(
      (a) => a.assetId === result.offeredFaucetId
    );
    expect(
      offered,
      `Expected the offered asset back on the creator`
    ).toBeTruthy();
    expect(BigInt(offered.amount)).toEqual(1000n);

    // The reclaim is discovered during sync and marks the lineage terminal.
    expect(result.stateAfter).toEqual(2); // PswapLineageState.Reclaimed
  });

  test("pswap cancel by order targets depth-1 remainder after partial fill", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: filler, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      await helpers.mockMintAndConsume(filler.id(), requestedFaucet.id());
      const offeredFaucetId = offeredFaucet.id().toString();

      // Public notes — required for lineage advancement through sync; the mock
      // backend only surfaces PSWAP attachment content for public notes.
      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Public,
        sdk.NoteType.Public
      );
      await client.submitNewTransaction(creator.id(), createRequest);
      await client.proveBlock();
      await client.syncState();

      const orderId = (await client.getPswapLineages())[0].orderId();
      const tipAtDepth0 = (await client.getPswapLineage(orderId))
        .currentTipNoteId()
        .toString();

      // Partial fill: filler pays 10 of 25 requested →
      //   filler receives 40 of offered A;
      //   remainder PSWAP carries 60 A for 15 B.
      const pswapNoteRecord = await client.getInputNote(tipAtDepth0);
      const consumeRequest = client.newPswapConsumeTransactionRequest(
        pswapNoteRecord.toNote(),
        filler.id(),
        sdk.u64(10),
        sdk.u64(0)
      );
      await client.submitNewTransaction(filler.id(), consumeRequest);
      await client.proveBlock();
      await client.syncState();

      const lineageAtDepth1 = await client.getPswapLineage(orderId);
      const tipAtDepth1 = lineageAtDepth1.currentTipNoteId().toString();

      // buildPswapCancelByOrder resolves the depth-1 tip from the stored
      // lineage, not from the now-spent depth-0 note.
      const cancelRequest = await client.buildPswapCancelByOrder(orderId);
      await client.submitNewTransaction(creator.id(), cancelRequest);
      await client.proveBlock();
      await client.syncState();

      const after = await client.getPswapLineage(orderId);
      const creatorAccount = await client.getAccount(creator.id());
      const creatorAssets = creatorAccount
        ?.vault()
        .fungibleAssets()
        .map((asset) => ({
          assetId: asset.faucetId().toString(),
          amount: asset.amount().toString(),
        }));

      return {
        orderId,
        tipAtDepth0,
        tipAtDepth1,
        depthAfterFill: Number(lineageAtDepth1.currentDepth()),
        stateAfterCancel: after ? Number(after.state()) : null,
        offeredFaucetId,
        creatorAssets,
      };
    });

    // Fill advanced lineage to depth 1 and moved the tip.
    expect(result.depthAfterFill).toEqual(1);
    expect(result.tipAtDepth1).not.toEqual(result.tipAtDepth0);

    // Cancel targets the depth-1 remainder and marks the lineage terminal.
    expect(result.stateAfterCancel).toEqual(2); // PswapLineageState.Reclaimed

    // Creator recovers the 60 A remaining after the partial fill.
    // 1000 initial − 100 locked into PSWAP + 60 reclaimed = 960.
    const offered = result.creatorAssets.find(
      (a) => a.assetId === result.offeredFaucetId
    );
    expect(offered, `Expected offered asset back on creator`).toBeTruthy();
    expect(BigInt(offered.amount)).toEqual(960n);
  });

  test("buildPswapCancelByOrder on a FullyFilled lineage errors before proving", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: filler, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      await helpers.mockMintAndConsume(filler.id(), requestedFaucet.id());

      // Create and fully fill the PSWAP (public notes for sync advancement).
      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Public,
        sdk.NoteType.Public
      );
      await client.submitNewTransaction(creator.id(), createRequest);
      await client.proveBlock();
      await client.syncState();

      const orderId = (await client.getPswapLineages())[0].orderId();
      const tipId = (await client.getPswapLineage(orderId))
        .currentTipNoteId()
        .toString();

      // Full fill — filler pays the entire 25 requested.
      const pswapNoteRecord = await client.getInputNote(tipId);
      const consumeRequest = client.newPswapConsumeTransactionRequest(
        pswapNoteRecord.toNote(),
        filler.id(),
        sdk.u64(25),
        sdk.u64(0)
      );
      await client.submitNewTransaction(filler.id(), consumeRequest);
      await client.proveBlock();
      await client.syncState();

      // Lineage is now FullyFilled (state 1).
      const lineageState = Number(
        (await client.getPswapLineage(orderId)).state()
      );

      // Cancelling a FullyFilled lineage must be refused by the
      // `buildPswapCancelByOrder` guard *before* any transaction is submitted.
      // The tip note is already consumed, so a submitted cancel would die at
      // execution with a misleading "note already nullified" error.
      let buildError = "";
      let submitted = false;
      try {
        const cancelRequest = await client.buildPswapCancelByOrder(orderId);
        submitted = true;
        await client.submitNewTransaction(creator.id(), cancelRequest);
      } catch (err) {
        buildError = err instanceof Error ? err.message : String(err);
      }

      return { lineageState, buildError, submitted };
    });

    expect(result.lineageState).toEqual(1); // FullyFilled — precondition check
    expect(result.buildError).toMatch(/only Active lineages can be cancelled/);
    expect(result.submitted).toBe(false);
  });

  test("buildPswapCancelByOrder on a Reclaimed lineage errors before proving", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { faucet: requestedFaucet } = await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());

      // Create and cancel a PSWAP at depth 0.
      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      await client.submitNewTransaction(creator.id(), createRequest);
      await client.proveBlock();
      await client.syncState();

      const orderId = (await client.getPswapLineages())[0].orderId();

      const cancelRequest = await client.buildPswapCancelByOrder(orderId);
      await client.submitNewTransaction(creator.id(), cancelRequest);
      await client.proveBlock();
      await client.syncState();

      // Lineage is now Reclaimed (state 2).
      const lineageState = Number(
        (await client.getPswapLineage(orderId)).state()
      );

      // A second cancel must be refused by the `buildPswapCancelByOrder` guard
      // before any submit — the tip note is already consumed.
      let buildError = "";
      let submitted = false;
      try {
        const cancelRequest2 = await client.buildPswapCancelByOrder(orderId);
        submitted = true;
        await client.submitNewTransaction(creator.id(), cancelRequest2);
      } catch (err) {
        buildError = err instanceof Error ? err.message : String(err);
      }

      return { lineageState, buildError, submitted };
    });

    expect(result.lineageState).toEqual(2); // Reclaimed — precondition check
    expect(result.buildError).toMatch(/only Active lineages can be cancelled/);
    expect(result.submitted).toBe(false);
  });
});
