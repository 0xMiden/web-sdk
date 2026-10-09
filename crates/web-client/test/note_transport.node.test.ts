// @ts-nocheck
import { test, expect } from "./test-setup";

// A sender that relays a private output note AFTER syncing past the note's
// commitment must still deliver it. `sendPrivateOutputNote` reads the inclusion
// proof sync stored on the output note. That proof names the commitment block,
// and the recipient scans forward from it.
//
// This is a cross-client test. A private note's details are not on chain, so the
// recipient can only obtain them through the transport layer, and a same-client
// mock chain auto-imports the committed note for a tracked recipient. The
// recipient lives on a second client that shares only the sender's post-relay
// mock chain and note-transport node.
//
// It lives in a `.node.test.ts` file (node-only) on purpose. The behavior under
// test is platform-independent Rust, so the napi client exercises the same path.
// The browser mock harness serializes the whole mock chain through its worker on
// every delegated op (see the note in test-setup's setupBrowserPage), and driving
// two full mock clients plus chain and transport serialization through that path
// hangs.
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
    // Relay via the convenience method. It reads the output note's inclusion
    // proof, which names the commitment block, rather than this client's
    // now-advanced sync height.
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
    // re-scans that block for its tag. It locates the commitment from the block
    // the transported proof names.
    await recipient.syncState();
    await recipient.importAccountFile(
      sdk.AccountFile.deserialize(recipientAccountBytes)
    );

    // The delivery path for a private note is the transport layer: fetch the
    // details, then scan forward from the proof's block for the commitment.
    await recipient.fetchPrivateNotes();
    await recipient.syncState();

    // The discriminator is COMMITTED, not All: the transport always imports the
    // details (so an uncommitted "expected" record appears under All either way).
    // Only a proof whose block is the commitment lets the recipient bind the note.
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

  // The recipient, already synced past the commitment before it began tracking
  // the account, must still bind the note from the proof's block.
  expect(result.committedCount).toBe(1);
  expect(result.committedNoteId).toBe(result.relayedNoteId);
});

// The agnostic `sendPrivateNote(note, address, inclusionProof)` delivers when
// given the output note's real inclusion proof, including after the sender has
// synced past the commitment. The proof is captured before that advance: the
// `Note` handed to sendPrivateNote does not carry it (`toNote()` strips it).
test("agnostic sendPrivateNote delivers the proof captured before the sender syncs past the commitment", async ({
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
    const proof = (await sender.getOutputNote(relayedNoteId)).inclusionProof();
    if (!proof) {
      throw new Error("committed output note has no inclusion proof");
    }
    const note = (await sender.getInputNote(relayedNoteId)).toNote();

    // Advance past the commitment, then relay the note with the proof captured
    // above. A real proof still names the commitment block.
    for (let i = 0; i < 3; i++) {
      await sender.proveBlock();
      await sender.syncState();
    }
    const heightAtRelay = await sender.getSyncHeight();
    const recipientAddress = sdk.Address.fromAccountId(
      recipientWallet.id(),
      "BasicWallet"
    );
    await sender.sendPrivateNote(note, recipientAddress, proof);

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

  // The sender relayed only after syncing past the commitment.
  expect(result.heightAtRelay).toBeGreaterThan(result.heightAtCommit);
  // The captured proof still names that block, so the recipient binds the note.
  expect(result.committedCount).toBe(1);
});
