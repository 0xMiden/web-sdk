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

    // Create recipient address
    const recipientAddress = sdk.Address.fromAccountId(
      recipientAccount.id(),
      "BasicWallet"
    );

    // Create note
    const noteAssets = new sdk.NoteAssets([]);
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

    // Send note
    await mockClient.sendPrivateNote(note, recipientAddress);

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

// Regression guard for the commitment-block hint (issue #262): relaying a note the sender
// has already synced PAST must still deliver. `sendPrivateNote` attaches a block hint the
// recipient scans FORWARD from; if it uses the sender's (advanced) sync height instead of the
// note's actual commitment block, the hint sits above the commitment and the recipient never
// binds the note. This test commits a private note, advances the sender well past its
// commitment block, then relays — and asserts the recipient can consume it.
test("transport hint is the note's commitment block, so delivery survives a sync advanced past it", async ({
  run,
}) => {
  const result = await run(async ({ sdk, helpers }) => {
    const client = await helpers.createFreshMockClient();

    const sender = await client.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512,
      new Uint8Array(32).fill(3)
    );
    const recipient = await client.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512,
      new Uint8Array(32).fill(4)
    );
    const faucet = await client.newFaucet(
      sdk.AccountStorageMode.private(),
      false,
      "DAG",
      "DAG",
      8,
      sdk.u64(10000000),
      sdk.AuthScheme.AuthRpoFalcon512
    );

    // Fund the sender: mint a note to it, then consume it.
    const mintRequest = await client.newMintTransactionRequest(
      sender.id(),
      faucet.id(),
      sdk.NoteType.Private,
      sdk.u64(1000)
    );
    const mintTxId = await client.submitNewTransaction(
      faucet.id(),
      mintRequest
    );
    await client.proveBlock();
    await client.syncState();
    const [mintTx] = await client.getTransactions(
      sdk.TransactionFilter.ids([mintTxId])
    );
    const mintedNoteId = mintTx.outputNotes().notes()[0].id().toString();
    const mintedNote = (await client.getInputNote(mintedNoteId)).toNote();
    const consumeRequest = client.newConsumeTransactionRequest([mintedNote]);
    await client.submitNewTransaction(sender.id(), consumeRequest);
    await client.proveBlock();
    await client.syncState();

    // Send a PRIVATE note sender -> recipient and commit it on-chain.
    const sendRequest = await client.newSendTransactionRequest(
      sender.id(),
      recipient.id(),
      faucet.id(),
      sdk.NoteType.Private,
      sdk.u64(100),
      null,
      null
    );
    const sendTxId = await client.submitNewTransaction(
      sender.id(),
      sendRequest
    );
    await client.proveBlock();
    await client.syncState();
    const [sendTx] = await client.getTransactions(
      sdk.TransactionFilter.ids([sendTxId])
    );
    const note = sendTx.outputNotes().notes()[0].intoFull();

    // Advance the sender's sync height WELL past the note's commitment block. With a bare
    // sync-height hint this now overshoots the commitment.
    for (let i = 0; i < 3; i++) {
      await client.proveBlock();
      await client.syncState();
    }

    const recipientAddress = sdk.Address.fromAccountId(
      recipient.id(),
      "BasicWallet"
    );

    // Recipient has nothing consumable before the transport delivers the note.
    const consumableBefore = (await client.getConsumableNotes(recipient.id()))
      .length;

    // Relay through the transport, then have the recipient pick it up.
    await client.sendPrivateNote(note, recipientAddress);
    await client.fetchPrivateNotes();
    await client.syncState();

    // The relayed note bound to its commitment and is consumable — only true if the hint was
    // the commitment block, not the advanced sync height.
    const consumableAfter = (await client.getConsumableNotes(recipient.id()))
      .length;

    return { consumableBefore, consumableAfter };
  });

  expect(result.consumableBefore).toBe(0);
  expect(result.consumableAfter).toBe(1);
});
