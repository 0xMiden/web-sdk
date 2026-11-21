// @ts-nocheck
import { test, expect } from "./test-setup";

// NOTE DETAILS COMMITMENT
// =======================================================================================================
//
// `Note.detailsCommitment()` (and the matching methods on OutputNote,
// NoteDetails, InputNoteRecord) must return the recipient+assets commitment
// wallets need for B2AGG exit hashing — not the note ID, which also commits
// metadata. See issue #454.

test.describe("note detailsCommitment", () => {
  test("Note, OutputNote, NoteDetails and InputNoteRecord agree and differ from the note id", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const mockClient = await helpers.createFreshMockClient();

      const sender = await mockClient.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512,
        new Uint8Array(32).fill(1)
      );
      const target = await mockClient.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512,
        new Uint8Array(32).fill(2)
      );
      const faucet = await mockClient.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const noteAssets = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), sdk.u64(42)),
      ]);
      const note = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        noteAssets,
        sdk.NoteType.Private,
        new sdk.NoteAttachment()
      );

      const noteDetailsHex = note.detailsCommitment().toHex();
      const noteIdHex = note.id().toString();
      const noteCommitmentHex = note.commitment().toHex();

      const outputFull = sdk.OutputNote.full(note);
      const outputFullHex = outputFull.detailsCommitment().toHex();

      const details = new sdk.NoteDetails(note.assets(), note.recipient());
      const detailsHex = details.detailsCommitment().toHex();

      // Store via mock transport so we can read InputNoteRecord.detailsCommitment.
      const recipientAddress = sdk.Address.fromAccountId(
        target.id(),
        "BasicWallet"
      );
      const proof = sdk.NoteInclusionProof.mockAtBlock(0);
      await mockClient.sendPrivateNote(note, recipientAddress, proof);
      await mockClient.fetchPrivateNotes();
      const record = await mockClient.getInputNote(note.id().toString());
      const recordHex = record.detailsCommitment().toHex();

      return {
        noteDetailsHex,
        noteIdHex,
        noteCommitmentHex,
        outputFullHex,
        detailsHex,
        recordHex,
        differsFromId: noteDetailsHex !== noteIdHex,
        differsFromCommitment: noteDetailsHex !== noteCommitmentHex,
      };
    });

    expect(result.differsFromId).toBe(true);
    expect(result.differsFromCommitment).toBe(true);
    expect(result.outputFullHex).toBe(result.noteDetailsHex);
    expect(result.detailsHex).toBe(result.noteDetailsHex);
    expect(result.recordHex).toBe(result.noteDetailsHex);
  });
});
