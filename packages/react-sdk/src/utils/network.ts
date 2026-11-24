import type { MidenNetwork, RpcUrlConfig } from "../types";

const RPC_URLS = {
  mainnet: "https://rpc.mainnet.miden.io",
  testnet: "https://rpc.testnet.miden.io",
  devnet: "https://rpc.devnet.miden.io",
  localhost: "http://localhost:57291",
};

export function resolveRpcUrl(rpcUrl?: RpcUrlConfig): string | undefined {
  if (!rpcUrl) {
    return undefined;
  }

  const normalized = rpcUrl.trim().toLowerCase();
  if (normalized === "mainnet") {
    return RPC_URLS.mainnet;
  }
  if (normalized === "testnet") {
    return RPC_URLS.testnet;
  }
  if (normalized === "devnet") {
    return RPC_URLS.devnet;
  }
  if (normalized === "localhost" || normalized === "local") {
    return RPC_URLS.localhost;
  }

  return rpcUrl;
}

/**
 * The network an address is formatted for. An explicit `network` wins; else the
 * endpoint's name decides, and an endpoint naming no network is mainnet.
 * `null` only when there is no endpoint yet (no client).
 */
export function resolveNetworkName(
  endpoint: string | undefined,
  network?: MidenNetwork
): MidenNetwork | null {
  const url = endpoint?.toLowerCase();
  if (!url) {
    return null;
  }
  if (network) {
    return network;
  }
  if (url.includes("devnet") || url.includes("mdev")) {
    return "devnet";
  }
  if (url.includes("testnet") || url.includes("mtst")) {
    return "testnet";
  }
  if (url.includes("localhost") || url.includes("127.0.0.1")) {
    // A local node is a development chain, so it takes the devnet prefix.
    return "devnet";
  }
  return "mainnet";
}
