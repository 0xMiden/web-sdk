import { useEffect, useMemo } from "react";
import {
  BasicFungibleFaucetComponent,
  Endpoint,
  RpcClient,
} from "@miden-sdk/miden-sdk";
import { useAssetMetadataStore, useMidenStore } from "../store/MidenStore";
import { captureClientReadGuard } from "../store/clientReadGuard";
import type { AssetMetadata } from "../types";
import { parseAccountId } from "../utils/accountParsing";

const inflight = new Map<string, () => boolean>();
const rpcClients = new Map<string, RpcClient>();

const getRpcClient = (rpcUrl: string): RpcClient | null => {
  const existing = rpcClients.get(rpcUrl);
  if (existing) return existing;

  try {
    const client = new RpcClient(new Endpoint(rpcUrl));
    rpcClients.set(rpcUrl, client);
    return client;
  } catch {
    return null;
  }
};

const fetchAssetMetadata = async (
  rpcClient: RpcClient,
  assetId: string
): Promise<AssetMetadata | null> => {
  try {
    const accountId = parseAccountId(assetId);
    const fetched = await rpcClient.getAccountDetails(accountId);
    const account = fetched.account?.();

    if (!account) return null;

    const faucet = BasicFungibleFaucetComponent.fromAccount(account as never);
    const symbol = faucet.symbol().toString();
    const decimals = faucet.decimals();

    return { assetId, symbol, decimals };
  } catch {
    return null;
  }
};

/**
 * Fetches token metadata (`symbol`, `decimals`) for fungible faucets and caches
 * it in the store.
 *
 * Reads go to the node the provider's client was created against, taken from
 * `client.endpoint()`. Nothing is fetched until `MidenProvider` has a client,
 * nor for a client that reports no endpoint (a mock client). An asset whose
 * fetch fails is cached as `{ assetId }` without `symbol` or `decimals`.
 * Responses started before a client replacement or cache reset are discarded;
 * the current client can fetch the same asset without waiting for an old read.
 *
 * @param assetIds - Faucet account IDs, hex or bech32. Pass an array even for
 *   one asset.
 * @returns `{ assetMetadata }`, a `Map` keyed by asset ID.
 */
export function useAssetMetadata(assetIds: string[] = []) {
  const assetMetadata = useAssetMetadataStore();
  const setAssetMetadata = useMidenStore((state) => state.setAssetMetadata);
  // The client is the source of the endpoint: it only appears once the provider
  // has created it against the configured node, so there is no window in which
  // an unset URL could fall back to a default network.
  const client = useMidenStore((state) => state.client);
  const cacheGeneration = useMidenStore((state) => state.cacheGeneration);
  const rpcClient = useMemo(() => {
    const endpoint = client?.endpoint();
    return endpoint ? getRpcClient(endpoint) : null;
  }, [client]);

  const uniqueAssetIds = useMemo(
    () => Array.from(new Set(assetIds.filter(Boolean))),
    [assetIds]
  );

  useEffect(() => {
    if (!client || !rpcClient || uniqueAssetIds.length === 0) return;
    const isCurrent = captureClientReadGuard(client);

    uniqueAssetIds.forEach((assetId) => {
      const existing = assetMetadata.get(assetId);
      const hasMetadata =
        existing?.symbol !== undefined || existing?.decimals !== undefined;
      if (hasMetadata || inflight.get(assetId)?.()) return;

      inflight.set(assetId, isCurrent);
      fetchAssetMetadata(rpcClient, assetId)
        .then((metadata) => {
          if (isCurrent()) {
            setAssetMetadata(assetId, metadata ?? { assetId });
          }
        })
        .finally(() => {
          if (inflight.get(assetId) === isCurrent) {
            inflight.delete(assetId);
          }
        });
    });
  }, [
    uniqueAssetIds,
    assetMetadata,
    setAssetMetadata,
    rpcClient,
    client,
    cacheGeneration,
  ]);

  return { assetMetadata };
}
