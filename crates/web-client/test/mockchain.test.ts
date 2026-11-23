// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("mock chain tests", () => {
  test.describe.configure({ timeout: 720000 });

  test("send transaction with mock chain completes successfully", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      const account = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucetAccount = await client.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const mintTransactionRequest = await client.newMintTransactionRequest(
        account.id(),
        faucetAccount.id(),
        sdk.NoteType.Public,
        sdk.u64(1000)
      );

      const mintTransactionId = await client.submitNewTransaction(
        faucetAccount.id(),
        mintTransactionRequest
      );
      await client.proveBlock();
      await client.syncState();

      const [mintTransactionRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([mintTransactionId])
      );

      const mintedNoteId = mintTransactionRecord
        .outputNotes()
        .notes()[0]
        .id()
        .toString();

      const mintedNoteRecord = await client.getInputNote(mintedNoteId);

      const mintedNote = mintedNoteRecord.toNote();
      const consumeTransactionRequest =
        await client.newConsumeTransactionRequest([mintedNote], account.id());
      await client.submitNewTransaction(
        account.id(),
        consumeTransactionRequest
      );
      await client.proveBlock();
      await client.syncState();

      const changedTargetAccount = await client.getAccount(account.id());

      const finalBalance = changedTargetAccount
        .vault()
        .getBalance(faucetAccount.id())
        .toString();

      return {
        mintTransactionRecordDefined: mintTransactionRecord !== undefined,
        mintedNoteRecordDefined: mintedNoteRecord !== undefined,
        finalBalance,
      };
    });

    expect(result.mintTransactionRecordDefined).toBe(true);
    expect(result.mintedNoteRecordDefined).toBe(true);
    expect(result.finalBalance).toEqual("1000");
  });

  // Issue #557: a second mock with its own storeName syncs while the fixture
  // mock still holds mock_client_db.
  test("second mock with distinct storeName can syncState beside the fixture", async ({
    run,
  }) => {
    const result = await run(async ({ helpers }) => {
      const fresh = await helpers.createFreshMockClient();
      await fresh.syncState();
      return { synced: true };
    });
    expect(result.synced).toBe(true);
  });

  test("worker-backed mock with distinct storeName can sync beside the fixture", async ({
    run,
  }) => {
    const result = await run(async ({ helpers }) => {
      const isolatedStore = `mock_worker_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const workerMock = await helpers.createMidenMockClient({
        storeName: isolatedStore,
      });
      try {
        await workerMock.sync();
        await workerMock.syncChain();
        await workerMock.syncNoteTransport();
        return {
          synced: true,
          hadWorker: typeof Worker !== "undefined",
          isolatedStore,
          storeIdentifier: await workerMock.storeIdentifier(),
        };
      } finally {
        workerMock.terminate();
      }
    });
    expect(result.synced).toBe(true);
    if (result.hadWorker) {
      expect(result.storeIdentifier).toBe(result.isolatedStore);
    }
  });
});
