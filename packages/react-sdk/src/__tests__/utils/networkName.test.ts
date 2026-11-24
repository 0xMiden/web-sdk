import { describe, it, expect } from "vitest";
import { resolveNetworkName } from "../../utils/network";

describe("resolveNetworkName", () => {
  it("returns null without an endpoint", () => {
    expect(resolveNetworkName(undefined)).toBeNull();
    expect(resolveNetworkName(undefined, "mainnet")).toBeNull();
  });

  it("keeps the substring inference for known networks", () => {
    expect(resolveNetworkName("https://rpc.testnet.miden.io")).toBe("testnet");
    expect(resolveNetworkName("https://rpc.mtst.example")).toBe("testnet");
    expect(resolveNetworkName("https://rpc.devnet.miden.io")).toBe("devnet");
    expect(resolveNetworkName("https://rpc.mdev.example")).toBe("devnet");
    expect(resolveNetworkName("https://rpc.mainnet.miden.io")).toBe("mainnet");
    expect(resolveNetworkName("http://localhost:57291")).toBe("devnet");
    expect(resolveNetworkName("http://127.0.0.1:57291")).toBe("devnet");
  });

  it("prefers devnet, then mainnet, then testnet when the endpoint names more than one", () => {
    expect(resolveNetworkName("https://rpc.mainnet.miden.io/testnet")).toBe(
      "mainnet"
    );
    expect(resolveNetworkName("https://rpc.devnet.mainnet.example")).toBe(
      "devnet"
    );
    expect(resolveNetworkName("http://localhost/rpc.mainnet.miden.io")).toBe(
      "mainnet"
    );
  });

  it("defaults an endpoint naming no network to mainnet", () => {
    expect(resolveNetworkName("https://rpc.cedar.miden.io")).toBe("mainnet");
  });

  it("lets an explicit network win over the endpoint", () => {
    expect(resolveNetworkName("https://rpc.testnet.miden.io", "mainnet")).toBe(
      "mainnet"
    );
    expect(resolveNetworkName("https://rpc.cedar.miden.io", "testnet")).toBe(
      "testnet"
    );
    expect(resolveNetworkName("http://localhost:57291", "devnet")).toBe(
      "devnet"
    );
  });
});
