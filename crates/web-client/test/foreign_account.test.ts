// @ts-nocheck
import { test, expect } from "./test-setup";

// FOREIGN ACCOUNT TESTS
// =======================================================================================================

test.describe("foreign accounts", () => {
  test("fetches foreign account inputs and replays them as prefetched", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const foreign = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      await client.proveBlock();
      await client.syncState();

      const blockNum = await client.getSyncHeight();
      const declared = sdk.ForeignAccount.public(
        foreign.id(),
        new sdk.AccountStorageRequirements()
      );

      const fetched = await client.getForeignAccountInputs(
        new sdk.ForeignAccountArray([declared]),
        blockNum
      );
      const first = fetched.get(0);

      // Bytes are how prefetched state reaches another client.
      const restored = sdk.AccountInputs.deserialize(first.serialize());

      // A prefetched entry is returned as it was given — nothing is fetched for it.
      const prefetched = sdk.ForeignAccount.prefetched(restored);
      const replayed = await client.getForeignAccountInputs(
        new sdk.ForeignAccountArray([prefetched]),
        blockNum
      );

      return {
        foreignId: foreign.id().toString(),
        fetchedCount: fetched.length(),
        fetchedId: first.accountId().toString(),
        restoredId: restored.accountId().toString(),
        prefetchedId: prefetched.account_id().toString(),
        replayedCount: replayed.length(),
        replayedId: replayed.get(0).accountId().toString(),
      };
    });

    expect(result.fetchedCount).toEqual(1);
    expect(result.fetchedId).toEqual(result.foreignId);
    expect(result.restoredId).toEqual(result.foreignId);
    expect(result.prefetchedId).toEqual(result.foreignId);
    expect(result.replayedCount).toEqual(1);
    expect(result.replayedId).toEqual(result.foreignId);
  });

  test("private and public declarations each reject the other's storage mode", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const privateAccount = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const publicAccount = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const declared = sdk.ForeignAccount.private(privateAccount);

      let publicRejected = false;
      try {
        sdk.ForeignAccount.private(publicAccount);
      } catch {
        publicRejected = true;
      }

      let privateRejected = false;
      try {
        sdk.ForeignAccount.public(
          privateAccount.id(),
          new sdk.AccountStorageRequirements()
        );
      } catch {
        privateRejected = true;
      }

      return {
        privateId: privateAccount.id().toString(),
        declaredId: declared.account_id().toString(),
        publicRejected,
        privateRejected,
      };
    });

    expect(result.declaredId).toEqual(result.privateId);
    expect(result.publicRejected).toBe(true);
    expect(result.privateRejected).toBe(true);
  });

  test("withExplicitInputNotes pins the consumption mode the store would not have chosen", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      // Commit the note so the store holds its inclusion proof. An inferred
      // consumption would therefore be authenticated.
      const { createdNoteId } = await helpers.mockMint(
        wallet.id(),
        faucet.id()
      );
      const record = await client.getInputNote(createdNoteId);

      const inferredRequest = new sdk.TransactionRequestBuilder()
        .withInputNotes(
          new sdk.NoteAndArgsArray([new sdk.NoteAndArgs(record.toNote(), null)])
        )
        .build();
      const inferred = await client.executeTransaction(
        wallet.id(),
        inferredRequest
      );

      const pinnedRequest = new sdk.TransactionRequestBuilder()
        .withExplicitInputNotes(
          new sdk.InputNoteAndArgsArray([
            new sdk.InputNoteAndArgs(
              sdk.InputNote.unauthenticated(record.toNote()),
              null
            ),
          ])
        )
        .build();
      const pinned = await client.executeTransaction(
        wallet.id(),
        pinnedRequest
      );

      const inferredNote = inferred
        .executedTransaction()
        .inputNotes()
        .getNote(0);
      const pinnedNote = pinned.executedTransaction().inputNotes().getNote(0);

      return {
        noteId: createdNoteId,
        inferredCount: inferred.executedTransaction().inputNotes().numNotes(),
        pinnedCount: pinned.executedTransaction().inputNotes().numNotes(),
        inferredNoteId: inferredNote.id().toString(),
        pinnedNoteId: pinnedNote.id().toString(),
        inferredAuthenticated: !!inferredNote.proof(),
        pinnedAuthenticated: !!pinnedNote.proof(),
      };
    });

    expect(result.inferredCount).toEqual(1);
    expect(result.pinnedCount).toEqual(1);
    expect(result.inferredNoteId).toEqual(result.noteId);
    expect(result.pinnedNoteId).toEqual(result.noteId);
    // Same note, same store: the mode differs only because the request pinned it.
    expect(result.inferredAuthenticated).toBe(true);
    expect(result.pinnedAuthenticated).toBe(false);
  });
});
