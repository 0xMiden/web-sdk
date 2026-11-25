// @ts-nocheck
import { test, expect } from "./test-setup";
import { isLocalhost } from "./playwright.global.setup";

test("account file import can retry after a temporary key storage error", async ({
  run,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "nodejs" || !isLocalhost(),
    "requires browser keystore callbacks and a local test node"
  );

  const result = await run(async ({ client, sdk }) => {
    const wallet = await client.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512
    );
    const file = await client.exportAccountFile(wallet.id());
    const bytes = file.serialize();
    const keys = new Map<string, Uint8Array>();
    let storageAvailable = false;
    let writes = 0;
    const restored = await sdk.WasmWebClient.createClientWithExternalKeystore(
      window.rpcUrl,
      undefined,
      undefined,
      `${window.storeName}-file-import`,
      async (commitment) => keys.get(commitment.toString()),
      async (commitment, key) => {
        if (!storageAvailable) throw new Error("key storage unavailable");
        writes++;
        keys.set(commitment.toString(), key);
      },
      undefined,
      undefined,
      false,
      undefined,
      window.feeFaucetId
    );

    const importFile = () =>
      restored.importAccountFile(sdk.AccountFile.deserialize(bytes));
    const readImportError = () =>
      importFile().then(
        () => null,
        (error) => (error instanceof Error ? error.message : String(error))
      );

    try {
      const error = await readImportError();
      const trackedAfterFailure = Boolean(
        await restored.getAccount(wallet.id())
      );

      storageAvailable = true;
      const retryError = await readImportError();
      const imported = await restored.getAccount(wallet.id());
      const duplicateError = await readImportError();
      return {
        error,
        trackedAfterFailure,
        retryError,
        imported: imported?.id().toString(),
        expectedId: wallet.id().toString(),
        duplicateError,
        writes,
      };
    } finally {
      restored.terminate();
    }
  });

  expect(result.error).toContain("key storage unavailable");
  expect(result.trackedAfterFailure).toBe(false);
  expect(result.retryError).toBeNull();
  expect(result.imported).toBe(result.expectedId);
  expect(result.duplicateError).toContain("already being tracked");
  expect(result.writes).toBe(1);
});

test("account file import resumes after saving only one of two keys", async ({
  run,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "nodejs" || !isLocalhost(),
    "requires browser keystore callbacks and a local test node"
  );

  const result = await run(async ({ client, sdk }) => {
    const wallet = await client.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512
    );
    await client.keystore.insert(
      wallet.id(),
      sdk.AuthSecretKey.ecdsaWithRNG(null)
    );
    const file = await client.exportAccountFile(wallet.id());
    const bytes = file.serialize();
    const keys = new Map<string, Uint8Array>();
    const writeAttempts = new Map<string, number>();
    let failSecondWrite = true;
    const restored = await sdk.WasmWebClient.createClientWithExternalKeystore(
      window.rpcUrl,
      undefined,
      undefined,
      `${window.storeName}-multi-key-file-import`,
      async (commitment) => keys.get(commitment.toString()),
      async (commitment, key) => {
        const id = commitment.toString();
        writeAttempts.set(id, (writeAttempts.get(id) ?? 0) + 1);
        if (keys.has(id)) throw new Error("key already stored");
        if (failSecondWrite && keys.size === 1) {
          throw new Error("second key write unavailable");
        }
        keys.set(id, key);
      },
      undefined,
      undefined,
      false,
      undefined,
      window.feeFaucetId
    );

    const readImportError = () =>
      restored.importAccountFile(sdk.AccountFile.deserialize(bytes)).then(
        () => null,
        (error) => (error instanceof Error ? error.message : String(error))
      );

    try {
      const firstError = await readImportError();
      const keysAfterFailure = keys.size;

      failSecondWrite = false;
      const retryError = await readImportError();
      const restoredKeyCount = retryError
        ? null
        : (await restored.exportAccountFile(wallet.id())).authSecretKeyCount();
      return {
        firstError,
        keysAfterFailure,
        retryError,
        restoredKeyCount,
        writeAttempts: Array.from(writeAttempts.values()),
      };
    } finally {
      restored.terminate();
    }
  });

  expect(result.firstError).toContain("second key write unavailable");
  expect(result.keysAfterFailure).toBe(1);
  expect(result.retryError).toBeNull();
  expect(result.restoredKeyCount).toBe(2);
  expect(result.writeAttempts).toEqual([1, 2]);
});

test.describe("import from seed", () => {
  test("should import same public account from seed", async ({ run }) => {
    test.slow();
    const result = await run(async ({ sdk, helpers }) => {
      const integration = await helpers.createIntegrationClient();
      if (!integration) return { skip: true };
      const { client: intClient } = integration;

      const walletSeed = new Uint8Array(32);
      crypto.getRandomValues(walletSeed);

      const initialWallet = await intClient.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512,
        walletSeed
      );
      const initialWalletId = initialWallet.id();

      const faucet = await intClient.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucetId = faucet.id();

      // Mint
      await intClient.syncState();
      const mintRequest = await intClient.newMintTransactionRequest(
        initialWalletId,
        faucetId,
        sdk.NoteType.Private,
        sdk.u64(1000)
      );
      let execResult = await intClient.executeTransaction(
        faucetId,
        mintRequest
      );
      let prover = sdk.TransactionProver.newLocalProver();
      let proven = await intClient.proveTransaction(execResult, prover);
      let height = await intClient.submitProvenTransaction(proven, execResult);
      let execUpdate = await intClient.applyTransaction(execResult, height);
      let txId = execUpdate.executedTransaction().id().toHex();
      const createdNoteId = execUpdate
        .createdNotes()
        .notes()[0]
        .id()
        .toString();

      // Wait for mint tx
      let timeWaited = 0;
      while (timeWaited < 10000) {
        await intClient.syncState();
        const uncommitted = await intClient.getTransactions(
          sdk.TransactionFilter.uncommitted()
        );
        const ids = uncommitted.map((tx) => tx.id().toHex());
        if (!ids.includes(txId)) break;
        await new Promise((r) => setTimeout(r, 1000));
        timeWaited += 1000;
      }

      // Consume
      await intClient.syncState();
      const inputNoteRecord = await intClient.getInputNote(createdNoteId);
      const note = inputNoteRecord.toNote();
      const consumeRequest = await intClient.newConsumeTransactionRequest(
        [note],
        initialWalletId
      );
      execResult = await intClient.executeTransaction(
        initialWalletId,
        consumeRequest
      );
      prover = sdk.TransactionProver.newLocalProver();
      proven = await intClient.proveTransaction(execResult, prover);
      height = await intClient.submitProvenTransaction(proven, execResult);
      execUpdate = await intClient.applyTransaction(execResult, height);
      txId = execUpdate.executedTransaction().id().toHex();

      // Wait for consume tx
      timeWaited = 0;
      while (timeWaited < 10000) {
        await intClient.syncState();
        const uncommitted = await intClient.getTransactions(
          sdk.TransactionFilter.uncommitted()
        );
        const ids = uncommitted.map((tx) => tx.id().toHex());
        if (!ids.includes(txId)) break;
        await new Promise((r) => setTimeout(r, 1000));
        timeWaited += 1000;
      }

      const initialAccount = await intClient.getAccount(initialWalletId);
      const initialBalance = initialAccount
        .vault()
        .getBalance(faucetId)
        .toString();
      const initialCommitment = initialAccount.to_commitment().toHex();

      // Create a fresh client (separate store) and import the wallet from seed
      const integration2 = await helpers.createIntegrationClient();
      if (!integration2) return { skip: true };
      const { client: freshClient } = integration2;

      await freshClient.syncState();
      const restoredAccount = await freshClient.importPublicAccountFromSeed(
        walletSeed,
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const restoredAccountId = restoredAccount.id().toString();

      const restoredAccountObj = await freshClient.getAccount(
        sdk.AccountId.fromHex(restoredAccountId)
      );
      const restoredAccountCommitment = restoredAccountObj
        .to_commitment()
        .toHex();

      const restoredBalance = restoredAccountObj
        .vault()
        .getBalance(sdk.AccountId.fromHex(faucetId.toString()));

      return {
        skip: false,
        initialWalletIdStr: initialWalletId.toString(),
        restoredAccountId,
        initialBalance,
        restoredBalance: restoredBalance.toString(),
        initialCommitment,
        restoredAccountCommitment,
      };
    });
    if (result.skip) {
      test.skip(true, "requires running node");
      return;
    }
    expect(result.restoredAccountId).toEqual(result.initialWalletIdStr);
    expect(result.restoredBalance).toEqual(result.initialBalance);
    expect(result.restoredAccountCommitment).toEqual(result.initialCommitment);
  });

  test("raw client resolves friendly AuthScheme strings", async ({
    run,
  }, testInfo) => {
    // Covers the napi client wrapper; js/__tests__/client.test.js covers the
    // browser one. The import below runs on the client that created the
    // account, because the napi mock RPC serves no other client's accounts and
    // the IndexedDB store rejects re-importing an account it already tracks.
    test.skip(testInfo.project.name !== "nodejs", "napi client wrapper only");
    test.slow();
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      const ecdsaWallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        "ecdsa"
      );

      // A public wallet can be imported from its seed once a transaction of
      // its own has put it on the mock chain.
      const walletSeed = new Uint8Array(32);
      crypto.getRandomValues(walletSeed);
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.public(),
        "falcon",
        walletSeed
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        "falcon"
      );

      const mintTransactionId = await client.submitNewTransaction(
        faucet.id(),
        await client.newMintTransactionRequest(
          wallet.id(),
          faucet.id(),
          sdk.NoteType.Public,
          sdk.u64(1000)
        )
      );
      await client.proveBlock();
      await client.syncState();
      const [mintRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([mintTransactionId])
      );
      const mintedNoteId = mintRecord.outputNotes().notes()[0].id().toString();
      const mintedNote = (await client.getInputNote(mintedNoteId)).toNote();
      await client.submitNewTransaction(
        wallet.id(),
        await client.newConsumeTransactionRequest([mintedNote], wallet.id())
      );
      await client.proveBlock();
      await client.syncState();

      const imported = await client.importPublicAccountFromSeed(
        walletSeed,
        "falcon"
      );
      return {
        ecdsaWalletId: ecdsaWallet.id().toString(),
        walletId: wallet.id().toString(),
        importedId: imported.id().toString(),
      };
    });
    expect(result.ecdsaWalletId).toBeTruthy();
    expect(result.importedId).toEqual(result.walletId);
  });
});

test.describe("import public account by id", () => {
  test("should import public account from id", async ({ run }) => {
    test.slow();
    const result = await run(async ({ sdk, helpers }) => {
      const integration = await helpers.createIntegrationClient();
      if (!integration) return { skip: true };
      const { client: intClient } = integration;

      const walletSeed = new Uint8Array(32);
      crypto.getRandomValues(walletSeed);

      const initialWallet = await intClient.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512,
        walletSeed
      );
      const initialWalletId = initialWallet.id();

      const faucet = await intClient.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucetId = faucet.id();

      // Mint
      await intClient.syncState();
      const mintRequest = await intClient.newMintTransactionRequest(
        initialWalletId,
        faucetId,
        sdk.NoteType.Private,
        sdk.u64(1000)
      );
      let execResult = await intClient.executeTransaction(
        faucetId,
        mintRequest
      );
      let prover = sdk.TransactionProver.newLocalProver();
      let proven = await intClient.proveTransaction(execResult, prover);
      let height = await intClient.submitProvenTransaction(proven, execResult);
      let execUpdate = await intClient.applyTransaction(execResult, height);
      let txId = execUpdate.executedTransaction().id().toHex();
      const createdNoteId = execUpdate
        .createdNotes()
        .notes()[0]
        .id()
        .toString();

      // Wait for mint tx
      let timeWaited = 0;
      while (timeWaited < 10000) {
        await intClient.syncState();
        const uncommitted = await intClient.getTransactions(
          sdk.TransactionFilter.uncommitted()
        );
        const ids = uncommitted.map((tx) => tx.id().toHex());
        if (!ids.includes(txId)) break;
        await new Promise((r) => setTimeout(r, 1000));
        timeWaited += 1000;
      }

      // Consume
      await intClient.syncState();
      const inputNoteRecord = await intClient.getInputNote(createdNoteId);
      const note = inputNoteRecord.toNote();
      const consumeRequest = await intClient.newConsumeTransactionRequest(
        [note],
        initialWalletId
      );
      execResult = await intClient.executeTransaction(
        initialWalletId,
        consumeRequest
      );
      prover = sdk.TransactionProver.newLocalProver();
      proven = await intClient.proveTransaction(execResult, prover);
      height = await intClient.submitProvenTransaction(proven, execResult);
      execUpdate = await intClient.applyTransaction(execResult, height);
      txId = execUpdate.executedTransaction().id().toHex();

      // Wait for consume tx
      timeWaited = 0;
      while (timeWaited < 10000) {
        await intClient.syncState();
        const uncommitted = await intClient.getTransactions(
          sdk.TransactionFilter.uncommitted()
        );
        const ids = uncommitted.map((tx) => tx.id().toHex());
        if (!ids.includes(txId)) break;
        await new Promise((r) => setTimeout(r, 1000));
        timeWaited += 1000;
      }

      const initialAccount = await intClient.getAccount(initialWalletId);
      const initialBalance = initialAccount
        .vault()
        .getBalance(faucetId)
        .toString();
      const initialCommitment = initialAccount.to_commitment().toHex();

      // Create a fresh client (separate store) and import by account ID
      const integration2 = await helpers.createIntegrationClient();
      if (!integration2) return { skip: true };
      const { client: freshClient } = integration2;

      const accountIdObj = sdk.AccountId.fromHex(initialWalletId.toString());
      await freshClient.importAccountById(accountIdObj);
      const restoredAccount = await freshClient.getAccount(accountIdObj);

      const restoredAccountId = restoredAccount.id().toString();
      const restoredAccountCommitment = restoredAccount.to_commitment().toHex();
      const restoredBalance = restoredAccount
        .vault()
        .getBalance(sdk.AccountId.fromHex(faucetId.toString()));

      return {
        skip: false,
        initialWalletIdStr: initialWalletId.toString(),
        restoredAccountId,
        initialBalance,
        restoredBalance: restoredBalance.toString(),
        initialCommitment,
        restoredAccountCommitment,
      };
    });
    if (result.skip) {
      test.skip(true, "requires running node");
      return;
    }
    expect(result.restoredAccountId).toEqual(result.initialWalletIdStr);
    expect(result.restoredBalance).toEqual(result.initialBalance);
    expect(result.restoredAccountCommitment).toEqual(result.initialCommitment);
  });
});
