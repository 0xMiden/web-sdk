// Browser-only tests preserved from `next`.
// These rely on window.helpers.waitForBlocks / exportStore / importStore /
// network-account plumbing which are browser-only.
import test from "./playwright.global.setup";
import { expect, Page } from "@playwright/test";
import {
  consumeTransaction,
  mintTransaction,
  setupWalletAndFaucet,
} from "./webClientTestUtils";
import {
  Account,
  TransactionRecord,
  Note,
} from "../dist/crates/miden_client_web";

// ── Helpers ───────────────────────────────────────────────────────────

const submitExpiredTransaction = async (
  testingPage: Page,
  senderAccountId: string,
  targetAccountId: string,
  faucetAccountId: string
): Promise<void> => {
  return await testingPage.evaluate(
    async ({ _senderAccountId, _targetAccountId, _faucetAccountId }) => {
      const client = window.client;
      const senderAccountId = window.AccountId.fromHex(_senderAccountId);
      const targetAccountId = window.AccountId.fromHex(_targetAccountId);
      const faucetAccountId = window.AccountId.fromHex(_faucetAccountId);

      const noteAssets = new window.NoteAssets([
        new window.FungibleAsset(faucetAccountId, BigInt(10)),
      ]);
      const note = window.Note.createP2IDNote(
        senderAccountId,
        targetAccountId,
        noteAssets,
        window.NoteType.Public,
        new window.Felt(0n)
      );

      const transactionRequest = new window.TransactionRequestBuilder()
        .withOwnOutputNotes(new window.NoteArray([note]))
        .withExpirationDelta(2)
        .build();

      const transactionResult = await client.newTransaction(
        senderAccountId,
        transactionRequest
      );

      await window.helpers.waitForBlocks(3);
      await client.submitTransaction(transactionResult);
    },
    {
      _senderAccountId: senderAccountId,
      _targetAccountId: targetAccountId,
      _faucetAccountId: faucetAccountId,
    }
  );
};

const buildCustomScriptRequestWithExpiration = async (
  testingPage: Page
): Promise<void> => {
  return await testingPage.evaluate(async () => {
    const client = window.client;
    const builder = client.createScriptBuilder();
    const txScript = builder.compileTxScript(`
            use miden::contracts::auth::basic as auth_tx
            use miden::kernels::tx::prologue
            use miden::kernels::tx::memory

            @transaction_script
            pub proc main
                push.0 push.0
                assert_eq
            end
        `);

    new window.TransactionRequestBuilder()
      .withCustomScript(txScript)
      .withExpirationDelta(2)
      .build();
  });
};

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
      window.AuthScheme.AuthRpoFalcon512
    );
    const targetAccount = await client.newWallet(
      window.AccountStorageMode.private(),
      window.AuthScheme.AuthRpoFalcon512
    );
    const faucetAccount = await client.newFaucet(
      window.AccountStorageMode.private(),
      false,
      "DAG",
      "DAG",
      8,
      BigInt(10000000),
      window.AuthScheme.AuthRpoFalcon512
    );
    await client.syncState();

    let mintTransactionRequest = await client.newMintTransactionRequest(
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

    let sendTransactionRequest = await client.newSendTransactionRequest(
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
        @account_procedure
        pub proc get_count
            push.COUNTER_SLOT[0..2] exec.active_account::get_item
            exec.sys::truncate_stack
        end

        # => []
        @account_procedure
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
        @transaction_script
        pub proc main
            call.counter_contract::increment_count
        end
      `;
    const client = window.client;

    // Create counter account
    let emptyStorageSlot = window.StorageSlot.emptyValue(COUNTER_SLOT_NAME);

    let builder = await client.createCodeBuilder();

    let accountComponentCode = builder.compileAccountComponentCodeWithPath(
      "external_contract::counter_contract",
      accountCode
    );
    let counterAccountComponent = window.AccountComponent.compile(
      accountComponentCode,
      [emptyStorageSlot]
    ).withSupportsAllTypes();

    const walletSeed = new Uint8Array(32);
    crypto.getRandomValues(walletSeed);

    let accountBuilderResult = new window.AccountBuilder(walletSeed)
      .storageMode(window.AccountStorageMode.public())
      .withNoAuthComponent()
      .withComponent(counterAccountComponent)
      .build();

    await client.newAccount(accountBuilderResult.account, false);

    await client.syncState();

    // Link the exact code installed on the counter account.
    builder.linkDynamicAccountComponentCode(
      counterAccountComponent.componentCode()
    );
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

    const account = await client.getAccount(accountBuilderResult.account.id());
    const counter = account?.storage().getItem(COUNTER_SLOT_NAME)?.toHex();
    const finalCounter = counter?.replace(/^0x/, "").replace(/^0+|0+$/g, "");

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

// ── Tests ─────────────────────────────────────────────────────────────

test.describe("transaction request builder expiration delta tests", () => {
  test("submitting an expired transaction fails", async ({ page }) => {
    const { accountId: senderId, faucetId } = await setupWalletAndFaucet(page);
    const { accountId: targetId } = await setupWalletAndFaucet(page);

    const { createdNoteId } = await mintTransaction(
      page,
      senderId,
      faucetId,
      false,
      true
    );
    await consumeTransaction(page, senderId, faucetId, createdNoteId, false);

    await expect(
      submitExpiredTransaction(page, senderId, targetId, faucetId)
    ).rejects.toThrow();
  });

  test("rejects expiration delta when custom script is set", async ({
    page,
  }) => {
    await expect(
      buildCustomScriptRequestWithExpiration(page)
    ).rejects.toThrow();
  });
});

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

test.describe("counter account component tests", () => {
  test("counter account component transaction completes successfully", async ({
    page,
  }) => {
    let { finalCounter, hasCounterComponent } =
      await counterAccountComponent(page);
    expect(finalCounter).toEqual("1");
    expect(hasCounterComponent).toBe(true);
  });
});
