import type { RpcUrlConfig } from "../types";

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

export type MidenNetwork = "mainnet" | "testnet" | "devnet";

export function resolveNetworkName(
  endpoint: string | undefined,
  network?: MidenNetwork
): MidenNetwork | null {
  const url = endpoint?.toLowerCase();
  if (!url) {
    return null;
  }
  if (url.includes("devnet") || url.includes("mdev")) {
    return "devnet";
  }
  if (url.includes("mainnet")) {
    return "mainnet";
  }
  if (url.includes("testnet") || url.includes("mtst")) {
    return "testnet";
  }
  if (url.includes("localhost") || url.includes("127.0.0.1")) {
    return "devnet";
  }
  return null;
}
