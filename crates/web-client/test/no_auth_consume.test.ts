// @ts-nocheck
/**
 * Regression test for: consuming notes against accounts created with
 * withNoAuthComponent() crashes with "null pointer passed to rust".
 *
 * Related: https://github.com/0xMiden/web-sdk/issues/135
 *          https://github.com/0xMiden/miden-client/pull/2121
 *
 * The Rust/MockChain client handles NoAuth accounts correctly.
 * This test verifies the WebClient WASM environment does too.
 */
import { mockTest as test } from "./playwright.global.setup";
import { expect, Page } from "@playwright/test";

/**
 * Creates a NoAuth account, mints a note to it via a faucet,
 * then tries to consume the note against the NoAuth account.
 */
const noAuthConsumeTest = async (testingPage: Page) => {
  return await testingPage.evaluate(async () => {
    const client = await window.MockWasmWebClient.createClient();
    await client.syncState();

    // Create a faucet (needs auth to mint)
    const faucetAccount = await client.newFaucet(
      window.AccountStorageMode.private(),
      false,
      "TST",
      8,
      BigInt(10000000),
      window.AuthScheme.AuthRpoFalcon512
    );

    // Create a NoAuth account (the account under test)
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);

    const builderResult = new window.AccountBuilder(seed)
      .accountType(window.AccountType.RegularAccountImmutableCode)
      .storageMode(window.AccountStorageMode.tryFromStr("public"))
      .withBasicWalletComponent()
      .withNoAuthComponent()
      .build();

    const noAuthAccount = builderResult.account;
    await client.newAccount(noAuthAccount, false);

    // Mint tokens to the NoAuth account
    const mintRequest = await client.newMintTransactionRequest(
      noAuthAccount.id(),
      faucetAccount.id(),
      window.NoteType.Public,
      BigInt(500)
    );

    const mintTxId = await client.submitNewTransaction(
      faucetAccount.id(),
      mintRequest
    );
    await client.proveBlock();
    await client.syncState();

    // Get the minted note
    const [mintTxRecord] = await client.getTransactions(
      window.TransactionFilter.ids([mintTxId])
    );
    if (!mintTxRecord) {
      throw new Error("Mint transaction record not found");
    }

    const mintedNoteId = mintTxRecord
      .outputNotes()
      .notes()[0]
      .id()
      .toString();

    const mintedNoteRecord = await client.getInputNote(mintedNoteId);
    if (!mintedNoteRecord) {
      throw new Error(`Note with ID ${mintedNoteId} not found`);
    }

    // Consume the note against the NoAuth account — this is the bug repro
    const mintedNote = mintedNoteRecord.toNote();
    const consumeRequest = client.newConsumeTransactionRequest([mintedNote]);
    await client.submitNewTransaction(noAuthAccount.id(), consumeRequest);
    await client.proveBlock();
    await client.syncState();

    // Verify the balance was updated
    const updatedAccount = await client.getAccount(noAuthAccount.id());
    const balance = updatedAccount
      .vault()
      .getBalance(faucetAccount.id())
      .toString();

    return { balance };
  });
};

test.describe("no-auth account consume tests", () => {
  test.describe.configure({ timeout: 720000 });

  test("consuming a note against a NoAuth account succeeds", async ({
    page,
  }) => {
    const { balance } = await noAuthConsumeTest(page);
    expect(balance).toEqual("500");
  });
});
