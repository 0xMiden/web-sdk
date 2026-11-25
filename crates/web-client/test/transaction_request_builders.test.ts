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

test("a custom note script registration request is submitted and the script is declared for network execution", async ({
  run,
}) => {
  const result = await run(async ({ client, sdk, helpers }) => {
    const { wallet } = await helpers.setupWalletAndFaucet();
    const builder = await client.createCodeBuilder();
    // The browser build consumes a handle passed by value, so every use compiles its own copy.
    const custom = async () =>
      await builder.compileNoteScript(`
        @note_script
        pub proc main
          push.7 drop
        end
      `);
    const customRoot = (await custom()).root().toHex();
    const register = await client.newRegisterNoteScriptsTransactionRequest(
      wallet.id(),
      new sdk.NoteScriptArray([await custom()])
    );
    const roots = register
      .expectedOutputOwnNotes()
      .map((n) => n.recipient().script().root().toHex());
    const txId = await client.submitNewTransaction(wallet.id(), register);
    await client.proveBlock();
    const declared = new sdk.TransactionRequestBuilder()
      .withExpectedNtxScripts(new sdk.NoteScriptArray([await custom()]))
      .build()
      .expectedNtxScripts()
      .map((s) => s.root().toHex());
    return {
      custom: customRoot,
      roots,
      submitted: txId.toHex().length,
      declared,
    };
  });
  expect(result.roots).toEqual([result.custom]);
  expect(result.submitted).toBeGreaterThan(0);
  expect(result.declared).toEqual([result.custom]);
});

test("extendMerkleStore carries extra Merkle store nodes in the built request", async ({
  run,
}) => {
  const result = await run(async ({ sdk }) => {
    const word = (n) => new sdk.Word(sdk.u64Array([n, n + 1, n + 2, n + 3]));
    const nodes = () =>
      new sdk.InnerNodeInfoArray([
        new sdk.InnerNodeInfo(word(10), word(20), word(30)),
        new sdk.InnerNodeInfo(word(40), word(50), word(60)),
      ]);
    const request = new sdk.TransactionRequestBuilder()
      .extendMerkleStore(nodes())
      .build();
    const restored = sdk.TransactionRequest.deserialize(request.serialize());
    const read = (r) =>
      r
        .merkleStoreInnerNodes()
        .map((n) => [n.value().toHex(), n.left().toHex(), n.right().toHex()])
        .sort();
    return {
      none: new sdk.TransactionRequestBuilder().build().merkleStoreInnerNodes()
        .length,
      added: read(request),
      restored: read(restored),
      expected: [
        [word(10), word(20), word(30)].map((w) => w.toHex()),
        [word(40), word(50), word(60)].map((w) => w.toHex()),
      ].sort(),
    };
  });
  expect(result.none).toBe(0);
  expect(result.added).toEqual(result.expected);
  expect(result.restored).toEqual(result.expected);
});

test("Eidos.merge computes the Merkle inner node, not hashElements over the children", async ({
  run,
}) => {
  const result = await run(async ({ sdk }) => {
    const left = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
    const right = new sdk.Word(sdk.u64Array([5, 6, 7, 8]));
    return {
      merge: sdk.Eidos.merge(left, right).toHex(),
      hashElements: sdk.Eidos.hashElements(
        new sdk.FeltArray(
          [1, 2, 3, 4, 5, 6, 7, 8].map((v) => new sdk.Felt(BigInt(v)))
        )
      ).toHex(),
    };
  });
  // Reference values from miden-crypto 1.0.0-rc.0 `Eidos::merge` and `Eidos::hash_elements`.
  expect(result.merge).toBe(
    "0xcdbf8833f8b9a46c760d63109a17f5359945e35edbe38f252b9e9ce638af0977"
  );
  expect(result.hashElements).toBe(
    "0x0cde6d494f9c540ae1d67bc839565b0fcc774f6cdafc300baa83ecf9c652c25b"
  );
});
