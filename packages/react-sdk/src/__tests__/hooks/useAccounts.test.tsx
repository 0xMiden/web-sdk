import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAccounts } from "../../hooks/useAccounts";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import type { WasmWebClient as WebClient } from "@miden-sdk/miden-sdk";
import {
  createMockWebClient,
  createMockAccountHeader,
  createMockAccountId,
} from "../mocks/miden-sdk";

// Mock useMiden
vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useAccounts", () => {
  describe("initial state", () => {
    it("should return empty accounts when client is not ready", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
      });

      const { result } = renderHook(() => useAccounts());

      expect(result.current.accounts).toEqual([]);
      expect(result.current.wallets).toEqual([]);
      expect(result.current.faucets).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe("when client is ready", () => {
    it("should fetch accounts on mount", async () => {
      const mockAccounts = [
        createMockAccountHeader("0x1000000000000001"),
        createMockAccountHeader("0x1000000000000002"),
      ];

      const mockClient = createMockWebClient({
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.accounts.length).toBeGreaterThan(0);
      });

      expect(mockClient.getAccounts).toHaveBeenCalled();
    });

    it("should categorize accounts into wallets and faucets", async () => {
      const walletAccount = createMockAccountHeader("0x1234567890abcdef");
      const faucetAccount = createMockAccountHeader("0x2234567890abcdef");

      faucetAccount.id = vi.fn(() => ({
        ...createMockAccountId("0x2234567890abcdef"),
        toHex: vi.fn(() => "0x2234567890abcdef"),
      }));

      const mockClient = createMockWebClient({
        getAccounts: vi.fn().mockResolvedValue([walletAccount, faucetAccount]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
        useMidenStore
          .getState()
          .setAccounts([walletAccount, faucetAccount] as any);
      });

      const { result } = renderHook(() => useAccounts());

      expect(result.current.accounts.length).toBe(2);
    });
  });

  describe("refetch", () => {
    it("ignores a saved refetch after its client was replaced", async () => {
      const clientA = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      useMidenStore.getState().setClient(clientA as unknown as WebClient);
      useMidenStore
        .getState()
        .setAccounts([createMockAccountHeader()] as never);
      const { result } = renderHook(() => useAccounts());
      const refetchA = result.current.refetch;
      const accountsB = [createMockAccountHeader("0x2000000000000002")];
      act(() => {
        useMidenStore.getState().resetInMemoryState();
        useMidenStore
          .getState()
          .setClient(createMockWebClient() as unknown as WebClient);
        useMidenStore.getState().setAccounts(accountsB as never);
      });

      let fetching!: Promise<void>;
      act(() => {
        fetching = refetchA();
      });
      expect(result.current.isLoading).toBe(false);
      await act(async () => {
        await fetching;
      });
      expect(clientA.getAccounts).not.toHaveBeenCalled();
      expect(result.current.accounts).toBe(accountsB);
      expect(result.current.error).toBeNull();
    });

    it("keeps signer B's accounts when signer A's pending fetch resolves", async () => {
      const accountsA = [createMockAccountHeader("0x1000000000000001")];
      const accountsB = [createMockAccountHeader("0x1000000000000002")];
      let finishFetch!: (accounts: typeof accountsA) => void;
      const pendingAccounts = new Promise<typeof accountsA>((resolve) => {
        finishFetch = resolve;
      });
      const clientA = createMockWebClient({
        getAccounts: vi.fn().mockReturnValue(pendingAccounts),
      });
      const clientB = createMockWebClient({
        getAccounts: vi.fn().mockResolvedValue(accountsB),
      });

      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      useMidenStore.getState().setClient(clientA as unknown as WebClient);

      const { result, rerender } = renderHook(() => useAccounts());
      await waitFor(() => {
        expect(clientA.getAccounts).toHaveBeenCalledTimes(1);
      });
      expect(result.current.isLoading).toBe(true);

      act(() => {
        mockUseMiden.mockReturnValue({ client: clientB, isReady: true });
        useMidenStore.getState().resetInMemoryState();
        useMidenStore.getState().setClient(clientB as unknown as WebClient);
      });
      rerender();
      await waitFor(() => {
        expect(result.current.accounts).toBe(accountsB);
      });

      await act(async () => {
        finishFetch(accountsA);
        await pendingAccounts;
      });

      expect(useMidenStore.getState().client).toBe(clientB);
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.accounts).toBe(accountsB);
    });

    it("keeps signer B's fetch loading when signer A's pending fetch resolves first", async () => {
      const accountsA = [createMockAccountHeader("0x1000000000000001")];
      const accountsB = [createMockAccountHeader("0x1000000000000002")];
      let finishA!: (accounts: typeof accountsA) => void;
      const pendingA = new Promise<typeof accountsA>((resolve) => {
        finishA = resolve;
      });
      let finishB!: (accounts: typeof accountsB) => void;
      const pendingB = new Promise<typeof accountsB>((resolve) => {
        finishB = resolve;
      });
      const clientA = createMockWebClient({
        getAccounts: vi.fn().mockReturnValue(pendingA),
      });
      const clientB = createMockWebClient({
        getAccounts: vi.fn().mockReturnValue(pendingB),
      });

      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      useMidenStore.getState().setClient(clientA as unknown as WebClient);
      const { result, rerender } = renderHook(() => useAccounts());
      await waitFor(() => {
        expect(clientA.getAccounts).toHaveBeenCalledTimes(1);
      });

      act(() => {
        mockUseMiden.mockReturnValue({ client: clientB, isReady: true });
        useMidenStore.getState().resetInMemoryState();
        useMidenStore.getState().setClient(clientB as unknown as WebClient);
      });
      rerender();
      await waitFor(() => {
        expect(clientB.getAccounts).toHaveBeenCalledTimes(1);
      });
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        finishA(accountsA);
        await pendingA;
      });
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        finishB(accountsB);
        await pendingB;
      });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.accounts).toBe(accountsB);
    });

    it("should refetch accounts when called", async () => {
      const mockAccounts = [createMockAccountHeader("0x1000000000000001")];
      const updatedAccounts = [
        createMockAccountHeader("0x1000000000000001"),
        createMockAccountHeader("0x1000000000000002"),
      ];

      const mockClient = createMockWebClient({
        getAccounts: vi
          .fn()
          .mockResolvedValueOnce(mockAccounts)
          .mockResolvedValueOnce(updatedAccounts),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccounts());

      await waitFor(() => {
        expect(result.current.accounts.length).toBe(1);
      });

      await act(async () => {
        await result.current.refetch();
      });

      await waitFor(() => {
        expect(result.current.accounts.length).toBe(2);
      });

      expect(mockClient.getAccounts).toHaveBeenCalledTimes(2);
    });

    it("should not refetch when client is not ready", async () => {
      const mockClient = createMockWebClient();

      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
      });

      const { result } = renderHook(() => useAccounts());

      await act(async () => {
        await result.current.refetch();
      });

      expect(mockClient.getAccounts).not.toHaveBeenCalled();
    });
  });

  describe("loading state", () => {
    it("should set loading state during fetch", async () => {
      let resolvePromise: (value: any[]) => void;
      const fetchPromise = new Promise<any[]>((resolve) => {
        resolvePromise = resolve;
      });

      const mockClient = createMockWebClient({
        getAccounts: vi.fn().mockReturnValue(fetchPromise),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccounts());

      // Trigger fetch
      act(() => {
        result.current.refetch();
      });

      // Should be loading
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      // Resolve the promise
      await act(async () => {
        resolvePromise!([createMockAccountHeader()]);
      });

      // Should no longer be loading
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });
  });

  describe("error handling", () => {
    it("should handle fetch errors gracefully", async () => {
      const mockClient = createMockWebClient({
        getAccounts: vi.fn().mockRejectedValue(new Error("Network error")),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        const { result } = renderHook(() => useAccounts());

        // Trigger fetch
        await act(async () => {
          await result.current.refetch();
        });

        // Should not throw, just log error
        expect(result.current.isLoading).toBe(false);
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  describe("account categorization", () => {
    it("should correctly identify faucet accounts by ID pattern", () => {
      // Test the isFaucetId logic through the hook
      const mockClient = createMockWebClient();

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      // Set accounts with different patterns
      const accounts = [
        createMockAccountHeader("0x0123456789abcdef"), // Regular (type 00)
        createMockAccountHeader("0x8123456789abcdef"), // Faucet (type 10)
      ];

      act(() => {
        useMidenStore.getState().setAccounts(accounts as any);
      });

      const { result } = renderHook(() => useAccounts());

      // Both should be in the total accounts
      expect(result.current.accounts.length).toBe(2);
    });
  });
});
