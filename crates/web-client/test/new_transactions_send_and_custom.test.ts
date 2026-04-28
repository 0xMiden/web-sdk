// @ts-nocheck
// Send + custom transaction tests. Split from new_transactions.test.ts to
// balance shard-1 wall clock — the mint/consume/storage/prover describes
// live in new_transactions_mint_and_misc.test.ts.
// Platform-agnostic (browser + Node.js).
import { test, expect } from "./test-setup";

// NEW_SEND_TRANSACTION TESTS
// =======================================================================================================

test.describe("send transaction tests", () => {
  test("send transaction completes successfully", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: sender, faucet } = await helpers.setupWalletAndFaucet();
      const target = await client.newWallet(
        sdk.AccountStorageMode.private(),
        true,
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const { sendCreatedNoteIds } = await helpers.mockSend(
        sender.id(),
        target.id(),
        faucet.id(),
        { recallHeight: 100 }
      );

      // Consume the sent note on the target account
      await helpers.mockConsume(target.id(), sendCreatedNoteIds[0]);

      const senderAccount = await client.getAccount(sender.id());
      const senderBalance = senderAccount
        .vault()
        .getBalance(faucet.id())
        .toString();

      const targetAccount = await client.getAccount(target.id());
      const targetBalance = targetAccount
        .vault()
        .getBalance(faucet.id())
        .toString();

      return { senderBalance, targetBalance };
    });

    expect(result.senderBalance).toEqual("900");
    expect(result.targetBalance).toEqual("100");
  });

  test("sends a public P2ID note, then receiver consumes it using the note's id", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: sender, faucet } = await helpers.setupWalletAndFaucet();
      const receiver = await client.newWallet(
        sdk.AccountStorageMode.private(),
        true,
        sdk.AuthScheme.AuthRpoFalcon512
      );

      // Fund sender
      await helpers.mockMintAndConsume(sender.id(), faucet.id());

      // Send public note
      const sendRequest = await client.newSendTransactionRequest(
        sender.id(),
        receiver.id(),
        faucet.id(),
        sdk.NoteType.Public,
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

      // Get the sent note ID
      const [sendTx] = await client.getTransactions(
        sdk.TransactionFilter.ids([sendTxId])
      );
      const sentNoteId = sendTx.outputNotes().notes()[0].id().toString();

      // Receiver consumes by note ID
      const inputNote = await client.getInputNote(sentNoteId);
      const note = inputNote.toNote();
      const consumeRequest = client.newConsumeTransactionRequest([note]);
      await client.submitNewTransaction(receiver.id(), consumeRequest);
      await client.proveBlock();
      await client.syncState();

      const receiverAccount = await client.getAccount(receiver.id());
      const balance = receiverAccount
        .vault()
        .getBalance(faucet.id())
        .toString();

      return { balance };
    });

    expect(result.balance).toEqual("100");
  });
});

// CUSTOM_TRANSACTIONS TESTS
// =======================================================================================================

test.describe("custom transaction tests", () => {
  test("custom transaction completes successfully", async ({ run }) => {
    await run(async ({ client, sdk }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        false,
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      // Creating NOTE_ARGS
      // Each FeltArray construction consumes the Felt objects (wasm_bindgen
      // by-value), so we need a factory to create fresh instances each time.
      const noteArgValues = [9, 12, 18, 3, 3, 18, 12, 9];
      const makeNoteArgs = () =>
        noteArgValues.map((v) => new sdk.Felt(sdk.u64(v)));

      const noteAssets = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), sdk.u64(10)),
      ]);

      const noteMetadata = new sdk.NoteMetadata(
        faucet.id(),
        sdk.NoteType.Private,
        sdk.NoteTag.withAccountTarget(wallet.id())
      );

      const memAddress = "1000";
      const memAddress2 = "1004";
      const expectedNoteArg1 = sdk.Word.newFromFelts(
        makeNoteArgs().slice(0, 4)
      ).toHex();
      const expectedNoteArg2 = sdk.Word.newFromFelts(
        makeNoteArgs().slice(4, 8)
      ).toHex();

      const noteScript = `
        # Custom P2ID note script
        #
        # This note script asserts that the note args are exactly the same as passed
        # (currently defined as {expected_note_arg_1} and {expected_note_arg_2}).
        # Since the args are too big to fit in a single note arg, we provide them via advice inputs and
        # address them via their commitment (noted as NOTE_ARG)
        # This note script is based off of the P2ID note script because notes currently need to have
        # assets, otherwise it could have been boiled down to the assert.

        use miden::protocol::active_account
        use miden::protocol::account_id
        use miden::protocol::active_note
        use miden::standards::wallets::basic->basic_wallet
        use miden::core::mem
        @note_script
        pub proc main
            # push data from the advice map into the advice stack
            adv.push_mapval
            # => [NOTE_ARG]

            # memory address where to write the data
            push.${memAddress}
            # => [target_mem_addr, NOTE_ARG_COMMITMENT]
            # number of words
            push.2
            # => [number_of_words, target_mem_addr, NOTE_ARG_COMMITMENT]
            exec.mem::pipe_preimage_to_memory
            # => [target_mem_addr']
            dropw
            # => []

            # read first word
            push.${memAddress}
            # => [data_mem_address]
            mem_loadw_le
            # => [NOTE_ARG_1]

            push.${expectedNoteArg1} assert_eqw.err="First note argument didn't match expected"
            # => []

            # read second word
            push.${memAddress2}
            # => [data_mem_address_2]
            mem_loadw_le
            # => [NOTE_ARG_2]

            push.${expectedNoteArg2} assert_eqw.err="Second note argument didn't match expected"
            # => []

            # store the note storage to memory starting at address 0
            push.0 exec.active_note::get_storage
            # => [num_storage_items, storage_ptr]

            # make sure the number of storage items is 2
            eq.2 assert.err="P2ID script expects exactly 2 note storage items"
            # => [storage_ptr]

            # read the target account id from the note storage
            dup add.1 mem_load swap mem_load
            # => [target_account_id_suffix, target_account_id_prefix]

            exec.active_account::get_id
            # => [account_id_suffix, account_id_prefix, target_account_id_suffix, target_account_id_prefix]

            # ensure account_id = target_account_id, fails otherwise
            exec.account_id::is_equal assert.err="P2ID's target account address and transaction address do not match"
            # => []

            exec.basic_wallet::add_assets_to_account
            # => []
        end
      `;

      const builder = await client.createCodeBuilder();
      const compiledNoteScript = builder.compileNoteScript(noteScript);
      const noteStorage = new sdk.NoteStorage(
        new sdk.FeltArray([wallet.id().suffix(), wallet.id().prefix()])
      );

      const serialNum = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));

      const noteRecipient = new sdk.NoteRecipient(
        serialNum,
        compiledNoteScript,
        noteStorage
      );

      const customNote = new sdk.Note(noteAssets, noteMetadata, noteRecipient);

      // Creating First Custom Transaction Request to Mint the Custom Note
      // NoteArray is a browser-only WASM wrapper; on Node.js napi accepts
      // plain JS arrays for Vec<Note> parameters.
      let ownNotes;
      if (sdk.NoteArray) {
        ownNotes = new sdk.NoteArray();
        ownNotes.push(customNote);
      } else {
        ownNotes = [customNote];
      }
      const transactionRequest = new sdk.TransactionRequestBuilder()
        .withOwnOutputNotes(ownNotes)
        .build();

      // Execute and Submit Transaction
      const mintTxId = await client.submitNewTransaction(
        faucet.id(),
        transactionRequest
      );
      await client.proveBlock();
      await client.syncState();

      // Just like in the miden test, you can modify this script to get the execution to fail
      // by modifying the assert (assertedValue = "0" means success)
      const txScript = `
        begin
            push.0 push.0
            # => [0, 0]
            assert_eq
        end
      `;

      // Creating Second Custom Transaction Request to Consume Custom Note
      // with Valid Transaction Script
      const transactionScript = await builder.compileTxScript(txScript);
      const noteArgsCommitment = sdk.Poseidon2.hashElements(
        new sdk.FeltArray(makeNoteArgs())
      );

      const noteAndArgs = new sdk.NoteAndArgs(customNote, noteArgsCommitment);

      const adviceMap = new sdk.AdviceMap();
      const noteArgsCommitment2 = sdk.Poseidon2.hashElements(
        new sdk.FeltArray(makeNoteArgs())
      );
      adviceMap.insert(noteArgsCommitment2, new sdk.FeltArray(makeNoteArgs()));

      const transactionRequest2 = new sdk.TransactionRequestBuilder()
        .withInputNotes(new sdk.NoteAndArgsArray([noteAndArgs]))
        .withCustomScript(transactionScript)
        .extendAdviceMap(adviceMap)
        .build();

      // Execute and Submit Transaction
      await client.submitNewTransaction(wallet.id(), transactionRequest2);
      await client.proveBlock();
      await client.syncState();

      return {};
    });
  });

  test("custom transaction fails with invalid assert", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        false,
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      // Creating NOTE_ARGS (factory -- see comment in first custom transaction test)
      const noteArgValues = [9, 12, 18, 3, 3, 18, 12, 9];
      const makeNoteArgs = () =>
        noteArgValues.map((v) => new sdk.Felt(sdk.u64(v)));

      const noteAssets = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), sdk.u64(10)),
      ]);

      const noteMetadata = new sdk.NoteMetadata(
        faucet.id(),
        sdk.NoteType.Private,
        sdk.NoteTag.withAccountTarget(wallet.id())
      );

      const memAddress = "1000";
      const memAddress2 = "1004";
      const expectedNoteArg1 = sdk.Word.newFromFelts(
        makeNoteArgs().slice(0, 4)
      ).toHex();
      const expectedNoteArg2 = sdk.Word.newFromFelts(
        makeNoteArgs().slice(4, 8)
      ).toHex();

      const noteScript = `
        use miden::protocol::active_account
        use miden::protocol::account_id
        use miden::protocol::active_note
        use miden::standards::wallets::basic->basic_wallet
        use miden::core::mem
        @note_script
        pub proc main
            adv.push_mapval
            push.${memAddress}
            push.2
            exec.mem::pipe_preimage_to_memory
            dropw
            push.${memAddress}
            mem_loadw_le
            push.${expectedNoteArg1} assert_eqw.err="First note argument didn't match expected"
            push.${memAddress2}
            mem_loadw_le
            push.${expectedNoteArg2} assert_eqw.err="Second note argument didn't match expected"
            push.0 exec.active_note::get_storage
            eq.2 assert.err="P2ID script expects exactly 2 note storage items"
            dup add.1 mem_load swap mem_load
            exec.active_account::get_id
            exec.account_id::is_equal assert.err="P2ID's target account address and transaction address do not match"
            exec.basic_wallet::add_assets_to_account
        end
      `;

      const builder = await client.createCodeBuilder();
      const compiledNoteScript = builder.compileNoteScript(noteScript);
      const noteStorage = new sdk.NoteStorage(
        new sdk.FeltArray([wallet.id().suffix(), wallet.id().prefix()])
      );

      const serialNum = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const noteRecipient = new sdk.NoteRecipient(
        serialNum,
        compiledNoteScript,
        noteStorage
      );
      const customNote = new sdk.Note(noteAssets, noteMetadata, noteRecipient);

      let ownNotes;
      if (sdk.NoteArray) {
        ownNotes = new sdk.NoteArray();
        ownNotes.push(customNote);
      } else {
        ownNotes = [customNote];
      }
      const transactionRequest = new sdk.TransactionRequestBuilder()
        .withOwnOutputNotes(ownNotes)
        .build();

      await client.submitNewTransaction(faucet.id(), transactionRequest);
      await client.proveBlock();
      await client.syncState();

      // Failing tx script: asserts 0 == 1
      const txScript = `
        begin
            push.0 push.1
            # => [0, 1]
            assert_eq
        end
      `;

      const transactionScript = await builder.compileTxScript(txScript);
      const noteArgsCommitment = sdk.Poseidon2.hashElements(
        new sdk.FeltArray(makeNoteArgs())
      );

      const noteAndArgs = new sdk.NoteAndArgs(customNote, noteArgsCommitment);

      const adviceMap = new sdk.AdviceMap();
      const noteArgsCommitment2 = sdk.Poseidon2.hashElements(
        new sdk.FeltArray(makeNoteArgs())
      );
      adviceMap.insert(noteArgsCommitment2, new sdk.FeltArray(makeNoteArgs()));

      const transactionRequest2 = new sdk.TransactionRequestBuilder()
        .withInputNotes(new sdk.NoteAndArgsArray([noteAndArgs]))
        .withCustomScript(transactionScript)
        .extendAdviceMap(adviceMap)
        .build();

      let threw = false;
      try {
        await client.submitNewTransaction(wallet.id(), transactionRequest2);
      } catch {
        threw = true;
      }

      return { threw };
    });

    expect(result.threw).toBe(true);
  });
});

test.describe("custom transaction with multiple output notes", () => {
  test("does not fail when output note serial numbers are unique", async ({
    run,
  }) => {
    await run(async ({ client, sdk, helpers }) => {
      const { wallet: sender, faucet } = await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(sender.id(), faucet.id());

      const amount = sdk.u64(10);
      const target = await client.newWallet(
        sdk.AccountStorageMode.private(),
        true,
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const noteAssets1 = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), amount),
      ]);
      const noteAssets2 = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), amount),
      ]);

      const noteMetadata = new sdk.NoteMetadata(
        sender.id(),
        sdk.NoteType.Public,
        sdk.NoteTag.withAccountTarget(target.id())
      );

      const serialNum1 = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const serialNum2 = new sdk.Word(sdk.u64Array([5, 6, 7, 8]));

      const p2idScript = sdk.NoteScript.p2id();

      const noteStorage = new sdk.NoteStorage(
        new sdk.FeltArray([target.id().suffix(), target.id().prefix()])
      );

      const noteRecipient1 = new sdk.NoteRecipient(
        serialNum1,
        p2idScript,
        noteStorage
      );
      const noteRecipient2 = new sdk.NoteRecipient(
        serialNum2,
        p2idScript,
        noteStorage
      );

      const note1 = new sdk.Note(noteAssets1, noteMetadata, noteRecipient1);
      const note2 = new sdk.Note(noteAssets2, noteMetadata, noteRecipient2);

      let ownNotes;
      if (sdk.NoteArray) {
        ownNotes = new sdk.NoteArray();
        [note1, note2].forEach((n) => ownNotes.push(n));
      } else {
        ownNotes = [note1, note2];
      }

      const transactionRequest = new sdk.TransactionRequestBuilder()
        .withOwnOutputNotes(ownNotes)
        .build();

      await client.submitNewTransaction(sender.id(), transactionRequest);
      await client.proveBlock();
      await client.syncState();

      return {};
    });
  });

  test("fails when output note serial numbers are the same", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: sender, faucet } = await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(sender.id(), faucet.id());

      const amount = sdk.u64(10);
      const target = await client.newWallet(
        sdk.AccountStorageMode.private(),
        true,
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const noteAssets1 = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), amount),
      ]);
      const noteAssets2 = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), amount),
      ]);

      const noteMetadata = new sdk.NoteMetadata(
        sender.id(),
        sdk.NoteType.Public,
        sdk.NoteTag.withAccountTarget(target.id())
      );

      const serialNum1 = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));

      const p2idScript = sdk.NoteScript.p2id();

      const noteStorage = new sdk.NoteStorage(
        new sdk.FeltArray([target.id().suffix(), target.id().prefix()])
      );

      const noteRecipient1 = new sdk.NoteRecipient(
        serialNum1,
        p2idScript,
        noteStorage
      );
      // Same serial number for second note
      const noteRecipient2 = new sdk.NoteRecipient(
        serialNum1,
        p2idScript,
        noteStorage
      );

      const note1 = new sdk.Note(noteAssets1, noteMetadata, noteRecipient1);
      const note2 = new sdk.Note(noteAssets2, noteMetadata, noteRecipient2);

      let ownNotes;
      if (sdk.NoteArray) {
        ownNotes = new sdk.NoteArray();
        [note1, note2].forEach((n) => ownNotes.push(n));
      } else {
        ownNotes = [note1, note2];
      }

      const transactionRequest = new sdk.TransactionRequestBuilder()
        .withOwnOutputNotes(ownNotes)
        .build();

      let threw = false;
      try {
        await client.submitNewTransaction(sender.id(), transactionRequest);
      } catch {
        threw = true;
      }

      return { threw };
    });

    expect(result.threw).toBe(true);
  });
});
