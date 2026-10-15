import { useEffect, useMemo } from "react";
import {
  BasicFungibleFaucetComponent,
  Endpoint,
  NonFungibleFaucetComponent,
  RpcClient,
} from "@miden-sdk/miden-sdk";
import { useAssetMetadataStore, useMidenStore } from "../store/MidenStore";
import type { AssetMetadata } from "../types";
import { parseAccountId } from "../utils/accountParsing";

const inflight = new Map<string, Promise<void>>();
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

    try {
      const faucet = BasicFungibleFaucetComponent.fromAccount(account as never);
      return {
        assetId,
        symbol: faucet.symbol().toString(),
        decimals: faucet.decimals(),
      };
    } catch {
      // Not a fungible faucet: read the collection symbol of a non-fungible one.
      const collection = NonFungibleFaucetComponent.fromAccount(
        account as never
      );
      return { assetId, symbol: collection.symbol().toString() };
    }
  } catch {
    return null;
  }
};

/**
 * Fetches token metadata (`symbol`, `decimals`) for fungible faucets, and the
 * collection `symbol` for non-fungible faucets, and caches it in the store.
 *
 * Reads go to the node the provider's client was created against, taken from
 * `client.endpoint()`. Nothing is fetched until `MidenProvider` has a client,
 * nor for a client that reports no endpoint (a mock client). An asset whose
 * fetch fails is cached as `{ assetId }` without `symbol` or `decimals`.
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
  const rpcClient = useMemo(() => {
    const endpoint = client?.endpoint();
    return endpoint ? getRpcClient(endpoint) : null;
  }, [client]);

  const uniqueAssetIds = useMemo(
    () => Array.from(new Set(assetIds.filter(Boolean))),
    [assetIds]
  );

  useEffect(() => {
    if (!rpcClient || uniqueAssetIds.length === 0) return;

    uniqueAssetIds.forEach((assetId) => {
      const existing = assetMetadata.get(assetId);
      const hasMetadata =
        existing?.symbol !== undefined || existing?.decimals !== undefined;
      if (hasMetadata || inflight.has(assetId)) return;

      const promise = fetchAssetMetadata(rpcClient, assetId)
        .then((metadata) => {
          setAssetMetadata(assetId, metadata ?? { assetId });
        })
        .finally(() => {
          inflight.delete(assetId);
        });

      inflight.set(assetId, promise);
    });
  }, [uniqueAssetIds, assetMetadata, setAssetMetadata, rpcClient]);

  return { assetMetadata };
}
