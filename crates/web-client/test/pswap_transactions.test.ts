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
        await helpers.mockPswap(
          walletA.id(),
          walletB.id(),
          faucetA.id(),
          1,
          faucetB.id(),
          25,
          25, // full fill: filler supplies the entire requested amount
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
});
