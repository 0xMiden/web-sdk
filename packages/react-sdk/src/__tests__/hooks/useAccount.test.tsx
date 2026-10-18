import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAccount } from "../../hooks/useAccount";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockAccount,
  createMockAccountId,
  createMockVault,
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

describe("useAccount", () => {
  describe.each(["reset", "replace", "reset and replace"] as const)(
    "%s during a read",
    (change) => {
      it("discards stale account details and still publishes a current read", async () => {
        const accountId = "0x1234567890abcdef";
        const staleAccount = createMockAccount();
        const currentAccount = createMockAccount();
        let resolvePrevious!: (account: typeof staleAccount) => void;
        let resolveCurrent!: (account: typeof currentAccount) => void;
        const previousRead = new Promise<typeof staleAccount>((resolve) => {
          resolvePrevious = resolve;
        });
        const currentRead = new Promise<typeof currentAccount>((resolve) => {
          resolveCurrent = resolve;
        });
        const previousClient = createMockWebClient({
          getAccount: vi
            .fn()
            .mockReturnValueOnce(previousRead)
            .mockReturnValue(currentRead),
        });
        const currentClient =
          change === "reset"
            ? previousClient
            : createMockWebClient({
                getAccount: vi.fn().mockReturnValue(currentRead),
              });
        useMidenStore.getState().setClient(previousClient as any);
        mockUseMiden.mockReturnValue({ client: previousClient, isReady: true });
        const { result, rerender } = renderHook(() => useAccount(accountId));
        expect(previousClient.getAccount).toHaveBeenCalledTimes(1);

        act(() => {
          if (change !== "replace") {
            useMidenStore.getState().resetInMemoryState();
          }
          useMidenStore.getState().setClient(currentClient as any);
          if (change === "reset") {
            useMidenStore.getState().setSyncState({ lastSyncTime: 1 });
          }
          mockUseMiden.mockReturnValue({
            client: currentClient,
            isReady: true,
          });
          rerender();
        });
        expect(currentClient.getAccount).toHaveBeenCalledTimes(
          change === "reset" ? 2 : 1
        );
        expect(result.current.isLoading).toBe(true);
        const retainedState = useMidenStore.getState();

        await act(async () => {
          resolvePrevious(staleAccount);
          await previousRead;
        });

        expect(useMidenStore.getState().accountDetails.has(accountId)).toBe(
          false
        );
        expect(useMidenStore.getState()).toBe(retainedState);
        expect(result.current.account).toBeNull();
        expect(result.current.assets).toEqual([]);
        expect(result.current.error).toBeNull();
        expect(result.current.isLoading).toBe(true);

        await act(async () => {
          resolveCurrent(currentAccount);
          await currentRead;
        });

        expect(useMidenStore.getState().accountDetails.get(accountId)).toBe(
          currentAccount
        );
        expect(result.current.account).toBe(currentAccount);
        expect(result.current.error).toBeNull();
        expect(result.current.isLoading).toBe(false);
      });

      it("discards a stale error while retaining current errors and account details", async () => {
        const accountId = "0x1234567890abcdef";
        const currentAccount = createMockAccount();
        let rejectPrevious!: (error: Error) => void;
        let rejectCurrent!: (error: string) => void;
        const previousRead = new Promise<typeof currentAccount>((_, reject) => {
          rejectPrevious = reject;
        });
        const currentRead = new Promise<typeof currentAccount>((_, reject) => {
          rejectCurrent = reject;
        });
        const previousClient = createMockWebClient({
          getAccount: vi
            .fn()
            .mockReturnValueOnce(previousRead)
            .mockReturnValueOnce(currentRead)
            .mockResolvedValue(currentAccount),
        });
        const currentClient =
          change === "reset"
            ? previousClient
            : createMockWebClient({
                getAccount: vi
                  .fn()
                  .mockReturnValueOnce(currentRead)
                  .mockResolvedValue(currentAccount),
              });
        useMidenStore.getState().setClient(previousClient as any);
        mockUseMiden.mockReturnValue({ client: previousClient, isReady: true });
        const { result, rerender } = renderHook(() => useAccount(accountId));
        expect(previousClient.getAccount).toHaveBeenCalledTimes(1);

        act(() => {
          if (change !== "replace") {
            useMidenStore.getState().resetInMemoryState();
          }
          useMidenStore.getState().setClient(currentClient as any);
          if (change === "reset") {
            useMidenStore.getState().setSyncState({ lastSyncTime: 1 });
          }
          mockUseMiden.mockReturnValue({
            client: currentClient,
            isReady: true,
          });
          rerender();
        });
        expect(currentClient.getAccount).toHaveBeenCalledTimes(
          change === "reset" ? 2 : 1
        );
        expect(result.current.isLoading).toBe(true);
        const retainedState = useMidenStore.getState();

        await act(async () => {
          rejectPrevious(new Error("Stale account read failed"));
          await previousRead.catch(() => {});
        });

        expect(result.current.error).toBeNull();
        expect(useMidenStore.getState()).toBe(retainedState);
        expect(result.current.account).toBeNull();
        expect(result.current.assets).toEqual([]);
        expect(result.current.isLoading).toBe(true);

        await act(async () => {
          rejectCurrent("Current account read failed");
          await currentRead.catch(() => {});
        });
        expect(result.current.error?.message).toBe(
          "Current account read failed"
        );
        expect(result.current.isLoading).toBe(false);

        await act(async () => {
          await result.current.refetch();
        });

        expect(useMidenStore.getState().accountDetails.get(accountId)).toBe(
          currentAccount
        );
        expect(result.current.account).toBe(currentAccount);
        expect(result.current.error).toBeNull();
        expect(result.current.isLoading).toBe(false);
      });
    }
  );

  describe("initial state", () => {
    it("should return null account when no id provided", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
      });

      const { result } = renderHook(() => useAccount(undefined));

      expect(result.current.account).toBeNull();
      expect(result.current.assets).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should return null account when client is not ready", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
      });

      const { result } = renderHook(() => useAccount("0x1234"));

      expect(result.current.account).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("fetching account", () => {
    it("should fetch account by string ID", async () => {
      const accountId = "0x1234567890abcdef";
      const mockAccount = createMockAccount();
      mockAccount.id = vi.fn(() => createMockAccountId(accountId));

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      await waitFor(() => {
        expect(result.current.account).not.toBeNull();
      });

      expect(mockClient.getAccount).toHaveBeenCalled();
    });

    it("should fetch account by AccountId object", async () => {
      const accountIdObj = createMockAccountId("0xabcdef1234567890");
      const mockAccount = createMockAccount();

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccount(accountIdObj as any));

      await waitFor(() => {
        expect(result.current.account).not.toBeNull();
      });
    });

    it("should cache fetched accounts", async () => {
      const accountId = "0x1234567890abcdef";
      const mockAccount = createMockAccount();

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      // First render
      const { result, rerender } = renderHook(() => useAccount(accountId));

      await waitFor(() => {
        expect(result.current.account).not.toBeNull();
      });

      // Should have called once
      expect(mockClient.getAccount).toHaveBeenCalledTimes(1);

      // Rerender - should use cached value
      rerender();

      // Should still be only one call
      expect(mockClient.getAccount).toHaveBeenCalledTimes(1);
    });

    it("should handle account not found", async () => {
      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(null),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccount("0xnonexistent"));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.account).toBeNull();
    });
  });

  describe("assets extraction", () => {
    it("should extract assets from account vault", async () => {
      const accountId = "0x1234567890abcdef";
      const mockAssets = [
        { faucetId: "0xfaucet1", amount: 1000n },
        { faucetId: "0xfaucet2", amount: 500n },
      ];

      const mockAccount = createMockAccount();
      mockAccount.vault = vi.fn(() => createMockVault(mockAssets));

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
        useMidenStore
          .getState()
          .setAccountDetails(accountId, mockAccount as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      expect(result.current.assets.length).toBe(2);
      expect(result.current.assets[0].assetId).toBeDefined();
      expect(result.current.assets[0].amount).toBeDefined();
    });

    it("should return empty assets when vault throws", async () => {
      const accountId = "0x1234567890abcdef";
      const mockAccount = createMockAccount();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockAccount as any).vault = vi.fn(() => {
        throw new Error("Vault error");
      });

      const mockClient = createMockWebClient();

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
        useMidenStore
          .getState()
          .setAccountDetails(accountId, mockAccount as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      expect(result.current.assets).toEqual([]);
    });
  });

  describe("getBalance helper", () => {
    it("should return balance for specific faucet", async () => {
      const accountId = "0x1234567890abcdef";
      const assetId = "0xfaucet1";
      const mockAssets = [{ faucetId: assetId, amount: 1000n }];

      const mockAccount = createMockAccount();
      mockAccount.vault = vi.fn(() => createMockVault(mockAssets));

      const mockClient = createMockWebClient();

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
        useMidenStore
          .getState()
          .setAccountDetails(accountId, mockAccount as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      const balance = result.current.getBalance(assetId);
      expect(balance).toBe(1000n);
    });

    it("should return 0n for unknown faucet", async () => {
      const accountId = "0x1234567890abcdef";

      const mockClient = createMockWebClient();

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
        useMidenStore
          .getState()
          .setAccountDetails(accountId, createMockAccount() as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      const balance = result.current.getBalance("0xunknown");
      expect(balance).toBe(0n);
    });
  });

  describe("refetch", () => {
    it("should refetch account data", async () => {
      const accountId = "0x1234567890abcdef";
      const mockAccount1 = createMockAccount();
      const mockAccount2 = createMockAccount();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockAccount2 as any).nonce = vi.fn(() => ({ toString: () => "2" }));

      const mockClient = createMockWebClient({
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(mockAccount1)
          .mockResolvedValueOnce(mockAccount2),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      // Wait for initial fetch
      await waitFor(() => {
        expect(result.current.account).not.toBeNull();
      });

      // Refetch
      await act(async () => {
        await result.current.refetch();
      });

      expect(mockClient.getAccount).toHaveBeenCalledTimes(2);
    });

    it("should refetch after sync updates", async () => {
      const accountId = "0x1234567890abcdef";
      const mockAccount = createMockAccount();

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      await waitFor(() => {
        expect(result.current.account).not.toBeNull();
      });

      expect(mockClient.getAccount).toHaveBeenCalledTimes(1);

      act(() => {
        useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
      });

      await waitFor(() => {
        expect(mockClient.getAccount).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("error handling", () => {
    it("should capture fetch errors", async () => {
      const accountId = "0x1234567890abcdef";
      const fetchError = new Error("Network error");

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockRejectedValue(fetchError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });

      expect(result.current.error?.message).toBe("Network error");
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("loading state", () => {
    it("should track loading state during fetch", async () => {
      const accountId = "0x1234567890abcdef";
      let resolvePromise: (value: any) => void;
      const fetchPromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockReturnValue(fetchPromise),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      act(() => {
        useMidenStore.getState().setClient(mockClient as any);
      });

      const { result } = renderHook(() => useAccount(accountId));

      // Trigger fetch
      act(() => {
        result.current.refetch();
      });

      // Should be loading
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      // Resolve
      await act(async () => {
        resolvePromise!(createMockAccount());
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it("ignores a stale non-Error rejection while wrapping the current rejection", async () => {
      let rejectPrevious!: (error: string) => void;
      const previousRead = new Promise<null>((_, reject) => {
        rejectPrevious = reject;
      });
      const previousClient = createMockWebClient({
        getAccount: vi.fn().mockReturnValue(previousRead),
      });
      const currentClient = createMockWebClient({
        getAccount: vi.fn().mockRejectedValue("account-string-fail"),
      });
      useMidenStore.getState().setClient(previousClient as any);
      mockUseMiden.mockReturnValue({
        client: previousClient,
        isReady: true,
      });

      const { result, rerender } = renderHook(() => useAccount("0xacc"));
      expect(previousClient.getAccount).toHaveBeenCalledTimes(1);
      expect(result.current.isLoading).toBe(true);

      act(() => {
        useMidenStore.getState().resetInMemoryState();
        useMidenStore.getState().setClient(currentClient as any);
        mockUseMiden.mockReturnValue({ client: currentClient, isReady: true });
        rerender();
      });
      await waitFor(() => {
        expect(result.current.error).toBeInstanceOf(Error);
        expect(result.current.error?.message).toBe("account-string-fail");
        expect(result.current.isLoading).toBe(false);
      });
      const currentError = result.current.error;
      const retainedState = useMidenStore.getState();

      await act(async () => {
        rejectPrevious("stale-account-string-fail");
        await previousRead.catch(() => {});
      });

      expect(result.current.error).toBe(currentError);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.account).toBeNull();
      expect(useMidenStore.getState()).toBe(retainedState);
    });
  });
});
