import test from "./playwright.global.setup";
import { expect, Page } from "@playwright/test";
import {
  setupWalletAndFaucet,
  mintAndConsumeTransaction,
} from "./webClientTestUtils";

// SUBMIT_NEW_TRANSACTION_BATCH TESTS
// ================================================================================================

interface BatchSubmitResult {
  blockNum: number;
  nonceBefore: string;
  nonceAfter: string;
}

const submitTwoTxBatch = async (
  testingPage: Page,
  senderAccount: string,
  targetAccount: string,
  faucetAccount: string
): Promise<BatchSubmitResult> => {
  return await testingPage.evaluate(
    async ({ _senderAccount, _targetAccount, _faucetAccount }) => {
      const client = window.client;

      await client.syncState();

      const senderAccountId = window.AccountId.fromHex(_senderAccount);
      const targetAccountId = window.AccountId.fromHex(_targetAccount);
      const faucetAccountId = window.AccountId.fromHex(_faucetAccount);

      // Snapshot the sender's nonce before the batch. The sender's wallet uses
      // IncrNonce auth, so nonce advances by exactly 1 per tx — checking a 2-tx
      // batch advances nonce by exactly 2 is a direct test of BatchBuilder's
      // per-push account state stacking.
      const senderBefore = await client.getAccount(senderAccountId);
      const nonceBefore = senderBefore!.nonce()!.toString();

      // Build two P2ID send requests of 50 tokens each.
      const sendRequest1 = await client.newSendTransactionRequest(
        senderAccountId,
        targetAccountId,
        faucetAccountId,
        window.NoteType.Public,
        BigInt(50),
        null,
        null
      );
      const sendRequest2 = await client.newSendTransactionRequest(
        senderAccountId,
        targetAccountId,
        faucetAccountId,
        window.NoteType.Public,
        BigInt(50),
        null,
        null
      );

      const blockNum = await client.submitNewTransactionBatch([
        new window.BatchItem(
          window.AccountId.fromHex(_senderAccount),
          sendRequest1
        ),
        new window.BatchItem(
          window.AccountId.fromHex(_senderAccount),
          sendRequest2
        ),
      ]);

      // Poll until the sender nonce has advanced by 2, giving the node time to
      // finalize the batch's block.
      const targetNonce = BigInt(nonceBefore) + BigInt(2);
      let nonceAfter = nonceBefore;
      for (let attempt = 0; attempt < 60; attempt++) {
        await client.syncState();
        const senderAfter = await client.getAccount(senderAccountId);
        nonceAfter = senderAfter!.nonce()!.toString();
        if (BigInt(nonceAfter) >= targetNonce) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      return { blockNum, nonceBefore, nonceAfter };
    },
    {
      _senderAccount: senderAccount,
      _targetAccount: targetAccount,
      _faucetAccount: faucetAccount,
    }
  );
};

interface MultiAccountBatchResult {
  blockNum: number;
  nonceADelta: string;
  nonceBDelta: string;
  aBalance: string;
  bBalance: string;
}

const submitCrossAccountBatch = async (
  testingPage: Page,
  accountA: string,
  accountB: string,
  faucetAccount: string,
  transferAmount: bigint
): Promise<MultiAccountBatchResult> => {
  return await testingPage.evaluate(
    async ({ _accountA, _accountB, _faucet, _transferAmount }) => {
      const client = window.client;
      await client.syncState();

      const idA = window.AccountId.fromHex(_accountA);
      const idB = window.AccountId.fromHex(_accountB);
      const faucetId = window.AccountId.fromHex(_faucet);

      const beforeA = await client.getAccount(idA);
      const beforeB = await client.getAccount(idB);
      const nonceABefore = BigInt(beforeA!.nonce()!.toString());
      const nonceBBefore = BigInt(beforeB!.nonce()!.toString());

      // tx1 (A → B): P2ID transfer. Extract the expected output note so tx2
      // can consume it in the same batch.
      const sendRequest = await client.newSendTransactionRequest(
        idA,
        idB,
        faucetId,
        window.NoteType.Private,
        BigInt(_transferAmount),
        null,
        null
      );
      const expectedNotes = sendRequest.expectedOutputOwnNotes();
      if (expectedNotes.length !== 1) {
        throw new Error(
          `expected exactly 1 output note from send request, got ${expectedNotes.length}`
        );
      }
      const inBatchNote = expectedNotes[0];

      // tx2 (B): consume the in-batch note produced by tx1.
      const consumeRequest = await client.newConsumeTransactionRequest([
        inBatchNote,
      ]);

      const blockNum = await client.submitNewTransactionBatch([
        new window.BatchItem(window.AccountId.fromHex(_accountA), sendRequest),
        new window.BatchItem(
          window.AccountId.fromHex(_accountB),
          consumeRequest
        ),
      ]);

      // Poll until both accounts' nonces advance by 1.
      let nonceAAfter = nonceABefore;
      let nonceBAfter = nonceBBefore;
      for (let attempt = 0; attempt < 60; attempt++) {
        await client.syncState();
        const afterA = await client.getAccount(idA);
        const afterB = await client.getAccount(idB);
        nonceAAfter = BigInt(afterA!.nonce()!.toString());
        nonceBAfter = BigInt(afterB!.nonce()!.toString());
        if (
          nonceAAfter >= nonceABefore + BigInt(1) &&
          nonceBAfter >= nonceBBefore + BigInt(1)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      const finalA = await client.getAccount(idA);
      const finalB = await client.getAccount(idB);
      const aBalance = finalA!.vault().getBalance(faucetId).toString();
      const bBalance = finalB!.vault().getBalance(faucetId).toString();

      return {
        blockNum,
        nonceADelta: (nonceAAfter - nonceABefore).toString(),
        nonceBDelta: (nonceBAfter - nonceBBefore).toString(),
        aBalance,
        bBalance,
      };
    },
    {
      _accountA: accountA,
      _accountB: accountB,
      _faucet: faucetAccount,
      _transferAmount: transferAmount.toString(),
    }
  );
};

interface InterleavedBatchResult {
  blockNum: number;
  nonceADelta: string;
  nonceBDelta: string;
}

const submitInterleavedBatch = async (
  testingPage: Page,
  accountA: string,
  accountB: string,
  faucetAccount: string,
  transferAmount: bigint
): Promise<InterleavedBatchResult> => {
  // A→B, B→A, A→B in order. Forces the in-memory batch data store to
  // serve A's post-push-1 state to push 3 even though push 2 targets B.
  return await testingPage.evaluate(
    async ({ _accountA, _accountB, _faucet, _transferAmount }) => {
      const client = window.client;
      await client.syncState();

      const idA = window.AccountId.fromHex(_accountA);
      const idB = window.AccountId.fromHex(_accountB);
      const faucetId = window.AccountId.fromHex(_faucet);

      const beforeA = await client.getAccount(idA);
      const beforeB = await client.getAccount(idB);
      const nonceABefore = BigInt(beforeA!.nonce()!.toString());
      const nonceBBefore = BigInt(beforeB!.nonce()!.toString());

      const reqAtoBFirst = await client.newSendTransactionRequest(
        idA,
        idB,
        faucetId,
        window.NoteType.Private,
        BigInt(_transferAmount),
        null,
        null
      );
      const reqBtoA = await client.newSendTransactionRequest(
        idB,
        idA,
        faucetId,
        window.NoteType.Private,
        BigInt(_transferAmount),
        null,
        null
      );
      const reqAtoBSecond = await client.newSendTransactionRequest(
        idA,
        idB,
        faucetId,
        window.NoteType.Private,
        BigInt(_transferAmount),
        null,
        null
      );

      const blockNum = await client.submitNewTransactionBatch([
        new window.BatchItem(window.AccountId.fromHex(_accountA), reqAtoBFirst),
        new window.BatchItem(window.AccountId.fromHex(_accountB), reqBtoA),
        new window.BatchItem(
          window.AccountId.fromHex(_accountA),
          reqAtoBSecond
        ),
      ]);

      // A advances by 2, B advances by 1.
      let nonceAAfter = nonceABefore;
      let nonceBAfter = nonceBBefore;
      for (let attempt = 0; attempt < 60; attempt++) {
        await client.syncState();
        const afterA = await client.getAccount(idA);
        const afterB = await client.getAccount(idB);
        nonceAAfter = BigInt(afterA!.nonce()!.toString());
        nonceBAfter = BigInt(afterB!.nonce()!.toString());
        if (
          nonceAAfter >= nonceABefore + BigInt(2) &&
          nonceBAfter >= nonceBBefore + BigInt(1)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      return {
        blockNum,
        nonceADelta: (nonceAAfter - nonceABefore).toString(),
        nonceBDelta: (nonceBAfter - nonceBBefore).toString(),
      };
    },
    {
      _accountA: accountA,
      _accountB: accountB,
      _faucet: faucetAccount,
      _transferAmount: transferAmount.toString(),
    }
  );
};

const submitDuplicateNoteBatch = async (
  testingPage: Page,
  accountA: string,
  accountB: string,
  faucetAccount: string
): Promise<{ rejected: boolean; errorMessage: string }> => {
  return await testingPage.evaluate(
    async ({ _accountA, _accountB, _faucet }) => {
      const client = window.client;
      await client.syncState();

      const idA = window.AccountId.fromHex(_accountA);
      const idB = window.AccountId.fromHex(_accountB);
      const faucetId = window.AccountId.fromHex(_faucet);

      // Mint a private note destined for A (so the note exists on-chain and
      // both A and B can attempt to consume it).
      const mintRequest = await client.newMintTransactionRequest(
        idA,
        faucetId,
        window.NoteType.Private,
        BigInt(100)
      );
      const mintUpdate = await window.helpers.executeAndApplyTransaction(
        faucetId,
        mintRequest,
        undefined
      );
      const outputNoteId = mintUpdate
        .executedTransaction()
        .outputNotes()
        .notes()[0]
        .id()
        .toString();
      await window.helpers.waitForTransaction(
        mintUpdate.executedTransaction().id().toHex()
      );

      // Resolve the input-note record so we can mint two fresh `Note` JS
      // proxies — each consume request consumes its array contents through
      // wasm-bindgen, so reusing the same proxy would invalidate the second.
      await client.syncState();
      const inputRecord = await client.getInputNote(outputNoteId);
      if (!inputRecord) {
        throw new Error(`Could not find minted note ${outputNoteId} in store`);
      }

      // Both consume requests target the same note id. The batch must reject
      // the second push with a DuplicateInputNote error before reaching the
      // node.
      const reqA = await client.newConsumeTransactionRequest([
        inputRecord.toNote(),
      ]);
      const reqB = await client.newConsumeTransactionRequest([
        inputRecord.toNote(),
      ]);

      try {
        await client.submitNewTransactionBatch([
          new window.BatchItem(window.AccountId.fromHex(_accountA), reqA),
          new window.BatchItem(window.AccountId.fromHex(_accountB), reqB),
        ]);
        return { rejected: false, errorMessage: "" };
      } catch (err) {
        return {
          rejected: true,
          errorMessage: String(err instanceof Error ? err.message : err),
        };
      }
    },
    {
      _accountA: accountA,
      _accountB: accountB,
      _faucet: faucetAccount,
    }
  );
};

test.describe("submitNewTransactionBatch tests", () => {
  test("2-tx batch advances sender nonce by exactly 2", async ({ page }) => {
    test.setTimeout(900000);

    // Set up a sender wallet with funds and a separate target wallet.
    const { accountId: senderAccountId, faucetId } =
      await setupWalletAndFaucet(page);
    const { accountId: targetAccountId } = await setupWalletAndFaucet(page);

    // Fund the sender with tokens from the faucet.
    await mintAndConsumeTransaction(page, senderAccountId, faucetId);

    const result = await submitTwoTxBatch(
      page,
      senderAccountId,
      targetAccountId,
      faucetId
    );

    expect(result.blockNum).toBeGreaterThan(0);

    // Explicit state-stacking check: if BatchBuilder didn't stack state between
    // pushes, both txs would carry the same initial_account_state and the node
    // would reject the batch — the delta below would be 0 or 1, not 2.
    const delta = BigInt(result.nonceAfter) - BigInt(result.nonceBefore);
    expect(delta).toEqual(BigInt(2));
  });

  test("cross-account batch: A sends, B consumes the in-batch note", async ({
    page,
  }) => {
    test.setTimeout(900000);

    // Both accounts get pre-funded so each has a partial (not full-state)
    // delta in the batch — the batch apply path requires partial deltas.
    const { accountId: accountA, faucetId } = await setupWalletAndFaucet(page);
    const { accountId: accountB } = await setupWalletAndFaucet(page);
    await mintAndConsumeTransaction(page, accountA, faucetId);
    await mintAndConsumeTransaction(page, accountB, faucetId);

    const transferAmount = BigInt(40);
    const result = await submitCrossAccountBatch(
      page,
      accountA,
      accountB,
      faucetId,
      transferAmount
    );

    expect(result.blockNum).toBeGreaterThan(0);
    // Each account contributes exactly one transaction.
    expect(result.nonceADelta).toEqual("1");
    expect(result.nonceBDelta).toEqual("1");
    // A pre-mint of 1000 (from mintAndConsumeTransaction) minus the transferred
    // amount; B holds its pre-mint plus the transferred amount.
    expect(result.aBalance).toEqual((BigInt(1000) - transferAmount).toString());
    expect(result.bBalance).toEqual((BigInt(1000) + transferAmount).toString());
  });

  test("interleaved A→B→A pushes share A's in-batch state", async ({
    page,
  }) => {
    test.setTimeout(900000);

    const { accountId: accountA, faucetId } = await setupWalletAndFaucet(page);
    const { accountId: accountB } = await setupWalletAndFaucet(page);
    await mintAndConsumeTransaction(page, accountA, faucetId);
    await mintAndConsumeTransaction(page, accountB, faucetId);

    const transferAmount = BigInt(20);
    const result = await submitInterleavedBatch(
      page,
      accountA,
      accountB,
      faucetId,
      transferAmount
    );

    expect(result.blockNum).toBeGreaterThan(0);
    // A pushed twice (positions 0 and 2). If A's cache weren't reused on
    // push 3, the third tx's `initial_account_state` wouldn't match the
    // chain A would have produced and the node would reject the batch —
    // the delta would never reach 2.
    expect(result.nonceADelta).toEqual("2");
    expect(result.nonceBDelta).toEqual("1");
  });

  test("duplicate input note across accounts is rejected at push time", async ({
    page,
  }) => {
    test.setTimeout(900000);

    const { accountId: accountA, faucetId } = await setupWalletAndFaucet(page);
    const { accountId: accountB } = await setupWalletAndFaucet(page);
    // Pre-fund A so its first batch tx has a partial delta.
    await mintAndConsumeTransaction(page, accountA, faucetId);

    const { rejected, errorMessage } = await submitDuplicateNoteBatch(
      page,
      accountA,
      accountB,
      faucetId
    );

    expect(rejected).toBe(true);
    // BatchBuilderError::DuplicateInputNote formats as "input note <id> is
    // already consumed by an earlier transaction in this batch".
    expect(errorMessage.toLowerCase()).toContain("already consumed");
  });
});
