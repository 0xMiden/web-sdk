import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCreateNonFungibleFaucet } from "../../hooks/useCreateNonFungibleFaucet";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockAccount,
  createMockAccountHeader,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useCreateNonFungibleFaucet", () => {
  it("should return initial state", () => {
    mockUseMiden.mockReturnValue({ client: null, isReady: false });

    const { result } = renderHook(() => useCreateNonFungibleFaucet());

    expect(result.current.faucet).toBeNull();
    expect(result.current.isCreating).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("should throw error when client is not ready", async () => {
    mockUseMiden.mockReturnValue({ client: null, isReady: false });

    const { result } = renderHook(() => useCreateNonFungibleFaucet());

    await expect(
      result.current.createNonFungibleFaucet({ tokenSymbol: "ART" })
    ).rejects.toThrow("Miden client is not ready");
  });

  it("should create a non-fungible faucet with defaults (name defaults to symbol)", async () => {
    const mockFaucet = createMockAccount();
    const accounts = [createMockAccountHeader()];
    const mockClient = createMockWebClient({
      newNonFungibleFaucet: vi.fn().mockResolvedValue(mockFaucet),
      getAccounts: vi.fn().mockResolvedValue(accounts),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useCreateNonFungibleFaucet());

    let created;
    await act(async () => {
      created = await result.current.createNonFungibleFaucet({
        tokenSymbol: "ART",
      });
    });

    expect(created).toBe(mockFaucet);
    expect(result.current.faucet).toBe(mockFaucet);
    expect(mockClient.newNonFungibleFaucet).toHaveBeenCalledWith(
      expect.anything(), // storageMode.private() (default)
      "ART",
      "ART",
      2 // authScheme (default: AuthRpoFalcon512)
    );
    expect(mockClient.newFaucet).not.toHaveBeenCalled();
    expect(useMidenStore.getState().accounts).toEqual(accounts);
  });

  it("should create a network faucet when an owner is given", async () => {
    const mockFaucet = createMockAccount();
    const mockClient = createMockWebClient({
      newNetworkNonFungibleFaucet: vi.fn().mockResolvedValue(mockFaucet),
      getAccounts: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useCreateNonFungibleFaucet());

    let created;
    await act(async () => {
      created = await result.current.createNonFungibleFaucet({
        tokenSymbol: "NNFT",
        tokenName: "Network Collectible",
        owner: "0xowner",
      });
    });

    expect(created).toBe(mockFaucet);
    const [owner, name, symbol] =
      mockClient.newNetworkNonFungibleFaucet.mock.calls[0];
    expect((owner as { toString(): string }).toString()).toBe("0xowner");
    expect(name).toBe("Network Collectible");
    expect(symbol).toBe("NNFT");
    expect(mockClient.newNonFungibleFaucet).not.toHaveBeenCalled();
  });

  it("should accept storageMode 'public' with an owner", async () => {
    const mockClient = createMockWebClient({
      getAccounts: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useCreateNonFungibleFaucet());

    await act(async () => {
      await result.current.createNonFungibleFaucet({
        tokenSymbol: "NNFT",
        owner: "0xowner",
        storageMode: "public",
      });
    });

    expect(mockClient.newNetworkNonFungibleFaucet).toHaveBeenCalled();
  });

  it.each([
    [
      "a public faucet without an owner",
      { storageMode: "public" as const },
      "A public non-fungible faucet must be a network faucet: pass `owner`",
    ],
    [
      "an owner with an authScheme",
      { owner: "0xowner", authScheme: 1 as never },
      "A network non-fungible faucet (one with an owner) has no auth key, so it takes no authScheme",
    ],
    [
      "an owner with private storage",
      { owner: "0xowner", storageMode: "private" as const },
      "A network non-fungible faucet (one with an owner) is always public",
    ],
  ])("should reject %s", async (_label, extra, message) => {
    const mockClient = createMockWebClient();
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useCreateNonFungibleFaucet());

    await act(async () => {
      await expect(
        result.current.createNonFungibleFaucet({ tokenSymbol: "NFT", ...extra })
      ).rejects.toThrow(message);
    });
    expect(result.current.error?.message).toBe(message);
    expect(mockClient.newNonFungibleFaucet).not.toHaveBeenCalled();
    expect(mockClient.newNetworkNonFungibleFaucet).not.toHaveBeenCalled();
  });

  it("should expose errors, converting non-Error values", async () => {
    const mockClient = createMockWebClient({
      newNonFungibleFaucet: vi.fn().mockRejectedValue("String error"),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useCreateNonFungibleFaucet());

    await act(async () => {
      await expect(
        result.current.createNonFungibleFaucet({ tokenSymbol: "ART" })
      ).rejects.toThrow("String error");
    });

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });
    expect(result.current.isCreating).toBe(false);
  });

  it("should reset all state", async () => {
    const mockClient = createMockWebClient({
      newNonFungibleFaucet: vi.fn().mockResolvedValue(createMockAccount()),
      getAccounts: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useCreateNonFungibleFaucet());

    await act(async () => {
      await result.current.createNonFungibleFaucet({ tokenSymbol: "ART" });
    });
    expect(result.current.faucet).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.faucet).toBeNull();
    expect(result.current.isCreating).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
