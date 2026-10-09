import type { NonFungibleAsset } from "@miden-sdk/miden-sdk";
import type { NonFungibleAssetInfo } from "../types";

/** Reads the hex fields of a `NonFungibleAsset` into a {@link NonFungibleAssetInfo}. */
export const toNonFungibleAssetInfo = (
  asset: NonFungibleAsset
): NonFungibleAssetInfo => ({
  faucetId: asset.faucetId().toString(),
  vaultKey: asset.vaultKey().toHex(),
  value: asset.intoWord().toHex(),
  asset,
});
