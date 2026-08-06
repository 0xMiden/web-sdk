// @ts-nocheck
import { test, expect } from "./test-setup";

// Regression guard for the block-hint overshoot bug (web-sdk#262): a sender that
// relays a private note AFTER syncing past the note's on-chain commitment must
// still deliver it. `sendPrivateOutputNote` derives the recipient's scan-start
// block from the note's stored expected_height (the submission tip, at or below the
// commitment); a sync-height hint would sit ABOVE the commitment once the sender
// advanced past it, and the recipient — which scans FORWARD from the hint — would
// silently never bind the note.
//
// This is a CROSS-client test. A private note's details are not on-chain, so the
// recipient can only obtain them through the transport layer (never by auto-import
// from the chain), and a same-client mock chain auto-imports the committed note for
// a tracked recipient, bypassing the transport entirely. So the recipient lives on a
// second client that shares only the sender's post-relay mock chain + note-transport
// node — exactly the sender→recipient split the bug affects.
//
// It lives in a `.node.test.ts` file (node-only) on purpose. The behavior under test
// is platform-independent Rust, so the napi client exercises the identical code path.
// The browser mock harness serializes the whole mock chain through its worker on every
// delegated op (see the note in test-setup's setupBrowserPage), and driving two full
// mock clients plus chain/transport serialization through that path hangs — a harness
// limitation unrelated to the SDK behavior this guards.
test("private-note recipient still receives after the sender syncs past the note's commitment", async ({
  run,
}) => {
  const result = await run(async ({ sdk, helpers }) => {
    // ── Client A (sender): create recipient + faucet on the sender's store ──
    const sender = await helpers.createFreshMockClient();
    if (!sender) return { skip: true };

    const recipientWallet = await sender.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512
    );

    const faucet = await sender.newFaucet(
      sdk.AccountStorageMode.private(),
      false,
      "DAG",
      "DAG",
      8,
      sdk.u64(10000000),
      sdk.AuthScheme.AuthRpoFalcon512
    );

    // ── Mint a PRIVATE note to the recipient and commit it (block C) ──
    const mintRequest = await sender.newMintTransactionRequest(
      recipientWallet.id(),
      faucet.id(),
      sdk.NoteType.Private,
      sdk.u64(1000)
    );
    const mintTxId = await sender.submitNewTransaction(
      faucet.id(),
      mintRequest
    );
    await sender.proveBlock();
    await sender.syncState();

    const [mintTxRecord] = await sender.getTransactions(
      sdk.TransactionFilter.ids([mintTxId])
    );
    const relayedNoteId = mintTxRecord.outputNotes().notes()[0].id().toString();
    // The note commits at this block; the sender advances past it before relaying.
    const heightAtCommit = await sender.getSyncHeight();

    // ── Advance the sender PAST the commitment, THEN relay ──
    // This is the bug's trigger: the sender's sync height is now above the note's
    // commitment block, so a naive sync-height hint would overshoot it.
    for (let i = 0; i < 3; i++) {
      await sender.proveBlock();
      await sender.syncState();
    }
    const heightAtRelay = await sender.getSyncHeight();
    const recipientAddress = sdk.Address.fromAccountId(
      recipientWallet.id(),
      "BasicWallet"
    );
    // Relay via the convenience method: it derives the recipient's scan-start block from the
    // output note's expected_height (the submission tip, at or below the commitment), NOT the
    // sender's now-advanced sync height — so delivery survives the sync advance.
    await sender.sendPrivateOutputNote(relayedNoteId, recipientAddress);

    // Snapshot the sender's chain + transport (post-relay) and export the
    // recipient account so a fresh client can track and receive.
    const serializedChain = await sender.serializeMockChain();
    const serializedTransport = await sender.serializeMockNoteTransportNode();
    const recipientAccountBytes = (
      await sender.exportAccountFile(recipientWallet.id())
    ).serialize();

    // ── Client B (recipient): separate store, sharing A's chain + transport ──
    const recipient = await helpers.createFreshMockClient(
      serializedChain,
      serializedTransport
    );
    if (!recipient) return { skip: true };

    // Sync the recipient to the shared chain tip BEFORE it starts tracking the
    // recipient account. This is the bug's precondition: the recipient's sync
    // height is already past the note's commitment block, so its own sync never
    // re-scans that block for its tag — it must rely entirely on the transport's
    // block hint to locate the commitment.
    await recipient.syncState();
    await recipient.importAccountFile(
      sdk.AccountFile.deserialize(recipientAccountBytes)
    );

    // The delivery path for a private note is the transport layer: fetch the
    // details, then scan forward from the block hint for the on-chain commitment.
    await recipient.fetchPrivateNotes();
    await recipient.syncState();

    // The discriminator is COMMITTED, not All: the transport always imports the
    // details (so an uncommitted "expected" record appears under All in both the
    // fixed and buggy cases). Only a hint at or below the commitment lets the
    // recipient locate the on-chain commitment and bind the note as committed.
    const committed = await recipient.getInputNotes(
      new sdk.NoteFilter(sdk.NoteFilterTypes.Committed)
    );

    return {
      skip: false,
      relayedNoteId,
      heightAtCommit,
      heightAtRelay,
      committedCount: committed.length,
      committedNoteId: committed[0] ? committed[0].id().toString() : null,
    };
  });

  if (result.skip) return;

  // Precondition: the sender relayed only after syncing past the note's
  // commitment block, so a naive sync-height hint would overshoot it.
  expect(result.heightAtRelay).toBeGreaterThan(result.heightAtCommit);

  // The recipient — already synced past the commitment before it began tracking
  // the account — must still bind the note via the transport's commitment-block
  // hint. With the pre-fix sync-height hint the forward scan starts above the
  // commitment, never reaches it, and the note stays uncommitted (count 0).
  expect(result.committedCount).toBe(1);
  expect(result.committedNoteId).toBe(result.relayedNoteId);
});

// Companion guard for the agnostic low-level `sendPrivateNote(note, address,
// scanAfterBlockNum)`: the explicit hint is honoured, so relaying with a hint ABOVE
// the note's commitment block makes the recipient scan forward from above the
// commitment and never bind the note. This is the failure mode the block hint exists
// to prevent, and it's what a caller would hit if they passed the client's (advanced)
// sync height — exactly why the API forces the caller to choose the block.
test("agnostic sendPrivateNote does NOT deliver when the explicit hint overshoots the commitment", async ({
  run,
}) => {
  const result = await run(async ({ sdk, helpers }) => {
    const sender = await helpers.createFreshMockClient();
    if (!sender) return { skip: true };

    const recipientWallet = await sender.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512
    );
    const faucet = await sender.newFaucet(
      sdk.AccountStorageMode.private(),
      false,
      "DAG",
      "DAG",
      8,
      sdk.u64(10000000),
      sdk.AuthScheme.AuthRpoFalcon512
    );

    // Mint a PRIVATE note to the recipient and commit it (block C).
    const mintRequest = await sender.newMintTransactionRequest(
      recipientWallet.id(),
      faucet.id(),
      sdk.NoteType.Private,
      sdk.u64(1000)
    );
    const mintTxId = await sender.submitNewTransaction(
      faucet.id(),
      mintRequest
    );
    await sender.proveBlock();
    await sender.syncState();

    const [mintTxRecord] = await sender.getTransactions(
      sdk.TransactionFilter.ids([mintTxId])
    );
    const relayedNoteId = mintTxRecord.outputNotes().notes()[0].id().toString();
    const heightAtCommit = await sender.getSyncHeight();
    const note = (await sender.getInputNote(relayedNoteId)).toNote();

    // Advance PAST the commitment, then relay with a deliberately-too-high hint
    // (the sender's now-advanced sync height) via the agnostic low-level method.
    for (let i = 0; i < 3; i++) {
      await sender.proveBlock();
      await sender.syncState();
    }
    const heightAtRelay = await sender.getSyncHeight();
    const recipientAddress = sdk.Address.fromAccountId(
      recipientWallet.id(),
      "BasicWallet"
    );
    await sender.sendPrivateNote(note, recipientAddress, heightAtRelay);

    const serializedChain = await sender.serializeMockChain();
    const serializedTransport = await sender.serializeMockNoteTransportNode();
    const recipientAccountBytes = (
      await sender.exportAccountFile(recipientWallet.id())
    ).serialize();

    const recipient = await helpers.createFreshMockClient(
      serializedChain,
      serializedTransport
    );
    if (!recipient) return { skip: true };

    await recipient.syncState();
    await recipient.importAccountFile(
      sdk.AccountFile.deserialize(recipientAccountBytes)
    );
    await recipient.fetchPrivateNotes();
    await recipient.syncState();

    const committed = await recipient.getInputNotes(
      new sdk.NoteFilter(sdk.NoteFilterTypes.Committed)
    );

    return {
      skip: false,
      heightAtCommit,
      heightAtRelay,
      committedCount: committed.length,
    };
  });

  if (result.skip) return;

  // The hint overshoots the commitment...
  expect(result.heightAtRelay).toBeGreaterThan(result.heightAtCommit);
  // ...so the recipient never binds the note: the explicit hint is honoured.
  expect(result.committedCount).toBe(0);
});
