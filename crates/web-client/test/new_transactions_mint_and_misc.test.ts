// @ts-nocheck
// Mint + consume + custom-account-component + storage-map + prover tests.
// Split from new_transactions.test.ts to balance shard-1 wall clock — the
// send/custom describes live in new_transactions_send_and_custom.test.ts.
// Platform-agnostic (browser + Node.js).
import { test, expect } from "./test-setup";

// NEW_MINT_TRANSACTION TESTS
// =======================================================================================================

test.describe("mint transaction tests", () => {
  test("multiple mints and consumes complete successfully", async ({ run }) => {
    // This test was added in #995 to reproduce an issue in the web wallet.
    // It is useful because most tests consume the note right on the latest client block,
    // but this test mints 3 notes and consumes them after the fact. This ensures the
    // MMR data for old blocks is available and valid so that the notes can be consumed.
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      // Mint 3 notes
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(await helpers.mockMint(wallet.id(), faucet.id()));
      }

      const mintCount = results.length;
      const allHaveOneOutput = results.every(
        (r) => r.numOutputNotesCreated === 1
      );

      // Consume all minted notes
      for (const { createdNoteId } of results) {
        await helpers.mockConsume(wallet.id(), createdNoteId);
      }

      const account = await client.getAccount(wallet.id());
      const balance = account.vault().getBalance(faucet.id()).toString();

      return { mintCount, allHaveOneOutput, balance };
    });

    expect(result.mintCount).toEqual(3);
    expect(result.allHaveOneOutput).toBe(true);
    expect(result.balance).toEqual("3000");
  });
});

// NEW_CONSUME_TRANSACTION TESTS
// =======================================================================================================

test.describe("consume transaction tests", () => {
  test("consume transaction completes successfully", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      const { targetAccountBalance } = await helpers.mockMintAndConsume(
        wallet.id(),
        faucet.id()
      );

      return { targetAccountBalance };
    });

    expect(result.targetAccountBalance).toEqual("1000");
  });
});

// CUSTOM ACCOUNT COMPONENT TESTS
// =======================================================================================================

test.describe("custom account component tests", () => {
  test("custom account component transaction completes successfully (ECDSA)", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
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

      const builder = await client.createCodeBuilder();
      const storageMap = new sdk.StorageMap();
      const storageSlotMap = sdk.StorageSlot.map(MAP_SLOT_NAME, storageMap);

      const accountComponentCode =
        builder.compileAccountComponentCode(accountCode);
      const mappingAccountComponent = sdk.AccountComponent.compile(
        accountComponentCode,
        [storageSlotMap]
      ).withSupportsAllTypes();

      const walletSeed = new Uint8Array(32);
      crypto.getRandomValues(walletSeed);

      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG(walletSeed);
      const authComponent =
        sdk.AccountComponent.createAuthComponentFromSecretKey(secretKey);

      const accountBuilderResult = new sdk.AccountBuilder(walletSeed)
        .accountType(2 /* RegularAccountImmutableCode */)
        .storageMode(sdk.AccountStorageMode.public())
        .withAuthComponent(authComponent)
        .withComponent(mappingAccountComponent)
        .build();

      await client.keystore.insert(
        accountBuilderResult.account.id(),
        secretKey
      );
      await client.newAccount(accountBuilderResult.account, false);

      const accountCodeLib = builder.buildLibrary(
        "miden_by_example::mapping_example_contract",
        accountCode
      );

      builder.linkStaticLibrary(accountCodeLib);

      const txScript = builder.compileTxScript(scriptCode);

      const txIncrementRequest = new sdk.TransactionRequestBuilder()
        .withCustomScript(txScript)
        .build();

      await client.submitNewTransaction(
        accountBuilderResult.account.id(),
        txIncrementRequest
      );
      await client.proveBlock();
      await client.syncState();

      // Fetch the updated account state from the client
      const updated = await client.getAccount(
        accountBuilderResult.account.id()
      );

      // Read a map value from storage slot with key 0x0
      const keyZero = new sdk.Word(sdk.u64Array([0, 0, 0, 0]));
      const retrieveMapKey = updated
        ?.storage()
        .getMapItem(MAP_SLOT_NAME, keyZero);

      const expected = new sdk.Word(sdk.u64Array([4, 3, 2, 1]));

      return {
        retrieveMapKeyHex: retrieveMapKey?.toHex(),
        expectedHex: expected.toHex(),
      };
    });

    expect(result.retrieveMapKeyHex).toEqual(result.expectedHex);
  });

  test("custom account component transaction completes successfully (Falcon)", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
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

      const builder = await client.createCodeBuilder();
      const storageMap = new sdk.StorageMap();
      const storageSlotMap = sdk.StorageSlot.map(MAP_SLOT_NAME, storageMap);

      const accountComponentCode =
        builder.compileAccountComponentCode(accountCode);
      const mappingAccountComponent = sdk.AccountComponent.compile(
        accountComponentCode,
        [storageSlotMap]
      ).withSupportsAllTypes();

      const walletSeed = new Uint8Array(32);
      crypto.getRandomValues(walletSeed);

      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG(walletSeed);
      const authComponent =
        sdk.AccountComponent.createAuthComponentFromSecretKey(secretKey);

      const accountBuilderResult = new sdk.AccountBuilder(walletSeed)
        .accountType(2 /* RegularAccountImmutableCode */)
        .storageMode(sdk.AccountStorageMode.public())
        .withAuthComponent(authComponent)
        .withComponent(mappingAccountComponent)
        .build();

      await client.addAccountSecretKeyToWebStore(
        accountBuilderResult.account.id(),
        secretKey
      );
      await client.newAccount(accountBuilderResult.account, false);

      const accountCodeLib = builder.buildLibrary(
        "miden_by_example::mapping_example_contract",
        accountCode
      );

      builder.linkStaticLibrary(accountCodeLib);

      const txScript = builder.compileTxScript(scriptCode);

      const txIncrementRequest = new sdk.TransactionRequestBuilder()
        .withCustomScript(txScript)
        .build();

      await client.submitNewTransaction(
        accountBuilderResult.account.id(),
        txIncrementRequest
      );
      await client.proveBlock();
      await client.syncState();

      // Fetch the updated account state from the client
      const updated = await client.getAccount(
        accountBuilderResult.account.id()
      );

      // Read a map value from storage slot with key 0x0
      const keyZero = new sdk.Word(sdk.u64Array([0, 0, 0, 0]));
      const retrieveMapKey = updated
        ?.storage()
        .getMapItem(MAP_SLOT_NAME, keyZero);

      const expected = new sdk.Word(sdk.u64Array([4, 3, 2, 1]));

      return {
        retrieveMapKeyHex: retrieveMapKey?.toHex(),
        expectedHex: expected.toHex(),
      };
    });

    expect(result.retrieveMapKeyHex).toEqual(result.expectedHex);
  });
});

// DISCARDED TRANSACTIONS TESTS
// ================================================================================================
// Skipped: requires exportStore/importStore which are browser-only (IndexedDB)

// NETWORK TRANSACTION TESTS
// ================================================================================================
// Skipped: requires a running node (waitForBlocks, network account)

// STORAGE MAP TEST
// =======================================================================================================

test.describe("storage map test", () => {
  test("storage map is updated correctly in transaction", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const MAP_SLOT_NAME = "miden::testing::bump_item_contract::map_slot";

      const normalizeHexWord = (hex) => {
        if (!hex) return undefined;
        const normalized = hex.replace(/^0x/, "").replace(/^0+|0+$/g, "");
        return normalized;
      };

      // BUILD ACCOUNT WITH COMPONENT THAT MODIFIES STORAGE MAP
      const MAP_KEY = new sdk.Word(sdk.u64Array([1, 1, 1, 1]));
      const FPI_STORAGE_VALUE = new sdk.Word(sdk.u64Array([0, 0, 0, 1]));

      const storageMap = new sdk.StorageMap();
      storageMap.insert(MAP_KEY, FPI_STORAGE_VALUE);
      storageMap.insert(
        new sdk.Word(sdk.u64Array([2, 2, 2, 2])),
        new sdk.Word(sdk.u64Array([0, 0, 0, 9]))
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

      const builder = await client.createCodeBuilder();
      const accountComponentCode =
        builder.compileAccountComponentCode(accountCode);
      const bumpItemComponent = sdk.AccountComponent.compile(
        accountComponentCode,
        [sdk.StorageSlot.map(MAP_SLOT_NAME, storageMap)]
      ).withSupportsAllTypes();

      const walletSeed = new Uint8Array(32);
      crypto.getRandomValues(walletSeed);

      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG(walletSeed);
      const authComponent =
        sdk.AccountComponent.createAuthComponentFromSecretKey(secretKey);

      const bumpItemAccountBuilderResult = new sdk.AccountBuilder(walletSeed)
        .withAuthComponent(authComponent)
        .withComponent(bumpItemComponent)
        .storageMode(sdk.AccountStorageMode.public())
        .build();

      await client.addAccountSecretKeyToWebStore(
        bumpItemAccountBuilderResult.account.id(),
        secretKey
      );
      await client.newAccount(bumpItemAccountBuilderResult.account, false);

      // Use felt values instead of hex for comparison (hex normalization
      // differs between browser BigUint64Array and Node.js number arrays).
      // Sum all felts to be robust to any platform ordering differences;
      // only one felt in the Word is non-zero so the sum equals the value.
      const sumFelts = (word) => {
        const felts = word?.toFelts();
        if (!felts) return undefined;
        let sum = 0;
        for (const f of felts) sum += Number(f.asInt());
        return sum;
      };

      const initialMapSum = sumFelts(
        (await client.getAccount(bumpItemAccountBuilderResult.account.id()))
          ?.storage()
          .getMapItem(MAP_SLOT_NAME, MAP_KEY)
      );

      const accountComponentLib = builder.buildLibrary(
        "external_contract::bump_item_contract",
        accountCode
      );

      builder.linkDynamicLibrary(accountComponentLib);

      const txScript = builder.compileTxScript(
        `use external_contract::bump_item_contract
        begin
            call.bump_item_contract::bump_map_item
        end`
      );

      const txIncrementRequest = new sdk.TransactionRequestBuilder()
        .withCustomScript(txScript)
        .build();

      await client.submitNewTransaction(
        bumpItemAccountBuilderResult.account.id(),
        txIncrementRequest
      );
      await client.proveBlock();
      await client.syncState();

      const finalMapSum = sumFelts(
        (await client.getAccount(bumpItemAccountBuilderResult.account.id()))
          ?.storage()
          .getMapItem(MAP_SLOT_NAME, MAP_KEY)
      );

      // Test getMapEntries() functionality
      const accountStorage = (
        await client.getAccount(bumpItemAccountBuilderResult.account.id())
      )?.storage();
      const mapEntries = accountStorage?.getMapEntries(MAP_SLOT_NAME);

      return {
        initialMapSum,
        finalMapSum,
        mapEntriesLength: mapEntries?.length,
      };
    });

    expect(result.initialMapSum).toBe(1);
    expect(result.finalMapSum).toBe(2);
    expect(result.mapEntriesLength).toBeGreaterThan(1);
  });
});

// SUBMIT_NEW_TRANSACTION_WITH_PROVER TESTS
// ================================================================================================

test.describe("submitNewTransactionWithProver tests", () => {
  test("submitNewTransactionWithProver with failing prover throws", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();

      const mintTransactionRequest = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Public,
        sdk.u64(1000)
      );

      // Create a failing remote prover with an invalid endpoint
      const failingProver = sdk.TransactionProver.newRemoteProver(
        "http://localhost:1",
        null
      );

      let threw = false;
      try {
        await client.submitNewTransactionWithProver(
          faucet.id(),
          mintTransactionRequest,
          failingProver
        );
      } catch {
        threw = true;
      }

      return { threw };
    });

    expect(result.threw).toBe(true);
  });

  test.describe("executeForSummary tests", () => {
    test("executeForSummary returns TransactionSummary for unauthorized transaction", async ({
      run,
    }) => {
      const result = await run(async ({ client, sdk }) => {
        const walletSeed = new Uint8Array(32);
        crypto.getRandomValues(walletSeed);

        const approverKeys = [
          sdk.AuthSecretKey.rpoFalconWithRNG(),
          sdk.AuthSecretKey.rpoFalconWithRNG(),
          sdk.AuthSecretKey.rpoFalconWithRNG(),
        ];
        const approverCommitments = approverKeys.map((key) =>
          key.publicKey().toCommitment()
        );
        const multisigConfig = new sdk.AuthFalcon512RpoMultisigConfig(
          approverCommitments,
          2
        );
        const multisigComponent =
          sdk.createAuthFalcon512RpoMultisig(multisigConfig);

        const accountBuilderResult = new sdk.AccountBuilder(walletSeed)
          .accountType(2 /* RegularAccountImmutableCode */)
          .storageMode(sdk.AccountStorageMode.private())
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
          sdk.AccountStorageMode.private(),
          false,
          sdk.AuthScheme.AuthRpoFalcon512
        );

        const faucetAccount = await client.newFaucet(
          sdk.AccountStorageMode.private(),
          false,
          "DAG",
          8,
          sdk.u64(10000000),
          sdk.AuthScheme.AuthRpoFalcon512
        );

        // Mint and consume to fund target
        const mintRequest = await client.newMintTransactionRequest(
          targetAccount.id(),
          faucetAccount.id(),
          sdk.NoteType.Public,
          sdk.u64(1000)
        );
        const mintTxId = await client.submitNewTransaction(
          faucetAccount.id(),
          mintRequest
        );
        await client.proveBlock();
        await client.syncState();

        const [mintTxRecord] = await client.getTransactions(
          sdk.TransactionFilter.ids([mintTxId])
        );
        const createdNoteIds = mintTxRecord
          .outputNotes()
          .notes()
          .map((note) => note.id().toString());

        // Convert note IDs to Note objects for consume request
        const createdNotes = await Promise.all(
          createdNoteIds.map(async (noteId) => {
            const inputNoteRecord = await client.getInputNote(noteId);
            if (!inputNoteRecord) {
              throw new Error(`Note with ID ${noteId} not found`);
            }
            return inputNoteRecord.toNote();
          })
        );

        const consumeTransactionRequest =
          client.newConsumeTransactionRequest(createdNotes);

        await client.submitNewTransaction(
          targetAccount.id(),
          consumeTransactionRequest
        );
        await client.proveBlock();
        await client.syncState();

        const sendTransactionRequest = await client.newSendTransactionRequest(
          targetAccount.id(),
          accountBuilderResult.account.id(),
          faucetAccount.id(),
          sdk.NoteType.Public,
          sdk.u64(100),
          null,
          null
        );

        const sendTxId = await client.submitNewTransaction(
          targetAccount.id(),
          sendTransactionRequest
        );
        await client.proveBlock();
        await client.syncState();

        const [sendTxRecord] = await client.getTransactions(
          sdk.TransactionFilter.ids([sendTxId])
        );
        const sentNoteIds = sendTxRecord
          .outputNotes()
          .notes()
          .map((note) => note.id().toString());

        // Convert note IDs to Note objects for consume request
        const sentNotes = await Promise.all(
          sentNoteIds.map(async (noteId) => {
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

        const summaryInputNoteIds = summary
          .inputNotes()
          .notes()
          .map((note) => note.id().toString());

        return {
          inputNotesCount: summary.inputNotes().numNotes(),
          outputNotesCount: summary.outputNotes().numNotes(),
          summaryInputNoteIds,
          sentNoteIds,
        };
      });

      expect(result.inputNotesCount).toBe(1);
      expect(result.outputNotesCount).toBe(0);
      expect(result.summaryInputNoteIds).toEqual(result.sentNoteIds);
    });

    test("executeForSummary returns TransactionSummary for authorized transaction with matching salt", async ({
      run,
    }) => {
      const result = await run(async ({ client, sdk }) => {
        const senderAccount = await client.newWallet(
          sdk.AccountStorageMode.private(),
          false,
          sdk.AuthScheme.AuthRpoFalcon512
        );

        // Create a known salt value
        const expectedSalt = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));

        // Build transaction request with the salt as auth_arg
        const transactionRequest = new sdk.TransactionRequestBuilder()
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
