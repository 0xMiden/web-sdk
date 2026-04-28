import test, { getProverUrl } from "./playwright.global.setup";
import { expect, Page } from "@playwright/test";
import {
  consumeTransaction,
  mintAndConsumeTransaction,
  mintTransaction,
  sendTransaction,
  setupWalletAndFaucet,
  setupConsumedNote,
} from "./webClientTestUtils";
import {
  Account,
  TransactionRecord,
  Note,
} from "../dist/crates/miden_client_web";

// Used to gate "with remote prover" test variants. When no prover URL is
// configured (the default for the regular `Integration tests` shards),
// these variants would silently fall back to local proving and duplicate
// their non-remote siblings — burning 5+ minutes per duplicate. The
// dedicated `Integration tests for remote prover` job exercises them
// properly with the actual remote prover.
const hasRemoteProver = !!getProverUrl();

// NEW_SEND_TRANSACTION TESTS
// =======================================================================================================

interface SendTransactionUpdate {
  senderAccountBalance: string;
  changedTargetBalance: string;
}

export const sendTransactionTest = async (
  testingPage: Page,
  senderAccount: string,
  targetAccount: string,
  faucetAccount: string
): Promise<SendTransactionUpdate> => {
  return await testingPage.evaluate(
    async ({ senderAccount, targetAccount, faucetAccount }) => {
      const client = window.client;

      await client.syncState();

      const targetAccountId = window.AccountId.fromHex(targetAccount);
      const senderAccountId = window.AccountId.fromHex(senderAccount);
      const faucetAccountId = window.AccountId.fromHex(faucetAccount);

      const changedSenderAccount = await client.getAccount(senderAccountId);
      const changedTargetAccount = await client.getAccount(targetAccountId);

      return {
        senderAccountBalance: changedSenderAccount!
          .vault()
          .getBalance(faucetAccountId)
          .toString(),
        changedTargetBalance: changedTargetAccount!
          .vault()
          .getBalance(faucetAccountId)
          .toString(),
      };
    },
    {
      senderAccount,
      targetAccount,
      faucetAccount,
    }
  );
};

test.describe("send transaction tests", () => {
  const testCases = [
    { flag: false, description: "send transaction completes successfully" },
    {
      flag: true,
      description: "send transaction with remote prover completes successfully",
    },
  ];

  testCases.forEach(({ flag, description }) => {
    test(description, async ({ page }) => {
      test.skip(flag && !hasRemoteProver, "no remote prover configured");
      test.setTimeout(900000);
      const { accountId: senderAccountId, faucetId } =
        await setupWalletAndFaucet(page);
      const { accountId: targetAccountId } = await setupWalletAndFaucet(page);
      const recallHeight = 100;
      let createdSendNotes = await sendTransaction(
        page,
        senderAccountId,
        targetAccountId,
        faucetId,
        recallHeight,
        flag
      );

      await consumeTransaction(
        page,
        targetAccountId,
        faucetId,
        createdSendNotes[0],
        flag
      );
      const result = await sendTransactionTest(
        page,
        senderAccountId,
        targetAccountId,
        faucetId
      );

      expect(result.senderAccountBalance).toEqual("900");
      expect(result.changedTargetBalance).toEqual("100");
    });
  });
});

// CUSTOM_TRANSACTIONS TESTS
// =======================================================================================================

export const customTransaction = async (
  testingPage: Page,
  assertedValue: string,
  withRemoteProver: boolean
): Promise<void> => {
  return await testingPage.evaluate(
    async ({ assertedValue, withRemoteProver }) => {
      const client = window.client;

      const walletAccount = await client.newWallet(
        window.AccountStorageMode.private(),
        false,
        window.AuthScheme.AuthRpoFalcon512
      );
      const faucetAccount = await client.newFaucet(
        window.AccountStorageMode.private(),
        false,
        "DAG",
        8,
        BigInt(10000000),
        window.AuthScheme.AuthRpoFalcon512
      );
      await client.syncState();

      // Creating Custom Note which needs the following:
      // - Note Assets
      // - Note Metadata
      // - Note Recipient

      // Creating NOTE_ARGS
      let felt1 = new window.Felt(BigInt(9));
      let felt2 = new window.Felt(BigInt(12));
      let felt3 = new window.Felt(BigInt(18));
      let felt4 = new window.Felt(BigInt(3));
      let felt5 = new window.Felt(BigInt(3));
      let felt6 = new window.Felt(BigInt(18));
      let felt7 = new window.Felt(BigInt(12));
      let felt8 = new window.Felt(BigInt(9));

      let noteArgs = [felt1, felt2, felt3, felt4, felt5, felt6, felt7, felt8];
      let feltArray = new window.MidenArrays.FeltArray();

      noteArgs.forEach((felt) => {
        feltArray.push(felt);
      });

      let noteAssets = new window.NoteAssets([
        new window.FungibleAsset(faucetAccount.id(), BigInt(10)),
      ]);

      let noteMetadata = new window.NoteMetadata(
        faucetAccount.id(),
        window.NoteType.Private,
        window.NoteTag.withAccountTarget(walletAccount.id())
      );

      let memAddress = "1000";
      let memAddress2 = "1004";
      let expectedNoteArg1 = window.Word.newFromFelts(
        noteArgs.slice(0, 4)
      ).toHex();
      let expectedNoteArg2 = window.Word.newFromFelts(
        noteArgs.slice(4, 8)
      ).toHex();

      let noteScript = `
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

                # read the target account ID from the note storage
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

      let builder = client.createCodeBuilder();
      let compiledNoteScript = builder.compileNoteScript(noteScript);
      let noteStorage = new window.NoteStorage(
        new window.MidenArrays.FeltArray([
          walletAccount.id().suffix(),
          walletAccount.id().prefix(),
        ])
      );

      const serialNum = new window.Word(
        new BigUint64Array([BigInt(1), BigInt(2), BigInt(3), BigInt(4)])
      );

      let noteRecipient = new window.NoteRecipient(
        serialNum,
        compiledNoteScript,
        noteStorage
      );

      let note = new window.Note(noteAssets, noteMetadata, noteRecipient);

      const prover =
        withRemoteProver && window.remoteProverUrl != null
          ? window.remoteProverInstance
          : undefined;

      // Creating First Custom Transaction Request to Mint the Custom Note

      let noteArray = new window.NoteArray();
      noteArray.push(note);
      let transactionRequest = new window.TransactionRequestBuilder()
        .withOwnOutputNotes(noteArray)
        .build();

      // Execute and Submit Transaction
      let transactionUpdate = await window.helpers.executeAndApplyTransaction(
        faucetAccount.id(),
        transactionRequest,
        prover
      );

      await window.helpers.waitForTransaction(
        transactionUpdate.executedTransaction().id().toHex()
      );

      // Just like in the miden test, you can modify this script to get the execution to fail
      // by modifying the assert
      let txScript = `
            begin
                push.0 push.${assertedValue}
                # => [0, ${assertedValue}]
                assert_eq
            end
        `;

      // Creating Second Custom Transaction Request to Consume Custom Note
      // with Invalid/Valid Transaction Script
      let transactionScript = await builder.compileTxScript(txScript);
      let noteArgsCommitment = window.Poseidon2.hashElements(feltArray);

      let noteAndArgs = new window.NoteAndArgs(note, noteArgsCommitment);
      let noteAndArgsArray = new window.NoteAndArgsArray([noteAndArgs]);

      let adviceMap = new window.AdviceMap();
      let noteArgsCommitment2 = window.Poseidon2.hashElements(feltArray);

      adviceMap.insert(noteArgsCommitment2, feltArray);

      let transactionRequest2 = new window.TransactionRequestBuilder()
        .withInputNotes(noteAndArgsArray)
        .withCustomScript(transactionScript)
        .extendAdviceMap(adviceMap)
        .build();

      // Execute and Submit Transaction
      let transactionUpdate2 = await window.helpers.executeAndApplyTransaction(
        walletAccount.id(),
        transactionRequest2,
        prover
      );

      await window.helpers.waitForTransaction(
        transactionUpdate2.executedTransaction().id().toHex()
      );
    },
    {
      assertedValue,
      withRemoteProver,
    }
  );
};

test.describe("custom transaction tests", () => {
  test("custom transaction completes successfully", async ({ page }) => {
    await expect(customTransaction(page, "0", false)).resolves.toBeUndefined();
  });

  test("custom transaction fails", async ({ page }) => {
    await expect(customTransaction(page, "1", false)).rejects.toThrow();
  });

  test("custom transaction with remote prover completes successfully", async ({
    page,
  }) => {
    test.skip(!hasRemoteProver, "no remote prover configured");
    // TODO: hotfix CI failure, we should investigate slow prover tests further.
    test.slow();
    await expect(customTransaction(page, "0", true)).resolves.toBeUndefined();
  });
});

// DISCARDED TRANSACTIONS TESTS
// ================================================================================================

interface DiscardedTransactionUpdate {
  discardedTransactions: TransactionRecord[];
  commitmentBeforeTx: string;
  commitmentAfterTx: string;
  commitmentAfterDiscardedTx: string;
}

export const discardedTransaction = async (
  testingPage: Page
): Promise<DiscardedTransactionUpdate> => {
  return await testingPage.evaluate(async () => {
    const client = window.client;

    const senderAccount = await client.newWallet(
      window.AccountStorageMode.private(),
      true,
      window.AuthScheme.AuthRpoFalcon512
    );
    const targetAccount = await client.newWallet(
      window.AccountStorageMode.private(),
      false,
      window.AuthScheme.AuthRpoFalcon512
    );
    const faucetAccount = await client.newFaucet(
      window.AccountStorageMode.private(),
      false,
      "DAG",
      8,
      BigInt(10000000),
      window.AuthScheme.AuthRpoFalcon512
    );
    await client.syncState();

    let mintTransactionRequest = client.newMintTransactionRequest(
      senderAccount.id(),
      faucetAccount.id(),
      window.NoteType.Private,
      BigInt(1000)
    );
    let mintTransactionUpdate = await window.helpers.executeAndApplyTransaction(
      faucetAccount.id(),
      mintTransactionRequest
    );
    let createdNotes = mintTransactionUpdate
      .executedTransaction()
      .outputNotes()
      .notes();
    let createdNoteIds = createdNotes.map((note: Note) => note.id().toString());
    await window.helpers.waitForTransaction(
      mintTransactionUpdate.executedTransaction().id().toHex()
    );

    let notes: Note[] = [];
    for (const _noteId of createdNoteIds) {
      const inputNoteRecord = await client.getInputNote(_noteId);

      if (!inputNoteRecord) {
        throw new Error(`Note with ID ${_noteId} not found`);
      }

      const note = inputNoteRecord.toNote();
      notes.push(note);
    }
    const senderConsumeTransactionRequest =
      client.newConsumeTransactionRequest(notes);
    let senderConsumeTransactionUpdate =
      await window.helpers.executeAndApplyTransaction(
        senderAccount.id(),
        senderConsumeTransactionRequest
      );
    await window.helpers.waitForTransaction(
      senderConsumeTransactionUpdate.executedTransaction().id().toHex()
    );

    let sendTransactionRequest = client.newSendTransactionRequest(
      senderAccount.id(),
      targetAccount.id(),
      faucetAccount.id(),
      window.NoteType.Private,
      BigInt(100),
      1,
      null
    );
    let sendTransactionUpdate = await window.helpers.executeAndApplyTransaction(
      senderAccount.id(),
      sendTransactionRequest
    );
    let sendCreatedNotes = sendTransactionUpdate
      .executedTransaction()
      .outputNotes()
      .notes();
    let sendCreatedNoteIds = sendCreatedNotes.map((note: Note) =>
      note.id().toString()
    );

    await window.helpers.waitForTransaction(
      sendTransactionUpdate.executedTransaction().id().toHex()
    );

    const inputNoteRecord = await client.getInputNote(sendCreatedNoteIds[0]);
    if (!inputNoteRecord) {
      throw new Error(`Note with ID ${sendCreatedNoteIds[0]} not found`);
    }

    const note = inputNoteRecord.toNote();
    let noteAndArgs = new window.NoteAndArgs(note, null);
    let noteAndArgsArray = new window.NoteAndArgsArray([noteAndArgs]);
    const consumeTransactionRequest = new window.TransactionRequestBuilder()
      .withInputNotes(noteAndArgsArray)
      .build();

    let preConsumeStore = await window.exportStore(window.storeName);

    // Sender retrieves the note

    notes = [];
    for (const _noteId of sendCreatedNoteIds) {
      const inputNoteRecord = await client.getInputNote(_noteId);

      if (!inputNoteRecord) {
        throw new Error(`Note with ID ${_noteId} not found`);
      }

      const note = inputNoteRecord.toNote();
      notes.push(note);
    }
    let senderTxRequest = client.newConsumeTransactionRequest(notes);
    let senderTxResult = await window.helpers.executeAndApplyTransaction(
      senderAccount.id(),
      senderTxRequest
    );
    await window.helpers.waitForTransaction(
      senderTxResult.executedTransaction().id().toHex()
    );

    await window.importStore(window.storeName, preConsumeStore);

    // Get the account state before the transaction is applied
    const accountStateBeforeTx = (await client.getAccount(
      targetAccount.id()
    )) as Account;
    if (!accountStateBeforeTx) {
      throw new Error("Failed to get account state before transaction");
    }

    // Target tries consuming but the transaction will not be submitted
    let targetPipeline = await client.executeTransaction(
      targetAccount.id(),
      consumeTransactionRequest
    );
    const submissionHeight = (await client.getSyncHeight()) + 1;
    await client.applyTransaction(targetPipeline, submissionHeight);
    // Get the account state after the transaction is applied
    const accountStateAfterTx = (await client.getAccount(
      targetAccount.id()
    )) as Account;
    if (!accountStateAfterTx) {
      throw new Error("Failed to get account state after transaction");
    }

    await client.syncState();

    const allTransactions = await client.getTransactions(
      window.TransactionFilter.all()
    );

    const discardedTransactions = allTransactions.filter(
      (tx: TransactionRecord) => tx.transactionStatus().isDiscarded()
    );

    // Get the account state after the discarded transactions are applied
    const accountStateAfterDiscardedTx = (await client.getAccount(
      targetAccount.id()
    )) as Account;
    if (!accountStateAfterDiscardedTx) {
      throw new Error(
        "Failed to get account state after discarded transaction"
      );
    }

    // Perform a `.to_commitment()` check on each account
    const commitmentBeforeTx = accountStateBeforeTx.to_commitment().toHex();
    const commitmentAfterTx = accountStateAfterTx.to_commitment().toHex();
    const commitmentAfterDiscardedTx = accountStateAfterDiscardedTx
      .to_commitment()
      .toHex();

    return {
      discardedTransactions: discardedTransactions,
      commitmentBeforeTx,
      commitmentAfterTx,
      commitmentAfterDiscardedTx,
    };
  });
};

test.describe("discarded_transaction tests", () => {
  test("transaction gets discarded", async ({ page }) => {
    test.slow();
    const result = await discardedTransaction(page);

    expect(result.discardedTransactions.length).toEqual(1);
    expect(result.commitmentBeforeTx).toEqual(
      result.commitmentAfterDiscardedTx
    );
    expect(result.commitmentAfterTx).not.toEqual(
      result.commitmentAfterDiscardedTx
    );
  });
});

// NETWORK TRANSACTION TESTS
// ================================================================================================

export const counterAccountComponent = async (
  testingPage: Page
): Promise<{
  finalCounter?: string;
  hasCounterComponent: boolean;
}> => {
  return await testingPage.evaluate(async () => {
    const COUNTER_SLOT_NAME = "miden::testing::counter_contract::counter";

    const accountCode = `
        use miden::protocol::active_account
        use miden::protocol::native_account
        use miden::core::word
        use miden::core::sys

        const COUNTER_SLOT = word("${COUNTER_SLOT_NAME}")

        # => []
        pub proc get_count
            push.COUNTER_SLOT[0..2] exec.active_account::get_item
            exec.sys::truncate_stack
        end

        # => []
        pub proc increment_count
            push.COUNTER_SLOT[0..2] exec.active_account::get_item
            # => [count]
            push.1 add
            # => [count+1]
            push.COUNTER_SLOT[0..2] exec.native_account::set_item
            # => []
            exec.sys::truncate_stack
            # => []
        end
      `;
    const txScriptCode = `
        use external_contract::counter_contract
        begin
            call.counter_contract::increment_count
        end
      `;
    // miden-standards 0.14.5+ requires note scripts to use a single public
    // procedure annotated with @note_script (compileTxScript still accepts
    // the legacy begin/end form).
    const noteScriptCode = `
        use external_contract::counter_contract
        @note_script
        pub proc main
            call.counter_contract::increment_count
        end
      `;
    const client = window.client;

    // Create counter account
    let emptyStorageSlot = window.StorageSlot.emptyValue(COUNTER_SLOT_NAME);

    let builder = client.createCodeBuilder();

    let accountComponentCode = builder.compileAccountComponentCode(accountCode);
    let counterAccountComponent = window.AccountComponent.compile(
      accountComponentCode,
      [emptyStorageSlot]
    ).withSupportsAllTypes();

    const walletSeed = new Uint8Array(32);
    crypto.getRandomValues(walletSeed);

    let accountBuilderResult = new window.AccountBuilder(walletSeed)
      .storageMode(window.AccountStorageMode.network())
      .withNoAuthComponent()
      .withComponent(counterAccountComponent)
      .build();

    await client.newAccount(accountBuilderResult.account, false);

    const nativeAccount = await client.newWallet(
      window.AccountStorageMode.private(),
      false,
      window.AuthScheme.AuthRpoFalcon512
    );

    await client.syncState();

    // Deploy counter account
    let accountComponentLib = builder.buildLibrary(
      "external_contract::counter_contract",
      accountCode
    );
    builder.linkDynamicLibrary(accountComponentLib);
    let txScript = builder.compileTxScript(txScriptCode);

    let txIncrementRequest = new window.TransactionRequestBuilder()
      .withCustomScript(txScript)
      .build();

    let txUpdate = await window.helpers.executeAndApplyTransaction(
      accountBuilderResult.account.id(),
      txIncrementRequest
    );
    await window.helpers.waitForTransaction(
      txUpdate.executedTransaction().id().toHex()
    );

    // Create transaction with network note
    let compiledNoteScript = await builder.compileNoteScript(noteScriptCode);

    let noteStorage = new window.NoteStorage(
      new window.MidenArrays.FeltArray([])
    );

    const randomInts = Array.from({ length: 4 }, () =>
      Math.floor(Math.random() * 100000)
    );

    let serialNum = new window.Word(new BigUint64Array(randomInts.map(BigInt)));

    let noteRecipient = new window.NoteRecipient(
      serialNum,
      compiledNoteScript,
      noteStorage
    );

    let noteAssets = new window.NoteAssets([]);

    // Create network account target attachment so the node knows to consume this note
    // with the network account (counter account)
    let networkTargetAttachment = window.NoteAttachment.newNetworkAccountTarget(
      accountBuilderResult.account.id(),
      window.NoteExecutionHint.always()
    );

    let noteMetadata = new window.NoteMetadata(
      nativeAccount.id(),
      window.NoteType.Public,
      window.NoteTag.withAccountTarget(accountBuilderResult.account.id())
    ).withAttachment(networkTargetAttachment);

    let note = new window.Note(noteAssets, noteMetadata, noteRecipient);

    let transactionRequest = new window.TransactionRequestBuilder()
      .withOwnOutputNotes(new window.NoteArray([note]))
      .build();

    let transactionUpdate = await window.helpers.executeAndApplyTransaction(
      nativeAccount.id(),
      transactionRequest
    );
    await window.helpers.waitForTransaction(
      transactionUpdate.executedTransaction().id().toHex()
    );

    // Wait for network account to update
    await window.helpers.waitForBlocks(2);

    let account = await client.getAccount(accountBuilderResult.account.id());
    let counter = account?.storage().getItem(COUNTER_SLOT_NAME)?.toHex();
    let finalCounter = counter?.replace(/^0x/, "").replace(/^0+|0+$/g, "");

    let code = account?.code();
    let hasCounterComponent = code
      ? counterAccountComponent
          .getProcedures()
          .every((procedure) => code.hasProcedure(procedure.digest))
      : false;

    return {
      finalCounter,
      hasCounterComponent,
    };
  });
};

test.describe("counter account component tests", () => {
  test("counter account component transaction completes successfully", async ({
    page,
  }) => {
    let { finalCounter, hasCounterComponent } =
      await counterAccountComponent(page);
    expect(finalCounter).toEqual("2");
    expect(hasCounterComponent).toBe(true);
  });
});
