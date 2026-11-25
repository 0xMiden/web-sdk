// Browser-only tests preserved from `next`.
// These require `isolatedClient` helper which only works in the browser.
import test from "./playwright.global.setup";
import { expect } from "@playwright/test";
import { createNewWallet, StorageMode } from "./webClientTestUtils";

test.describe("new_wallet tests (browser-only)", () => {
  test("Constructs the same account when given the same init seed", async ({
    page,
  }) => {
    const clientSeed1 = new Uint8Array(32);
    const clientSeed2 = new Uint8Array(32);
    const walletSeed = new Uint8Array(32);
    const authSchemeId = 2;
    crypto.getRandomValues(clientSeed1);
    crypto.getRandomValues(clientSeed2);
    crypto.getRandomValues(walletSeed);

    const wallet = await createNewWallet(page, {
      storageMode: StorageMode.PUBLIC,
      authSchemeId,
      clientSeed: clientSeed1,
      isolatedClient: true,
      walletSeed: walletSeed,
    });

    const independentWalletId = await page.evaluate(
      async ({ authSchemeId, clientSeed, walletSeed }) => {
        const client = await window.helpers.createClient(
          `deterministic-wallet-${crypto.randomUUID()}`,
          new Uint8Array(clientSeed)
        );
        try {
          const account = await client.newWallet(
            window.AccountStorageMode.public(),
            authSchemeId,
            new Uint8Array(walletSeed)
          );
          return account.id().toString();
        } finally {
          await client.terminate();
        }
      },
      {
        authSchemeId,
        clientSeed: Array.from(clientSeed2),
        walletSeed: Array.from(walletSeed),
      }
    );
    expect(independentWalletId).toBe(wallet.id);

    // Reopening the original store must still reject the duplicate and preserve its account.
    await expect(
      createNewWallet(page, {
        storageMode: StorageMode.PUBLIC,
        authSchemeId,
        clientSeed: clientSeed2,
        isolatedClient: true,
        walletSeed: walletSeed,
      })
    ).rejects.toThrowError(
      /storage error: Failed to insert item into IndexedDB|failed to insert new wallet/
    );
    const trackedWalletIds = await page.evaluate(async () =>
      (await window.client.getAccounts()).map((account) =>
        account.id().toString()
      )
    );
    expect(trackedWalletIds).toEqual([wallet.id]);
  });
});
