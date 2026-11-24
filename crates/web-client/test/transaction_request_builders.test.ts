// @ts-nocheck
import { test, expect } from "./test-setup";

test("ignoreInvalidInputNotes lets a consume batch skip a note the account cannot consume", async ({
  run,
}) => {
  const result = await run(async ({ client, sdk, helpers }) => {
    const { wallet, faucet } = await helpers.setupWalletAndFaucet();
    const other = await client.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512
    );
    const mine = await helpers.mockMint(wallet.id(), faucet.id());
    const foreign = await helpers.mockMint(other.id(), faucet.id());

    // The foreign note is targeted at another account, so consuming it fails in the kernel.
    const noteAndArgs = async () => {
      const foreignNote = (
        await client.getInputNote(foreign.createdNoteId)
      ).toNote();
      const ownNote = (await client.getInputNote(mine.createdNoteId)).toNote();
      return new sdk.NoteAndArgsArray([
        new sdk.NoteAndArgs(foreignNote),
        new sdk.NoteAndArgs(ownNote),
      ]);
    };

    const strict = new sdk.TransactionRequestBuilder()
      .withInputNotes(await noteAndArgs())
      .build();
    let strictError = null;
    try {
      await client.executeTransaction(wallet.id(), strict);
    } catch (e) {
      strictError = String(e);
    }

    const lenient = new sdk.TransactionRequestBuilder()
      .withInputNotes(await noteAndArgs())
      .ignoreInvalidInputNotes()
      .build();
    const executed = (
      await client.executeTransaction(wallet.id(), lenient)
    ).executedTransaction();
    return {
      strictFlag: strict.ignoresInvalidInputNotes(),
      lenientFlag: lenient.ignoresInvalidInputNotes(),
      restoredFlag: sdk.TransactionRequest.deserialize(
        lenient.serialize()
      ).ignoresInvalidInputNotes(),
      strictError,
      consumed: executed
        .inputNotes()
        .notes()
        .map((n) => n.id().toString()),
      own: mine.createdNoteId,
    };
  });
  expect(result.strictFlag).toBe(false);
  expect(result.lenientFlag).toBe(true);
  expect(result.restoredFlag).toBe(true);
  expect(result.strictError).not.toBeNull();
  expect(result.consumed).toEqual([result.own]);
});

test("withAccountCodeUpgrade and buildAccountCodeUpgrade carry the new code", async ({
  run,
}) => {
  const result = await run(async ({ sdk, helpers }) => {
    const { wallet } = await helpers.setupWalletAndFaucet();
    const code = wallet.code();
    const commitment = code.commitment().toHex();

    const plain = new sdk.TransactionRequestBuilder().build();
    const attached = new sdk.TransactionRequestBuilder()
      .withAccountCodeUpgrade(code)
      .build();
    const upgrade = new sdk.TransactionRequestBuilder().buildAccountCodeUpgrade(
      code
    );
    const restored = sdk.TransactionRequest.deserialize(upgrade.serialize());
    return {
      commitment,
      plain: plain.accountCodeUpgrade() ?? null,
      attached: attached.accountCodeUpgrade()?.commitment().toHex(),
      upgrade: upgrade.accountCodeUpgrade()?.commitment().toHex(),
      scriptArg: upgrade.scriptArg()?.toHex(),
      restored: restored.accountCodeUpgrade()?.commitment().toHex(),
    };
  });
  expect(result.plain).toBeNull();
  expect(result.attached).toBe(result.commitment);
  expect(result.upgrade).toBe(result.commitment);
  expect(result.restored).toBe(result.commitment);
  expect(result.scriptArg).toBe(result.commitment);
});

test("withExpectedNtxScripts declares the scripts a request expects the network to run", async ({
  run,
}) => {
  const result = await run(async ({ sdk }) => {
    const scripts = () => new sdk.NoteScriptArray([sdk.NoteScript.p2id()]);
    const request = new sdk.TransactionRequestBuilder()
      .withExpectedNtxScripts(scripts())
      .build();
    const restored = sdk.TransactionRequest.deserialize(request.serialize());
    const roots = (r) => r.expectedNtxScripts().map((s) => s.root().toHex());
    return {
      none: new sdk.TransactionRequestBuilder().build().expectedNtxScripts()
        .length,
      declared: roots(request),
      restored: roots(restored),
      p2id: sdk.NoteScript.p2id().root().toHex(),
    };
  });
  expect(result.none).toBe(0);
  expect(result.declared).toEqual([result.p2id]);
  expect(result.restored).toEqual([result.p2id]);
});

test("newRegisterNoteScriptsTransactionRequest emits one public note per script and executes", async ({
  run,
}) => {
  const result = await run(async ({ client, sdk, helpers }) => {
    const { wallet } = await helpers.setupWalletAndFaucet();
    const request = await client.newRegisterNoteScriptsTransactionRequest(
      wallet.id(),
      new sdk.NoteScriptArray([sdk.NoteScript.p2id(), sdk.NoteScript.burn()])
    );
    const notes = request.expectedOutputOwnNotes();
    const executed = (
      await client.executeTransaction(wallet.id(), request)
    ).executedTransaction();
    return {
      count: notes.length,
      types: notes.map((n) => n.metadata().noteType()),
      roots: notes.map((n) => n.recipient().script().root().toHex()),
      expected: [sdk.NoteScript.p2id(), sdk.NoteScript.burn()].map((s) =>
        s.root().toHex()
      ),
      executedOutputs: executed.outputNotes().notes().length,
      public: sdk.NoteType.Public,
    };
  });
  expect(result.count).toBe(2);
  expect(result.types).toEqual([result.public, result.public]);
  expect(result.roots).toEqual(result.expected);
  expect(result.executedOutputs).toBe(2);
});
