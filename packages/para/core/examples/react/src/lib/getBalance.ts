import type { MidenClient } from "@miden-sdk/miden-sdk";

export async function getBalance(client: MidenClient, accountId: string) {
  const account = await client.accounts.get(accountId);
  if (!account) {
    throw new Error("Account not found");
  }
  return account
    .vault()
    .fungibleAssets()
    .map((asset) => ({
      assetId: asset.faucetId().toString(),
      balance: (Number(asset.amount()) / 1e8).toString(),
    }));
}
