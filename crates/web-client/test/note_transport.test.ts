// @ts-nocheck
import { test, expect } from "./test-setup";

test("transport basic", async ({ run }) => {
  const result = await run(async ({ client, sdk, helpers }) => {
    const mockClient = await helpers.createFreshMockClient();

    // Create 32-byte seeds
    const senderSeed = new Uint8Array(32).fill(1);
    const recipientSeed = new Uint8Array(32).fill(2);

    // Create accounts on the same client
    const senderAccount = await mockClient.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512,
      senderSeed
    );
    const recipientAccount = await mockClient.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512,
      recipientSeed
    );
    const faucetAccount = await mockClient.newFaucet(
      sdk.AccountStorageMode.private(),
      false,
      "DAG",
      "DAG",
      8,
      sdk.u64(10000000),
      sdk.AuthScheme.AuthRpoFalcon512
    );

    // Create recipient address
    const recipientAddress = sdk.Address.fromAccountId(
      recipientAccount.id(),
      "BasicWallet"
    );

    // Create note
    const noteAssets = new sdk.NoteAssets([
      new sdk.FungibleAsset(faucetAccount.id(), sdk.u64(1)),
    ]);
    const note = sdk.Note.createP2IDNote(
      senderAccount.id(),
      recipientAccount.id(),
      noteAssets,
      sdk.NoteType.Private,
      new sdk.NoteAttachment()
    );

    // No notes before sending
    await mockClient.fetchPrivateNotes();
    let notes = await mockClient.getInputNotes(
      new sdk.NoteFilter(sdk.NoteFilterTypes.All)
    );
    const notesBeforeSending = notes.length;

    // The note is uncommitted here (never minted), so it has no real inclusion
    // proof. mockAtBlock records block 0 and does not authenticate the path:
    // the mock transport accepts it and the recipient scans from that block. A
    // real node rejects the empty path. A committed note on this same client
    // would be auto-imported and would not isolate the transport.
    const proof = sdk.NoteInclusionProof.mockAtBlock(0);
    await mockClient.sendPrivateNote(note, recipientAddress, proof);

    // 1 note stored
    await mockClient.fetchPrivateNotes();
    notes = await mockClient.getInputNotes(
      new sdk.NoteFilter(sdk.NoteFilterTypes.All)
    );
    const notesAfterSending = notes.length;

    // Sync again, should be only 1 note stored
    await mockClient.fetchPrivateNotes();
    notes = await mockClient.getInputNotes(
      new sdk.NoteFilter(sdk.NoteFilterTypes.All)
    );
    const notesAfterSecondSync = notes.length;

    return { notesBeforeSending, notesAfterSending, notesAfterSecondSync };
  });

  expect(result.notesBeforeSending).toBe(0);
  expect(result.notesAfterSending).toBe(1);
  expect(result.notesAfterSecondSync).toBe(1);
});
