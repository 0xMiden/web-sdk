// @ts-nocheck
import { test, expect } from "./test-setup";

test("explicit input notes accumulate with optional args and retain their modes", async ({
  run,
}) => {
  const result = await run(async ({ client, sdk, helpers }) => {
    const { wallet, faucet } = await helpers.setupWalletAndFaucet();
    const records = [];
    for (let i = 0; i < 3; i++) {
      const { createdNoteId } = await helpers.mockMint(
        wallet.id(),
        faucet.id()
      );
      records.push(await client.getInputNote(createdNoteId));
    }
    const authenticated = sdk.InputNote.authenticated(
      records[0].toNote(),
      records[0].inclusionProof()
    );
    // Both of these notes also have proofs in the store, but their explicit
    // unauthenticated mode must win over the store's classification.
    const omittedArgs = sdk.InputNote.unauthenticated(records[1].toNote());
    const nullArgs = sdk.InputNote.unauthenticated(records[2].toNote());
    const args = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
    const expectedArgs = args.toHex();
    const request = new sdk.TransactionRequestBuilder()
      .withExplicitInputNote(authenticated, args)
      .withExplicitInputNote(omittedArgs)
      .withExplicitInputNote(nullArgs, null)
      .build();
    const restored = sdk.TransactionRequest.deserialize(request.serialize());
    const executed = (
      await client.executeTransaction(wallet.id(), restored)
    ).executedTransaction();
    const inputs = executed.inputNotes().notes();
    const txArgs = executed.txArgs();
    return {
      ids: inputs.map((note) => note.id().toString()),
      callerIds: [authenticated, omittedArgs, nullArgs].map((note) =>
        note.id().toString()
      ),
      authenticated: inputs.map((note) => note.proof() != null),
      args: inputs.map(
        (note) => txArgs.getNoteArgs(note.id())?.toHex() ?? null
      ),
      expectedArgs,
    };
  });
  expect(result.ids).toEqual(result.callerIds);
  expect(result.authenticated).toEqual([true, false, false]);
  expect(result.args).toEqual([result.expectedArgs, null, null]);
});
