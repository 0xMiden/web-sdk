import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMidenStore } from "../../store/MidenStore";
import type { MidenConfig } from "../../types";

// Shared mocks hoisted above vi.mock so the factory can reference them
const { mockGetAccountDetails, mockFromAccount, mockTestnet } = vi.hoisted(
  () => ({
    mockGetAccountDetails: vi.fn(),
    mockFromAccount: vi.fn(),
    mockTestnet: vi.fn(),
  })
);

// Override the SDK mock for this file so we can control RpcClient behavior
vi.mock("@miden-sdk/miden-sdk", () => {
  const createMockAccountId = (id: string) => ({
    toString: vi.fn(() => id),
    toHex: vi.fn(() => id),
  });

  return {
    AccountId: {
      fromHex: vi.fn((hex: string) => createMockAccountId(hex)),
      fromBech32: vi.fn((bech32: string) => createMockAccountId(bech32)),
    },
    Endpoint: class Endpoint {
      constructor(_url?: string) {}
      // Surfaced as a spy so a re-introduced hardcoded fallback is caught.
      static testnet = mockTestnet;
    },
    RpcClient: class RpcClient {
      constructor(_endpoint: unknown) {}
      getAccountDetails = mockGetAccountDetails;
    },
    BasicFungibleFaucetComponent: {
      fromAccount: mockFromAccount,
    },
  };
});

// Import after mocks are set up
import { useAssetMetadata } from "../../hooks/useAssetMetadata";

// A configured RPC endpoint. Asset metadata only fetches once the app has
// selected an endpoint — the hook must never invent one.
const RPC_URL = "https://rpc.devnet.miden.io";

beforeEach(() => {
  useMidenStore.getState().reset();
  useMidenStore.getState().setConfig({ rpcUrl: RPC_URL } as MidenConfig);
  // A non-null client flips isReady=true (MidenStore.setClient), mirroring a
  // fully-initialized provider. The hook gates RPC construction on this.
  useMidenStore.getState().setClient({} as never);
  mockGetAccountDetails.mockReset();
  mockFromAccount.mockReset();
  mockTestnet.mockReset();
});

describe("useAssetMetadata", () => {
  it("should return empty metadata when no assetIds provided", () => {
    const { result } = renderHook(() => useAssetMetadata());
    expect(result.current.assetMetadata.size).toBe(0);
  });

  it("should return empty metadata for empty array", () => {
    const { result } = renderHook(() => useAssetMetadata([]));
    expect(result.current.assetMetadata.size).toBe(0);
  });

  it("defers until the client is ready, firing no RPC during init", async () => {
    // The reported leak: before MidenProvider finishes initializing, isReady is
    // false and the resolved rpcUrl isn't in the store yet. A devnet-configured
    // app must not build a page-side client (and hit the testnet fallback) in
    // this window.
    useMidenStore.getState().setClient(null); // isReady = false
    mockGetAccountDetails.mockResolvedValue({ account: () => ({ id: "x" }) });

    const { result } = renderHook(() => useAssetMetadata(["0xfaucetInit"]));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTestnet).not.toHaveBeenCalled();
    expect(mockGetAccountDetails).not.toHaveBeenCalled();
    expect(result.current.assetMetadata.has("0xfaucetInit")).toBe(false);
  });

  it("uses the configured endpoint and never the testnet fallback once ready", async () => {
    // rpcUrl is devnet (beforeEach) and the client is ready: metadata resolves
    // against the configured endpoint, never Endpoint.testnet().
    mockGetAccountDetails.mockResolvedValue({ account: () => ({ id: "x" }) });
    mockFromAccount.mockReturnValue({
      symbol: () => ({ toString: () => "DEV" }),
      decimals: () => 6,
    });

    const { result } = renderHook(() => useAssetMetadata(["0xfaucetDevnet"]));
    await waitFor(() => {
      expect(result.current.assetMetadata.get("0xfaucetDevnet")?.symbol).toBe(
        "DEV"
      );
    });

    expect(mockGetAccountDetails).toHaveBeenCalled();
    expect(mockTestnet).not.toHaveBeenCalled();
  });

  it("still uses the testnet default when no endpoint is configured", async () => {
    // The accepted default: with no rpcUrl configured at all, the page-side
    // client matches the WebClient/MidenProvider testnet default rather than
    // deferring forever.
    useMidenStore.getState().setConfig({} as MidenConfig); // no rpcUrl
    mockGetAccountDetails.mockResolvedValue({ account: () => null });

    const { result } = renderHook(() => useAssetMetadata(["0xfaucetDefault"]));
    await waitFor(() => {
      expect(result.current.assetMetadata.has("0xfaucetDefault")).toBe(true);
    });

    expect(mockTestnet).toHaveBeenCalled();
    expect(mockGetAccountDetails).toHaveBeenCalled();
  });

  it("should fetch metadata via RPC and store symbol and decimals", async () => {
    const mockAccount = { id: "mock-account" };
    mockGetAccountDetails.mockResolvedValue({
      account: () => mockAccount,
    });
    mockFromAccount.mockReturnValue({
      symbol: () => ({ toString: () => "ETH" }),
      decimals: () => 8,
    });

    const { result } = renderHook(() => useAssetMetadata(["0xfaucet1"]));

    await waitFor(() => {
      expect(result.current.assetMetadata.get("0xfaucet1")?.symbol).toBe("ETH");
    });

    const meta = result.current.assetMetadata.get("0xfaucet1");
    expect(meta).toEqual({
      assetId: "0xfaucet1",
      symbol: "ETH",
      decimals: 8,
    });
    expect(mockGetAccountDetails).toHaveBeenCalled();
    expect(mockFromAccount).toHaveBeenCalledWith(mockAccount);
  });

  it("should store fallback metadata when account is not found", async () => {
    mockGetAccountDetails.mockResolvedValue({
      account: () => null,
    });

    const { result } = renderHook(() => useAssetMetadata(["0xfaucet2"]));

    await waitFor(() => {
      expect(result.current.assetMetadata.has("0xfaucet2")).toBe(true);
    });

    const meta = result.current.assetMetadata.get("0xfaucet2");
    expect(meta).toEqual({ assetId: "0xfaucet2" });
    expect(meta?.symbol).toBeUndefined();
    expect(meta?.decimals).toBeUndefined();
  });

  it("should handle RPC errors gracefully", async () => {
    mockGetAccountDetails.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useAssetMetadata(["0xfaucet3"]));

    await waitFor(() => {
      expect(result.current.assetMetadata.has("0xfaucet3")).toBe(true);
    });

    const meta = result.current.assetMetadata.get("0xfaucet3");
    expect(meta).toEqual({ assetId: "0xfaucet3" });
  });

  it("should deduplicate asset IDs", async () => {
    mockGetAccountDetails.mockResolvedValue({
      account: () => ({ id: "mock" }),
    });
    mockFromAccount.mockReturnValue({
      symbol: () => ({ toString: () => "TKN" }),
      decimals: () => 6,
    });

    const { result } = renderHook(() =>
      useAssetMetadata(["0xfaucet4", "0xfaucet4", "0xfaucet4"])
    );

    await waitFor(() => {
      expect(result.current.assetMetadata.has("0xfaucet4")).toBe(true);
    });

    expect(mockGetAccountDetails).toHaveBeenCalledTimes(1);
  });

  it("should skip fetch when metadata is already cached", async () => {
    useMidenStore.getState().setAssetMetadata("0xfaucet5", {
      assetId: "0xfaucet5",
      symbol: "CACHED",
      decimals: 2,
    });

    const { result } = renderHook(() => useAssetMetadata(["0xfaucet5"]));

    // Wait a tick to ensure the effect had a chance to run
    await new Promise((r) => setTimeout(r, 50));

    expect(mockGetAccountDetails).not.toHaveBeenCalled();

    const meta = result.current.assetMetadata.get("0xfaucet5");
    expect(meta?.symbol).toBe("CACHED");
    expect(meta?.decimals).toBe(2);
  });

  it("should filter out falsy asset IDs", () => {
    const { result } = renderHook(() =>
      useAssetMetadata(["", undefined as unknown as string, ""])
    );

    expect(result.current.assetMetadata.size).toBe(0);
    expect(mockGetAccountDetails).not.toHaveBeenCalled();
  });

  it("should fetch metadata for multiple different asset IDs", async () => {
    mockGetAccountDetails.mockResolvedValue({
      account: () => ({ id: "mock" }),
    });
    mockFromAccount.mockReturnValue({
      symbol: () => ({ toString: () => "MULTI" }),
      decimals: () => 4,
    });

    const { result } = renderHook(() =>
      useAssetMetadata(["0xfaucetA", "0xfaucetB"])
    );

    await waitFor(() => {
      expect(result.current.assetMetadata.has("0xfaucetA")).toBe(true);
      expect(result.current.assetMetadata.has("0xfaucetB")).toBe(true);
    });

    expect(mockGetAccountDetails).toHaveBeenCalledTimes(2);
    expect(result.current.assetMetadata.get("0xfaucetA")?.symbol).toBe("MULTI");
    expect(result.current.assetMetadata.get("0xfaucetB")?.symbol).toBe("MULTI");
  });

  it("should store fallback when BasicFungibleFaucetComponent throws", async () => {
    mockGetAccountDetails.mockResolvedValue({
      account: () => ({ id: "bad-faucet" }),
    });
    mockFromAccount.mockImplementation(() => {
      throw new Error("Not a fungible faucet");
    });

    const { result } = renderHook(() => useAssetMetadata(["0xfaucet6"]));

    await waitFor(() => {
      expect(result.current.assetMetadata.has("0xfaucet6")).toBe(true);
    });

    const meta = result.current.assetMetadata.get("0xfaucet6");
    expect(meta).toEqual({ assetId: "0xfaucet6" });
  });
});
