// @ts-nocheck
import { test, expect } from "./test-setup";

// PSWAP_TRANSACTION TEST
// =======================================================================================================

test.describe("pswap transaction tests", () => {
  test("pswap full fill completes successfully", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: walletA, faucet: faucetA } =
        await helpers.setupWalletAndFaucet();
      const { wallet: walletB, faucet: faucetB } =
        await helpers.setupWalletAndFaucet();

      // Fund the creator with the offered asset and the filler with the
      // requested asset.
      await helpers.mockMintAndConsume(walletA.id(), faucetA.id());
      await helpers.mockMintAndConsume(walletB.id(), faucetB.id());

      const faucetAId = faucetA.id().toString();
      const faucetBId = faucetB.id().toString();

      const { creatorAssets, fillerAssets, consumeOutputNoteCount } =
        await helpers.mockPswapFullFill(
          walletA.id(),
          walletB.id(),
          faucetA.id(),
          1,
          faucetB.id(),
          25,
          "private",
          "private"
        );

      return {
        creatorAssets,
        fillerAssets,
        consumeOutputNoteCount,
        faucetAId,
        faucetBId,
      };
    });

    // A full fill emits a single payback note — no remainder PSWAP note.
    expect(result.consumeOutputNoteCount).toEqual(1);

    // --- creator (Account A) ---
    const cA = result.creatorAssets.find((a) => a.assetId === result.faucetAId);
    expect(cA, `Expected faucetA asset on the creator`).toBeTruthy();
    expect(BigInt(cA.amount)).toEqual(999n);

    const cB = result.creatorAssets.find((a) => a.assetId === result.faucetBId);
    expect(cB, `Expected faucetB asset on the creator`).toBeTruthy();
    expect(BigInt(cB.amount)).toEqual(25n);

    // --- filler (Account B) ---
    const fA = result.fillerAssets.find((a) => a.assetId === result.faucetAId);
    expect(fA, `Expected faucetA asset on the filler`).toBeTruthy();
    expect(BigInt(fA.amount)).toEqual(1n);

    const fB = result.fillerAssets.find((a) => a.assetId === result.faucetBId);
    expect(fB, `Expected faucetB asset on the filler`).toBeTruthy();
    expect(BigInt(fB.amount)).toEqual(975n);
  });

  test("pswap partial fill emits a remainder note for the unfilled amount", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: walletA, faucet: faucetA } =
        await helpers.setupWalletAndFaucet();
      const { wallet: walletB, faucet: faucetB } =
        await helpers.setupWalletAndFaucet();

      await helpers.mockMintAndConsume(walletA.id(), faucetA.id());
      await helpers.mockMintAndConsume(walletB.id(), faucetB.id());

      const faucetAId = faucetA.id().toString();
      const faucetBId = faucetB.id().toString();

      // Offer 100 of faucetA for 25 of faucetB, but the filler only supplies
      // 10 of faucetB (a 10/25 fill). The filler should receive 40 of faucetA
      // (100 * 10 / 25) and a remainder PSWAP note carrying the other 60.
      const {
        creatorAssets,
        fillerAssets,
        consumeOutputNoteCount,
        remainderOfferedAmount,
      } = await helpers.mockPswapPartialFill(
        walletA.id(),
        walletB.id(),
        faucetA.id(),
        100,
        faucetB.id(),
        25,
        10,
        "private",
        "private"
      );

      return {
        creatorAssets,
        fillerAssets,
        consumeOutputNoteCount,
        remainderOfferedAmount,
        faucetAId,
        faucetBId,
      };
    });

    // A partial fill emits a payback note AND a remainder PSWAP note.
    expect(result.consumeOutputNoteCount).toEqual(2);

    // The remainder PSWAP note carries the unfilled offered amount.
    expect(result.remainderOfferedAmount).toBeTruthy();
    expect(BigInt(result.remainderOfferedAmount)).toEqual(60n);

    // --- creator (Account A): minted 1000 faucetA, locked 100 into the PSWAP
    //     note (→ 900 left), then consumed a payback note carrying 10 faucetB.
    const cA = result.creatorAssets.find((a) => a.assetId === result.faucetAId);
    expect(cA, `Expected faucetA asset on the creator`).toBeTruthy();
    expect(BigInt(cA.amount)).toEqual(900n);

    const cB = result.creatorAssets.find((a) => a.assetId === result.faucetBId);
    expect(cB, `Expected faucetB asset on the creator`).toBeTruthy();
    expect(BigInt(cB.amount)).toEqual(10n);

    // --- filler (Account B): minted 1000 faucetB, supplied 10 (→ 990 left),
    //     received 40 faucetA for the filled portion.
    const fA = result.fillerAssets.find((a) => a.assetId === result.faucetAId);
    expect(fA, `Expected faucetA asset on the filler`).toBeTruthy();
    expect(BigInt(fA.amount)).toEqual(40n);

    const fB = result.fillerAssets.find((a) => a.assetId === result.faucetBId);
    expect(fB, `Expected faucetB asset on the filler`).toBeTruthy();
    expect(BigInt(fB.amount)).toEqual(990n);

    // Conservation: the offered 100 splits into the filler's share plus the
    // remainder note, with nothing created or destroyed.
    expect(BigInt(fA.amount) + BigInt(result.remainderOfferedAmount)).toEqual(
      100n
    );
  });

  test("pswap cancel reclaims the offered asset", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      const { faucet: requestedFaucet } = await helpers.setupWalletAndFaucet();

      // Fund the creator with 1000 of the offered asset.
      await helpers.mockMintAndConsume(wallet.id(), faucet.id());

      const offeredFaucetId = faucet.id().toString();

      const { creatorAssets } = await helpers.mockPswapCancel(
        wallet.id(),
        faucet.id(),
        100,
        requestedFaucet.id(),
        25,
        "private"
      );

      return { creatorAssets, offeredFaucetId };
    });

    // The 100 units locked into the PSWAP note are returned to the creator,
    // leaving the full minted balance intact.
    const offered = result.creatorAssets.find(
      (a) => a.assetId === result.offeredFaucetId
    );
    expect(
      offered,
      `Expected the offered asset back on the creator`
    ).toBeTruthy();
    expect(BigInt(offered.amount)).toEqual(1000n);
  });

  test("pswap create rejects offering and requesting the same asset", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(wallet.id(), faucet.id());

      let threw = false;
      let message = "";
      try {
        await client.newPswapCreateTransactionRequest(
          wallet.id(),
          faucet.id(),
          sdk.u64(100),
          faucet.id(),
          sdk.u64(50),
          sdk.NoteType.Private,
          sdk.NoteType.Private
        );
      } catch (err) {
        threw = true;
        message = String((err && err.message) || err);
      }
      return { threw, message };
    });

    expect(result.threw).toBe(true);
    // Assert it failed for the right reason, not some unrelated throw.
    expect(result.message).toMatch(
      /offered and requested assets must have different faucets/i
    );
  });

  test("pswap consume rejects a fill larger than the requested amount", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: filler, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      await helpers.mockMintAndConsume(filler.id(), requestedFaucet.id());

      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      const createTxId = await client.submitNewTransaction(
        creator.id(),
        createRequest
      );
      await client.proveBlock();
      await client.syncState();
      const [createTxRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([createTxId])
      );
      const pswapNoteId = createTxRecord
        .outputNotes()
        .notes()[0]
        .id()
        .toString();
      const pswapNoteRecord = await client.getInputNote(pswapNoteId);

      let threw = false;
      let message = "";
      try {
        // Fill 50 against a note that only requests 25.
        const consumeRequest = client.newPswapConsumeTransactionRequest(
          pswapNoteRecord.toNote(),
          filler.id(),
          sdk.u64(50),
          sdk.u64(0)
        );
        await client.submitNewTransaction(filler.id(), consumeRequest);
        await client.proveBlock();
        await client.syncState();
      } catch (err) {
        threw = true;
        message = String((err && err.message) || err);
      }
      return { threw, message };
    });

    expect(result.threw).toBe(true);
    // Assert it failed for the right reason, not some unrelated throw.
    expect(result.message).toMatch(/exceeds requested amount/i);
  });

  test("pswap consume rejects a zero fill", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: filler, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());
      await helpers.mockMintAndConsume(filler.id(), requestedFaucet.id());

      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      const createTxId = await client.submitNewTransaction(
        creator.id(),
        createRequest
      );
      await client.proveBlock();
      await client.syncState();
      const [createTxRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([createTxId])
      );
      const pswapNoteId = createTxRecord
        .outputNotes()
        .notes()[0]
        .id()
        .toString();
      const pswapNoteRecord = await client.getInputNote(pswapNoteId);

      let threw = false;
      let message = "";
      try {
        // Fill 0 against a note that requests 25.
        const consumeRequest = client.newPswapConsumeTransactionRequest(
          pswapNoteRecord.toNote(),
          filler.id(),
          sdk.u64(0),
          sdk.u64(0)
        );
        await client.submitNewTransaction(filler.id(), consumeRequest);
        await client.proveBlock();
        await client.syncState();
      } catch (err) {
        threw = true;
        message = String((err && err.message) || err);
      }
      return { threw, message };
    });

    expect(result.threw).toBe(true);
    // Assert it failed for the right reason, not some unrelated throw.
    expect(result.message).toMatch(/fill amount must be greater than 0/i);
  });

  test("pswap cancel rejects a non-creator", async ({ run }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet: creator, faucet: offeredFaucet } =
        await helpers.setupWalletAndFaucet();
      const { wallet: stranger, faucet: requestedFaucet } =
        await helpers.setupWalletAndFaucet();
      await helpers.mockMintAndConsume(creator.id(), offeredFaucet.id());

      const createRequest = await client.newPswapCreateTransactionRequest(
        creator.id(),
        offeredFaucet.id(),
        sdk.u64(100),
        requestedFaucet.id(),
        sdk.u64(25),
        sdk.NoteType.Private,
        sdk.NoteType.Private
      );
      const createTxId = await client.submitNewTransaction(
        creator.id(),
        createRequest
      );
      await client.proveBlock();
      await client.syncState();
      const [createTxRecord] = await client.getTransactions(
        sdk.TransactionFilter.ids([createTxId])
      );
      const pswapNoteId = createTxRecord
        .outputNotes()
        .notes()[0]
        .id()
        .toString();
      const pswapNoteRecord = await client.getInputNote(pswapNoteId);

      let threw = false;
      let message = "";
      try {
        // A non-creator account attempts to cancel and reclaim the offer.
        const cancelRequest = client.newPswapCancelTransactionRequest(
          pswapNoteRecord.toNote(),
          stranger.id()
        );
        await client.submitNewTransaction(stranger.id(), cancelRequest);
        await client.proveBlock();
        await client.syncState();
      } catch (err) {
        threw = true;
        message = String((err && err.message) || err);
      }
      return { threw, message };
    });

    expect(result.threw).toBe(true);
    // Assert it failed for the right reason, not some unrelated throw.
    expect(result.message).toMatch(/can only be cancelled by its creator/i);
  });
});
