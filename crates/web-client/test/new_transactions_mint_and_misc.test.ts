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

// NEW_MINT_TRANSACTION TESTS
// =======================================================================================================

interface MultipleMintsTransactionUpdate {
  transactionIds: string[];
  createdNoteIds: string[];
  numOutputNotesCreated: number;
  nonce: string | undefined;
  finalBalance: string | undefined;
}

const multipleMintsTest = async (
  testingPage: Page,
  targetAccount: string,
  faucetAccount: string,
  withRemoteProver: boolean = false
): Promise<MultipleMintsTransactionUpdate> => {
  return await testingPage.evaluate(
    async ({ targetAccount, faucetAccount, withRemoteProver }) => {
      const client = window.client;

      const targetAccountId = window.AccountId.fromHex(targetAccount);
      const faucetAccountId = window.AccountId.fromHex(faucetAccount);
      await client.syncState();

      const prover =
        withRemoteProver && window.remoteProverUrl != null
          ? window.remoteProverInstance
          : undefined;

      // Mint 3 notes
      let result: {
        transactionIds: string[];
        createdNoteIds: string[];
        numOutputNotesCreated: number;
      } = {
        transactionIds: [],
        createdNoteIds: [],
        numOutputNotesCreated: 0,
      };

      for (let i = 0; i < 3; i++) {
        const mintTransactionRequest = await client.newMintTransactionRequest(
          targetAccountId,
          faucetAccountId,
          window.NoteType.Public,
          BigInt(1000)
        );

        const mintTransactionUpdate =
          await window.helpers.executeAndApplyTransaction(
            faucetAccountId,
            mintTransactionRequest,
            prover
          );

        await window.helpers.waitForTransaction(
          mintTransactionUpdate.executedTransaction().id().toHex()
        );

        result.createdNoteIds.push(
          mintTransactionUpdate
            .executedTransaction()
            .outputNotes()
            .notes()[0]
            .id()
            .toString()
        );
        result.transactionIds.push(
          mintTransactionUpdate.executedTransaction().id().toHex()
        );
        result.numOutputNotesCreated += mintTransactionUpdate
          .executedTransaction()
          .outputNotes()
          .numNotes();
      }

      // Consume the minted notes
      for (let i = 0; i < result.createdNoteIds.length; i++) {
        let noteId = result.createdNoteIds[i];
        const inputNoteRecord = await client.getInputNote(noteId);
        if (!inputNoteRecord) {
          throw new Error(`Note with ID ${noteId} not found`);
        }

        const note = inputNoteRecord.toNote();
        const consumeTransactionRequest = client.newConsumeTransactionRequest([
          note,
        ]);
        const consumeTransactionUpdate =
          await window.helpers.executeAndApplyTransaction(
            targetAccountId,
            consumeTransactionRequest,
            prover
          );

        await window.helpers.waitForTransaction(
          consumeTransactionUpdate.executedTransaction().id().toHex()
        );
      }

      const changedTargetAccount = await client.getAccount(targetAccountId);

      return {
        ...result,
        nonce: changedTargetAccount!.nonce()?.toString(),
        finalBalance: changedTargetAccount!
          .vault()
          .getBalance(faucetAccountId)
          .toString(),
      };
    },
    {
      targetAccount,
      faucetAccount,
      withRemoteProver,
    }
  );
};

const customTxWithMultipleNotes = async (
  testingPage: Page,
  isSerialNumSame: boolean,
  senderAccountId: string,
  faucetAccountId: string
) => {
  return await testingPage.evaluate(
    async ({ isSerialNumSame, _senderAccountId, _faucetAccountId }) => {
      const client = window.client;
      const amount = BigInt(10);
      const targetAccount = await client.newWallet(
        window.AccountStorageMode.private(),
        true,
        window.AuthScheme.AuthRpoFalcon512
      );
      const targetAccountId = targetAccount.id();
      const senderAccountId = window.AccountId.fromHex(_senderAccountId);
      const faucetAccountId = window.AccountId.fromHex(_faucetAccountId);

      // Create custom note with multiple assets to send to target account
      // Error should happen if serial numbers are the same in each set of
      // note assets. Otherwise, the transaction should go through.

      let noteAssets1 = new window.NoteAssets([
        new window.FungibleAsset(faucetAccountId, amount),
      ]);
      let noteAssets2 = new window.NoteAssets([
        new window.FungibleAsset(faucetAccountId, amount),
      ]);

      let noteMetadata = new window.NoteMetadata(
        senderAccountId,
        window.NoteType.Public,
        window.NoteTag.withAccountTarget(targetAccountId)
      );

      let serialNum1 = new window.Word(
        new BigUint64Array([BigInt(1), BigInt(2), BigInt(3), BigInt(4)])
      );
      let serialNum2 = new window.Word(
        new BigUint64Array([BigInt(5), BigInt(6), BigInt(7), BigInt(8)])
      );

      const p2idScript = window.NoteScript.p2id();

      const inputNotes = new window.MidenArrays.FeltArray([
        targetAccount.id().suffix(),
        targetAccount.id().prefix(),
      ]);

      let noteStorage = new window.NoteStorage(inputNotes);

      let noteRecipient1 = new window.NoteRecipient(
        serialNum1,
        p2idScript,
        noteStorage
      );
      let noteRecipient2 = new window.NoteRecipient(
        isSerialNumSame ? serialNum1 : serialNum2,
        p2idScript,
        noteStorage
      );

      let note1 = new window.Note(noteAssets1, noteMetadata, noteRecipient1);
      let note2 = new window.Note(noteAssets2, noteMetadata, noteRecipient2);

      let transactionRequest = new window.TransactionRequestBuilder()
        .withOwnOutputNotes(new window.NoteArray([note1, note2]))
        .build();

      let transactionUpdate = await window.helpers.executeAndApplyTransaction(
        senderAccountId,
        transactionRequest
      );

      await window.helpers.waitForTransaction(
        transactionUpdate.executedTransaction().id().toHex()
      );
    },
    {
      isSerialNumSame,
      _senderAccountId: senderAccountId,
      _faucetAccountId: faucetAccountId,
    }
  );
};

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
            use.miden::contracts::auth::basic->auth_tx
            use.miden::kernels::tx::prologue
            use.miden::kernels::tx::memory

            begin
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

test.describe("mint transaction tests", () => {
  const testCases = [
    { flag: false, description: "mint transaction completes successfully" },
    {
      flag: true,
      description: "mint transaction with remote prover completes successfully",
    },
  ];

  testCases.forEach(({ flag, description }) => {
    test(description, async ({ page }) => {
      test.skip(flag && !hasRemoteProver, "no remote prover configured");
      test.slow();
      // This test was added in #995 to reproduce an issue in the web wallet.
      // It is useful because most tests consume the note right on the latest client block,
      // but this test mints 3 notes and consumes them after the fact. This ensures the
      // MMR data for old blocks is available and valid so that the notes can be consumed.
      const { faucetId, accountId } = await setupWalletAndFaucet(page);
      const result = await multipleMintsTest(page, accountId, faucetId, flag);

      expect(result.transactionIds.length).toEqual(3);
      expect(result.numOutputNotesCreated).toEqual(3);
      expect(result.nonce).toEqual("3");
      expect(result.finalBalance).toEqual("3000");
      expect(result.createdNoteIds.length).toEqual(3);
    });
  });
});

// NEW_CONSUME_TRANSACTION TESTS
// =======================================================================================================

test.describe("consume transaction tests", () => {
  const testCases = [
    { flag: false, description: "consume transaction completes successfully" },
    {
      flag: true,
      description:
        "consume transaction with remote prover completes successfully",
    },
  ];

  testCases.forEach(({ flag, description }) => {
    test(description, async ({ page }) => {
      test.skip(flag && !hasRemoteProver, "no remote prover configured");
      const { faucetId, accountId } = await setupWalletAndFaucet(page);
      const { consumeResult: result } = await mintAndConsumeTransaction(
        page,
        accountId,
        faucetId,
        flag
      );

      expect(result.transactionId).toHaveLength(66);
      expect(result.nonce).toEqual("1");
      expect(result.numConsumedNotes).toEqual(1);
      expect(result.targetAccountBalance).toEqual("1000");
    });
  });
});

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

test.describe("custom transaction with multiple output notes", () => {
  const testCases = [
    {
      description: "does not fail when output note serial numbers are unique",
      shouldFail: false,
    },
    {
      description: "fails when output note serial numbers are the same",
      shouldFail: true,
    },
  ];

  testCases.forEach(({ description, shouldFail }) => {
    test(description, async ({ page }) => {
      test.slow();
      const { accountId, faucetId } = await setupConsumedNote(page);
      if (shouldFail) {
        await expect(
          customTxWithMultipleNotes(page, shouldFail, accountId, faucetId)
        ).rejects.toThrow();
      } else {
        await expect(
          customTxWithMultipleNotes(page, shouldFail, accountId, faucetId)
        ).resolves.toBeUndefined();
      }
    });
  });
});

// CUSTOM ACCOUNT COMPONENT TESTS
// =======================================================================================================

export const customAccountComponent = async (
  testingPage: Page,
  schemeSecretKeyFunction: string
): Promise<void> => {
  return await testingPage.evaluate(
    async ({ schemeSecretKeyFunction }) => {
      const MAP_SLOT_NAME =
        "miden::testing::mapping_example_contract::map_slot";

      const accountCode = `
        use miden::protocol::active_account
        use miden::protocol::native_account
        use miden::core::word
        use miden::core::sys

        const MAP_SLOT = word("${MAP_SLOT_NAME}")

        # Inputs: [KEY, VALUE]
        # Outputs: []
        pub proc write_to_map
            # Setting the key value pair in the map
            push.MAP_SLOT[0..2]
            exec.native_account::set_map_item
            # => [OLD_MAP_ROOT, OLD_MAP_VALUE]

            dropw dropw dropw dropw
            # => []
        end

        # Inputs: [KEY]
        # Outputs: [VALUE]
        pub proc get_value_in_map
            push.MAP_SLOT[0..2]
            exec.active_account::get_map_item
            # => [VALUE]
        end

        # Inputs: []
        # Outputs: [CURRENT_ROOT]
        pub proc get_current_map_root
            push.MAP_SLOT[0..2] exec.active_account::get_item
            # => [CURRENT_ROOT]

            exec.sys::truncate_stack
            # => [CURRENT_ROOT]
        end
      `;
      const scriptCode = `
        use miden_by_example::mapping_example_contract
        use miden::core::sys

        begin
            push.1.2.3.4
            push.0.0.0.0
            # => [KEY, VALUE]

            call.mapping_example_contract::write_to_map
            # => []

            push.0.0.0.0
            # => [KEY]

            call.mapping_example_contract::get_value_in_map
            # => [VALUE]

            dropw
            # => []

            call.mapping_example_contract::get_current_map_root
            # => [CURRENT_ROOT]

            exec.sys::truncate_stack
        end
      `;
      const client = window.client;
      let builder = client.createCodeBuilder();
      let storageMap = new window.StorageMap();
      let storageSlotMap = window.StorageSlot.map(MAP_SLOT_NAME, storageMap);

      let accountComponentCode =
        builder.compileAccountComponentCode(accountCode);
      let mappingAccountComponent = window.AccountComponent.compile(
        accountComponentCode,
        [storageSlotMap]
      ).withSupportsAllTypes();

      const walletSeed = new Uint8Array(32);
      crypto.getRandomValues(walletSeed);

      let secretKey = window.AuthSecretKey[schemeSecretKeyFunction](walletSeed);
      let authComponent =
        window.AccountComponent.createAuthComponentFromSecretKey(secretKey);

      let accountBuilderResult = new window.AccountBuilder(walletSeed)
        .accountType(2 /* WASM AccountType.RegularAccountImmutableCode */)
        .storageMode(window.AccountStorageMode.public())
        .withAuthComponent(authComponent)
        .withComponent(mappingAccountComponent)
        .build();

      await client.keystore.insert(
        accountBuilderResult.account.id(),
        secretKey
      );
      await client.newAccount(accountBuilderResult.account, false);

      await client.syncState();

      let accountCodeLib = builder.buildLibrary(
        "miden_by_example::mapping_example_contract",
        accountCode
      );

      builder.linkStaticLibrary(accountCodeLib);

      let txScript = builder.compileTxScript(scriptCode);

      let txIncrementRequest = new window.TransactionRequestBuilder()
        .withCustomScript(txScript)
        .build();

      let txResult = await window.helpers.executeAndApplyTransaction(
        accountBuilderResult.account.id(),
        txIncrementRequest
      );

      await window.helpers.waitForTransaction(
        txResult.executedTransaction().id().toHex()
      );

      // Fetch the updated account state from the client
      const updated = await client.getAccount(
        accountBuilderResult.account.id()
      );

      // Read a map value from storage slot 1 with key 0x0
      const keyZero = new window.Word(new BigUint64Array([0n, 0n, 0n, 0n]));
      const retrieveMapKey = updated
        ?.storage()
        .getMapItem(MAP_SLOT_NAME, keyZero);

      const expected = new window.Word(new BigUint64Array([4n, 3n, 2n, 1n]));

      if (retrieveMapKey?.toHex() !== expected.toHex()) {
        throw new Error(
          `unexpected Word: got ${retrieveMapKey?.toHex()} expected ${expected.toHex()}`
        );
      }
    },
    { schemeSecretKeyFunction }
  );
};

test.describe("custom account component tests", () => {
  [
    { authScheme: "ECDSA", schemeSecretKeyFunction: "ecdsaWithRNG" },
    { authScheme: "Falcon", schemeSecretKeyFunction: "rpoFalconWithRNG" },
  ].forEach(({ authScheme, schemeSecretKeyFunction }) => {
    test(`custom account component transaction completes successfully (${authScheme})`, async ({
      page,
    }) => {
      await expect(
        customAccountComponent(page, schemeSecretKeyFunction)
      ).resolves.toBeUndefined();
    });
  });
});

export const testStorageMap = async (page: Page): Promise<any> => {
  return await page.evaluate(async () => {
    const client = window.client;
    await client.syncState();

    const MAP_SLOT_NAME = "miden::testing::bump_item_contract::map_slot";

    const normalizeHexWord = (hex) => {
      if (!hex) return undefined;
      const normalized = hex.replace(/^0x/, "").replace(/^0+|0+$/g, "");
      return normalized;
    };

    // BUILD ACCOUNT WITH COMPONENT THAT MODIFIES STORAGE MAP
    // --------------------------------------------------------------------------

    const MAP_KEY = new window.Word(new BigUint64Array([1n, 1n, 1n, 1n]));
    const FPI_STORAGE_VALUE = new window.Word(
      new BigUint64Array([1n, 0n, 0n, 0n])
    );

    let storageMap = new window.StorageMap();
    storageMap.insert(MAP_KEY, FPI_STORAGE_VALUE);
    storageMap.insert(
      new window.Word(new BigUint64Array([2n, 2n, 2n, 2n])),
      new window.Word(new BigUint64Array([0n, 0n, 0n, 9n]))
    );

    const accountCode = `
                    use miden::core::word

                    const MAP_SLOT = word("${MAP_SLOT_NAME}")

                    pub proc bump_map_item
                    # map key
                    push.1.1.1.1 # Map key
                    push.MAP_SLOT[0..2]
                    exec.::miden::protocol::active_account::get_map_item
                    add.1
                    push.1.1.1.1 # Map key
                    push.MAP_SLOT[0..2]
                    exec.::miden::protocol::native_account::set_map_item
                    # => [OLD_MAP_ROOT, OLD_VALUE]
                    dropw dropw
                end
        `;

    let builder = client.createCodeBuilder();
    let accountComponentCode = builder.compileAccountComponentCode(accountCode);
    let bumpItemComponent = window.AccountComponent.compile(
      accountComponentCode,
      [window.StorageSlot.map(MAP_SLOT_NAME, storageMap)]
    ).withSupportsAllTypes();

    const walletSeed = new Uint8Array(32);
    crypto.getRandomValues(walletSeed);

    let secretKey = window.AuthSecretKey.rpoFalconWithRNG(walletSeed);
    let authComponent =
      window.AccountComponent.createAuthComponentFromSecretKey(secretKey);

    let bumpItemAccountBuilderResult = new window.AccountBuilder(walletSeed)
      .withAuthComponent(authComponent)
      .withComponent(bumpItemComponent)
      .storageMode(window.AccountStorageMode.public())
      .build();

    await client.keystore.insert(
      bumpItemAccountBuilderResult.account.id(),
      secretKey
    );
    await client.newAccount(bumpItemAccountBuilderResult.account, false);
    await client.syncState();

    let initialMapValue = (
      await client.getAccount(bumpItemAccountBuilderResult.account.id())
    )
      ?.storage()
      .getMapItem(MAP_SLOT_NAME, MAP_KEY)
      ?.toHex();

    // Deploy counter account

    let accountComponentLib = builder.buildLibrary(
      "external_contract::bump_item_contract",
      accountCode
    );

    builder.linkDynamicLibrary(accountComponentLib);

    let txScript = builder.compileTxScript(
      `use external_contract::bump_item_contract
      begin
          call.bump_item_contract::bump_map_item
      end`
    );

    let txIncrementRequest = new window.TransactionRequestBuilder()
      .withCustomScript(txScript)
      .build();

    let txResult = await window.helpers.executeAndApplyTransaction(
      bumpItemAccountBuilderResult.account.id(),
      txIncrementRequest
    );
    await window.helpers.waitForTransaction(
      txResult.executedTransaction().id().toHex()
    );

    let finalMapValue = (
      await client.getAccount(bumpItemAccountBuilderResult.account.id())
    )
      ?.storage()
      .getMapItem(MAP_SLOT_NAME, MAP_KEY)
      ?.toHex();

    // Test getMapEntries() functionality
    let accountStorage = (
      await client.getAccount(bumpItemAccountBuilderResult.account.id())
    )?.storage();
    let mapEntries = accountStorage?.getMapEntries(MAP_SLOT_NAME);

    // Verify we get the expected entries
    let expectedKey = MAP_KEY.toHex();
    let expectedValue = normalizeHexWord(finalMapValue);

    let mapEntriesData = {
      entriesCount: mapEntries?.length || 0,
      hasExpectedEntry: false,
      expectedKey: expectedKey,
      expectedValue: expectedValue,
    };

    if (expectedValue && mapEntries && mapEntries.length > 0) {
      mapEntriesData.hasExpectedEntry = mapEntries.some(
        (entry) =>
          entry.key === expectedKey &&
          normalizeHexWord(entry.value) === expectedValue
      );
    }

    return {
      initialMapValue: normalizeHexWord(initialMapValue),
      finalMapValue: normalizeHexWord(finalMapValue),
      mapEntries: mapEntriesData,
    };
  });
};

test.describe("storage map test", () => {
  test("storage map is updated correctly in transaction", async ({ page }) => {
    test.slow();
    let { initialMapValue, finalMapValue, mapEntries } =
      await testStorageMap(page);
    expect(initialMapValue).toBe("1");
    expect(finalMapValue).toBe("2");

    // Test getMapEntries() functionality
    expect(mapEntries.entriesCount).toBeGreaterThan(1);
    expect(mapEntries.hasExpectedEntry).toBe(true);
    expect(mapEntries.expectedKey).toBeDefined();
    expect(mapEntries.expectedValue).toBe("2");
  });
});

// SUBMIT_NEW_TRANSACTION_WITH_PROVER TESTS
// ================================================================================================

test.describe("submitNewTransactionWithProver tests", () => {
  test("submitNewTransactionWithProver with failing prover throws, then succeeds with local prover", async ({
    page,
  }) => {
    const { faucetId, accountId } = await setupWalletAndFaucet(page);

    // Test that a failing prover throws an error
    const failingProverResult = await page.evaluate(
      async ({ faucetId, accountId }) => {
        const client = window.client;
        const faucetAccountId = window.AccountId.fromHex(faucetId);
        const targetAccountId = window.AccountId.fromHex(accountId);

        await client.syncState();

        const mintTransactionRequest = client.newMintTransactionRequest(
          targetAccountId,
          faucetAccountId,
          window.NoteType.Public,
          BigInt(1000)
        );

        // Create a failing remote prover with an invalid endpoint
        const failingProver = window.TransactionProver.newRemoteProver(
          "http://localhost:1",
          null
        );

        try {
          await client.submitNewTransactionWithProver(
            faucetAccountId,
            mintTransactionRequest,
            failingProver
          );
          return { threw: false, error: null };
        } catch (e: any) {
          return { threw: true, error: e.message || String(e) };
        }
      },
      { faucetId, accountId }
    );

    expect(failingProverResult.threw).toBe(true);
  });

  test.describe("executeForSummary tests", () => {
    test("executeForSummary returns TransactionSummary for unauthorized transaction", async ({
      page,
    }) => {
      test.slow();
      const result = await page.evaluate(async () => {
        const client = window.client;

        const walletSeed = new Uint8Array(32);
        crypto.getRandomValues(walletSeed);

        const approverKeys = [
          window.AuthSecretKey.rpoFalconWithRNG(),
          window.AuthSecretKey.rpoFalconWithRNG(),
          window.AuthSecretKey.rpoFalconWithRNG(),
        ];
        const approverCommitments = approverKeys.map((key) =>
          key.publicKey().toCommitment()
        );
        const multisigConfig = new window.AuthFalcon512RpoMultisigConfig(
          approverCommitments,
          2
        );
        const multisigComponent =
          window.createAuthFalcon512RpoMultisig(multisigConfig);

        const accountBuilderResult = new window.AccountBuilder(walletSeed)
          .accountType(2 /* WASM AccountType.RegularAccountImmutableCode */)
          .storageMode(window.AccountStorageMode.private())
          .withAuthComponent(multisigComponent)
          .withBasicWalletComponent()
          .build();

        const multisigAccountId = accountBuilderResult.account.id();
        await client.newAccount(accountBuilderResult.account, false);

        // Register the approver keys with the multisig account
        for (const key of approverKeys) {
          await client.keystore.insert(multisigAccountId, key);
        }

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

        const mintTransactionRequest = client.newMintTransactionRequest(
          targetAccount.id(),
          faucetAccount.id(),
          window.NoteType.Public,
          BigInt(1000)
        );

        const mintTransactionUpdate =
          await window.helpers.executeAndApplyTransaction(
            faucetAccount.id(),
            mintTransactionRequest
          );

        const createdNoteIds = mintTransactionUpdate
          .executedTransaction()
          .outputNotes()
          .notes()
          .map((note: Note) => note.id().toString());

        await window.helpers.waitForTransaction(
          mintTransactionUpdate.executedTransaction().id().toHex()
        );

        // Convert note IDs to Note objects for consume request
        const createdNotes = await Promise.all(
          createdNoteIds.map(async (noteId: string) => {
            const inputNoteRecord = await client.getInputNote(noteId);
            if (!inputNoteRecord) {
              throw new Error(`Note with ID ${noteId} not found`);
            }
            return inputNoteRecord.toNote();
          })
        );

        const consumeTransactionRequest =
          client.newConsumeTransactionRequest(createdNotes);

        const consumeTransactionUpdate =
          await window.helpers.executeAndApplyTransaction(
            targetAccount.id(),
            consumeTransactionRequest
          );

        await window.helpers.waitForTransaction(
          consumeTransactionUpdate.executedTransaction().id().toHex()
        );

        const sendTransactionRequest = client.newSendTransactionRequest(
          targetAccount.id(),
          accountBuilderResult.account.id(),
          faucetAccount.id(),
          window.NoteType.Public,
          BigInt(100),
          null,
          null
        );

        const sendTransactionUpdate =
          await window.helpers.executeAndApplyTransaction(
            targetAccount.id(),
            sendTransactionRequest
          );

        const sentNoteIds = sendTransactionUpdate
          .executedTransaction()
          .outputNotes()
          .notes()
          .map((note: Note) => note.id().toString());

        await window.helpers.waitForTransaction(
          sendTransactionUpdate.executedTransaction().id().toHex()
        );

        // Convert note IDs to Note objects for consume request
        const sentNotes = await Promise.all(
          sentNoteIds.map(async (noteId: string) => {
            const inputNoteRecord = await client.getInputNote(noteId);
            if (!inputNoteRecord) {
              throw new Error(`Note with ID ${noteId} not found`);
            }
            return inputNoteRecord.toNote();
          })
        );

        const consumeSentNoteRequest =
          client.newConsumeTransactionRequest(sentNotes);

        const summary = await client.executeForSummary(
          accountBuilderResult.account.id(),
          consumeSentNoteRequest
        );

        return {
          inputNotesCount: summary.inputNotes().numNotes(),
          outputNotesCount: summary.outputNotes().numNotes(),
          inputNoteIds: summary
            .inputNotes()
            .notes()
            .map((note: any) => note.id().toString()),
          sentNoteIds,
        };
      });

      expect(result.inputNotesCount).toBe(1);
      expect(result.outputNotesCount).toBe(0);
      expect(result.inputNoteIds).toEqual(result.sentNoteIds);
    });

    test("executeForSummary returns TransactionSummary for authorized transaction with matching salt", async ({
      page,
    }) => {
      const result = await page.evaluate(async () => {
        const client = window.client;

        const senderAccount = await client.newWallet(
          window.AccountStorageMode.private(),
          false,
          window.AuthScheme.AuthRpoFalcon512
        );

        await client.syncState();

        // Create a known salt value
        const expectedSalt = new window.Word(
          new BigUint64Array([BigInt(1), BigInt(2), BigInt(3), BigInt(4)])
        );

        // Build transaction request with the salt as auth_arg
        const transactionRequest = new window.TransactionRequestBuilder()
          .withAuthArg(expectedSalt)
          .build();

        const summary = await client.executeForSummary(
          senderAccount.id(),
          transactionRequest
        );

        return {
          inputNotesCount: summary.inputNotes().numNotes(),
          outputNotesCount: summary.outputNotes().numNotes(),
          saltHex: summary.salt().toHex(),
          expectedSaltHex: expectedSalt.toHex(),
        };
      });

      expect(result.inputNotesCount).toBe(0);
      expect(result.outputNotesCount).toBe(0);
      expect(result.saltHex).toBe(result.expectedSaltHex);
    });
  });
});
