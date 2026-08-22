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
      const consumeRequest = client.newConsumeTransactionRequest([
        inputNote.toNote(),
      ]);

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
      const consumeRequest = client.newConsumeTransactionRequest([
        inputNote.toNote(),
      ]);

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
  // anchor, on an account whose transactions are not self-authorizing. Asserts
  // the summary's own reference block rather than just that a summary came
  // back, so swapping the implementation to the unanchored `executeForSummary`
  // fails here — that call would reference the advanced tip instead.
  test("a summary derived at an anchor references the anchor block", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { multisigAccountId, notes } =
        await helpers.setupMultisigWithConsumableNote();

      const request = client.newConsumeTransactionRequest(notes);
      const anchor = await client.chainAnchorForRequest(request);
      const anchorBlock = anchor.blockNum();
      const anchorCommitment = anchor.commitment().toHex();

      // Move the tip past the anchor so the two commitments cannot coincide.
      await client.proveBlock();
      await client.proveBlock();
      await client.syncState();
      const tip = (await client.getSyncHeight()) as number;

      const summary = await client.executeForSummaryAt(
        multisigAccountId,
        request,
        anchor
      );

      return {
        anchorBlock,
        anchorCommitment,
        tip,
        summaryBlockCommitment: summary.blockCommitment().toHex(),
        expirationDelta: summary.expirationDelta(),
        inputNotesCount: summary.inputNotes().numNotes(),
      };
    });

    expect(result.tip).toBeGreaterThan(result.anchorBlock);
    // The assertion the test exists for: the summary's own reference block is
    // the anchor's, not the tip it would have used unanchored.
    expect(result.summaryBlockCommitment).toBe(result.anchorCommitment);
    expect(result.inputNotesCount).toBe(1);
    // Reported as 0 for a request that sets no expiration, which is this one.
    // Asserted to pin that the accessor reads the summary rather than throwing.
    expect(result.expirationDelta).toBe(0);
  });
});
