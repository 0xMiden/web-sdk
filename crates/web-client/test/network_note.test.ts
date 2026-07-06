// @ts-nocheck
import { test, expect } from "./test-setup";

// NETWORK_NOTE TEST
// =======================================================================================================
//
// Load-bearing gate for the network-note-attachments feature: proves that a
// `NetworkAccountTarget` attachment on a Public note survives the full
// own-output-note submission path (submit -> proveBlock -> syncState ->
// fetch) against the real WASM/napi client, not a mocked unit test.

test.describe("network note tests", () => {
  test.describe.configure({ timeout: 720000 });

  test("custom-script note carries a NetworkAccountTarget and it survives submit", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      // A public (network-capable) account to target.
      const networkAccount = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      // The sender/creator.
      const sender = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      // Build a Public custom-script network note (P2ID script reused here as a
      // stand-in "custom" script; the point is Note.withAttachments + the target).
      const target = new sdk.NetworkAccountTarget(networkAccount.id());
      const p2idScript = sdk.NoteScript.p2id();
      const recipient = sdk.NoteRecipient.fromScript(
        p2idScript,
        new sdk.NoteStorage(new sdk.FeltArray([]))
      );
      const note = sdk.Note.withAttachments(
        new sdk.NoteAssets([]),
        new sdk.NoteMetadata(
          sender.id(),
          sdk.NoteType.Public,
          sdk.NoteTag.withAccountTarget(networkAccount.id())
        ),
        recipient,
        [target.toAttachment()]
      );

      const builtIsNetworkNote = note.isNetworkNote();
      const builtAttachmentCount = note.attachments().length;

      // Submit as an own output note.
      const ownOutputs = new sdk.NoteArray();
      ownOutputs.push(note);
      const request = new sdk.TransactionRequestBuilder()
        .withOwnOutputNotes(ownOutputs)
        .build();
      const txId = await client.submitNewTransaction(sender.id(), request);
      await client.proveBlock();
      await client.syncState();

      // Read the output note back off the persisted transaction record
      // (fetched fresh from the store via getTransactions, not the
      // in-memory `note` object above) and re-check it survived submission.
      const [record] = await client.getTransactions(
        sdk.TransactionFilter.ids([txId])
      );
      const outNote = record.outputNotes().notes()[0];
      const submittedNoteId = outNote.id().toString();
      const fetchedNote = outNote.intoFull();

      return {
        builtIsNetworkNote,
        builtAttachmentCount,
        submittedNoteId,
        fetchedNoteIsPresent: fetchedNote != null,
        fetchedIsNetworkNote: fetchedNote ? fetchedNote.isNetworkNote() : null,
        fetchedAttachmentCount: fetchedNote
          ? fetchedNote.attachments().length
          : null,
      };
    });

    // The built note is a valid network note before it ever touches the chain.
    expect(result.builtIsNetworkNote).toBe(true);
    expect(result.builtAttachmentCount).toBe(1);
    expect(typeof result.submittedNoteId).toBe("string");
    expect(result.submittedNoteId.length).toBeGreaterThan(0);

    // The load-bearing assertions: the note read back off the persisted
    // transaction record after submit -> proveBlock -> syncState still
    // carries its full data (attachments survive submission), and still
    // reports as a network note.
    expect(result.fetchedNoteIsPresent).toBe(true);
    expect(result.fetchedIsNetworkNote).toBe(true);
    expect(result.fetchedAttachmentCount).toBe(1);
  });
});
