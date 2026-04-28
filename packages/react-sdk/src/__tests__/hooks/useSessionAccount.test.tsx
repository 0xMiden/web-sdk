import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionAccount } from "../../hooks/useSessionAccount";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { createMockWebClient, createMockAccount } from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    get length() {
      return Object.keys(store).length;
    },
    clear: vi.fn(() => {
      store = {};
    }),
    _reset: () => {
      store = {};
    },
  };
})();

beforeEach(() => {
  useMidenStore.getState().reset();
  localStorageMock._reset();
  vi.stubGlobal("localStorage", localStorageMock);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSessionAccount", () => {
  const defaultOptions = {
    fund: vi.fn().mockResolvedValue(undefined),
    assetId: "0xfaucet",
  };

  describe("initial state", () => {
    it("should return idle state when not initialized", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSessionAccount(defaultOptions));

      expect(result.current.sessionAccountId).toBeNull();
      expect(result.current.isReady).toBe(false);
      expect(result.current.step).toBe("idle");
      expect(result.current.error).toBeNull();
      expect(typeof result.current.initialize).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("initialize", () => {
    it("should throw when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSessionAccount(defaultOptions));

      await expect(result.current.initialize()).rejects.toThrow(
        "Miden client is not ready"
      );
    });

    it("should create wallet and call fund callback", async () => {
      const mockWallet = createMockAccount({
        id: vi.fn(() => ({
          toString: vi.fn(() => "0xsession_wallet"),
          toHex: vi.fn(() => "0xsession_wallet"),
          isFaucet: vi.fn(() => false),
          isRegularAccount: vi.fn(() => true),
          free: vi.fn(),
        })),
      });

      const fundFn = vi.fn().mockResolvedValue(undefined);

      // Mock consumable notes to simulate funding arriving
      const mockConsumableNote = {
        inputNoteRecord: vi.fn(() => ({
          toNote: vi.fn(() => ({})),
        })),
      };

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi
          .fn()
          .mockResolvedValueOnce([]) // First poll: no notes
          .mockResolvedValue([mockConsumableNote]), // Second poll: funding note arrives
        newConsumeTransactionRequest: vi.fn().mockReturnValue({}),
        submitNewTransaction: vi.fn().mockResolvedValue({
          toString: vi.fn(() => "0xtx"),
        }),
      });

      const mockSync = vi.fn().mockResolvedValue(undefined);

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          fund: fundFn,
          assetId: "0xfaucet",
          pollIntervalMs: 10, // Fast polling for test
        })
      );

      await act(async () => {
        await result.current.initialize();
      });

      expect(fundFn).toHaveBeenCalledWith("0xsession_wallet");
      expect(result.current.step).toBe("ready");
      expect(result.current.isReady).toBe(true);
      expect(result.current.sessionAccountId).toBe("0xsession_wallet");
    });
  });

  describe("persistence", () => {
    it("should persist session account ID to localStorage", async () => {
      const mockWallet = createMockAccount({
        id: vi.fn(() => ({
          toString: vi.fn(() => "0xpersisted"),
          toHex: vi.fn(() => "0xpersisted"),
          isFaucet: vi.fn(() => false),
          isRegularAccount: vi.fn(() => true),
          free: vi.fn(),
        })),
      });

      const mockConsumableNote = {
        inputNoteRecord: vi.fn(() => ({
          toNote: vi.fn(() => ({})),
        })),
      };

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi.fn().mockResolvedValue([mockConsumableNote]),
        newConsumeTransactionRequest: vi.fn().mockReturnValue({}),
        submitNewTransaction: vi.fn().mockResolvedValue({
          toString: vi.fn(() => "0xtx"),
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          ...defaultOptions,
          pollIntervalMs: 10,
        })
      );

      await act(async () => {
        await result.current.initialize();
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "miden-session:accountId",
        "0xpersisted"
      );
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "miden-session:ready",
        "true"
      );
    });

    it("should restore session from localStorage on mount", () => {
      localStorageMock.setItem("miden-session:accountId", "0xrestored");
      localStorageMock.setItem("miden-session:ready", "true");

      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSessionAccount(defaultOptions));

      expect(result.current.sessionAccountId).toBe("0xrestored");
      expect(result.current.step).toBe("ready");
      expect(result.current.isReady).toBe(true);
    });

    it("should use custom storage prefix", () => {
      localStorageMock.setItem("custom-prefix:accountId", "0xcustom");
      localStorageMock.setItem("custom-prefix:ready", "true");

      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          ...defaultOptions,
          storagePrefix: "custom-prefix",
        })
      );

      expect(result.current.sessionAccountId).toBe("0xcustom");
      expect(result.current.isReady).toBe(true);
    });
  });

  describe("reset", () => {
    it("should clear all state and localStorage", () => {
      localStorageMock.setItem("miden-session:accountId", "0xwallet");
      localStorageMock.setItem("miden-session:ready", "true");

      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSessionAccount(defaultOptions));

      // Verify restored state
      expect(result.current.sessionAccountId).toBe("0xwallet");

      act(() => {
        result.current.reset();
      });

      expect(result.current.sessionAccountId).toBeNull();
      expect(result.current.step).toBe("idle");
      expect(result.current.isReady).toBe(false);
      expect(result.current.error).toBeNull();
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        "miden-session:accountId"
      );
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        "miden-session:ready"
      );
    });
  });

  describe("error handling", () => {
    it("should set error when wallet creation fails", async () => {
      const mockClient = createMockWebClient({
        newWallet: vi
          .fn()
          .mockRejectedValue(new Error("Wallet creation failed")),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSessionAccount(defaultOptions));

      await act(async () => {
        try {
          await result.current.initialize();
        } catch {
          // Expected
        }
      });

      expect(result.current.error?.message).toBe("Wallet creation failed");
      expect(result.current.step).toBe("idle");
    });
  });

  describe("branch coverage gaps", () => {
    it("should use private storage mode when walletOptions.storageMode is private (line 209)", async () => {
      const { AccountStorageMode } = await import("@miden-sdk/miden-sdk/lazy");

      const mockWallet = createMockAccount({
        id: vi.fn(() => ({
          toString: vi.fn(() => "0xprivatewallet"),
          toHex: vi.fn(() => "0xprivatewallet"),
          isFaucet: vi.fn(() => false),
          isRegularAccount: vi.fn(() => true),
          free: vi.fn(),
        })),
      });

      const mockConsumableNote = {
        inputNoteRecord: vi.fn(() => ({
          toNote: vi.fn(() => ({})),
        })),
      };

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi.fn().mockResolvedValue([mockConsumableNote]),
        newConsumeTransactionRequest: vi.fn().mockReturnValue({}),
        submitNewTransaction: vi.fn().mockResolvedValue({
          toString: vi.fn(() => "0xtx"),
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          ...defaultOptions,
          walletOptions: { storageMode: "private" },
          pollIntervalMs: 10,
        })
      );

      await act(async () => {
        await result.current.initialize();
      });

      expect(vi.mocked(AccountStorageMode.private)).toHaveBeenCalled();
    });

    it("should timeout in waitAndConsume when funding note never arrives (lines 258-259)", async () => {
      const mockWallet = createMockAccount({
        id: vi.fn(() => ({
          toString: vi.fn(() => "0xtimeoutwallet"),
          toHex: vi.fn(() => "0xtimeoutwallet"),
          isFaucet: vi.fn(() => false),
          isRegularAccount: vi.fn(() => true),
          free: vi.fn(),
        })),
      });

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        // Never returns consumable notes — forces timeout
        getConsumableNotes: vi.fn().mockResolvedValue([]),
        newConsumeTransactionRequest: vi.fn().mockReturnValue({}),
        submitNewTransaction: vi.fn().mockResolvedValue({}),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          ...defaultOptions,
          pollIntervalMs: 1,
          maxWaitMs: 10, // very short timeout
        })
      );

      await act(async () => {
        try {
          await result.current.initialize();
        } catch {
          // Expected: timeout
        }
      });

      expect(result.current.error?.message).toMatch(/Timeout/);
      expect(result.current.step).toBe("idle");
    });

    it("should not throw error when cancelled during execution (line 161-165)", async () => {
      const mockWallet = createMockAccount({
        id: vi.fn(() => ({
          toString: vi.fn(() => "0xcancelwallet"),
          toHex: vi.fn(() => "0xcancelwallet"),
          isFaucet: vi.fn(() => false),
          isRegularAccount: vi.fn(() => true),
          free: vi.fn(),
        })),
      });

      // Fund callback triggers reset() mid-flight
      let capturedResult: typeof result;
      const fundFn = vi.fn().mockImplementation(async () => {
        // Reset cancels the operation
        act(() => {
          capturedResult.current.reset();
        });
      });

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          fund: fundFn,
          assetId: "0xfaucet",
          pollIntervalMs: 1,
          maxWaitMs: 10,
        })
      );

      capturedResult = result;

      // Should not throw when cancelled
      await act(async () => {
        await result.current.initialize();
      });

      expect(result.current.error).toBeNull();
    });

    it("should restore session with stored accountId but ready=false (line 85-87 partial)", () => {
      // Only accountId stored, not ready flag
      localStorageMock.setItem("miden-session:accountId", "0xstored");
      // No "miden-session:ready" stored — step stays idle

      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSessionAccount(defaultOptions));

      expect(result.current.sessionAccountId).toBe("0xstored");
      expect(result.current.step).toBe("idle"); // not "ready" since stored ready flag absent
    });

    it("should clear invalid stored session data (lines 91-93)", async () => {
      // Store a value that will trigger parseAccountId to throw.
      // We use a spy on AccountId.fromHex to simulate the throw, because
      // the mock normally accepts any string.
      const { AccountId } = await import("@miden-sdk/miden-sdk/lazy");
      const fromHexSpy = vi
        .spyOn(
          AccountId as unknown as { fromHex: (...args: unknown[]) => unknown },
          "fromHex"
        )
        .mockImplementationOnce(() => {
          throw new Error("Invalid account ID format");
        });

      localStorageMock.setItem("miden-session:accountId", "invalid-!!!");

      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSessionAccount(defaultOptions));

      // On mount, parseAccountId throws, catch block removes both keys
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        "miden-session:accountId"
      );
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        "miden-session:ready"
      );
      expect(result.current.sessionAccountId).toBeNull();

      fromHexSpy.mockRestore();
    });

    it("should throw OPERATION_BUSY when initialize is called twice concurrently (lines 102-106)", async () => {
      const mockWallet = createMockAccount({
        id: vi.fn(() => ({
          toString: vi.fn(() => "0xbusy"),
          toHex: vi.fn(() => "0xbusy"),
          isFaucet: vi.fn(() => false),
          isRegularAccount: vi.fn(() => true),
          free: vi.fn(),
        })),
      });

      let resolveFund: () => void;
      const fundPromise = new Promise<void>((resolve) => {
        resolveFund = resolve;
      });

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          fund: vi.fn().mockReturnValue(fundPromise),
          assetId: "0xfaucet",
          pollIntervalMs: 1,
          maxWaitMs: 100,
        })
      );

      // Start first initialize (it will be stuck waiting for fund)
      let firstInit: Promise<any>;
      act(() => {
        firstInit = result.current.initialize().catch(() => {});
      });

      // Wait a tick so isBusyRef.current = true
      await new Promise((r) => setTimeout(r, 10));

      // Second call should throw OPERATION_BUSY
      await expect(result.current.initialize()).rejects.toThrow(
        "Session account initialization is already in progress"
      );

      // Resolve first
      act(() => {
        resolveFund!();
      });
    });
  });

  describe("storage mode default branch", () => {
    it("should fall back to public when an unknown storageMode is passed (line 213)", async () => {
      const mockWallet = createMockAccount();
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi.fn().mockResolvedValue([]),
        syncState: vi.fn().mockResolvedValue({}),
      });

      const resolvedNote = {
        inputNoteRecord: vi.fn(() => ({
          toNote: vi.fn(() => ({})),
        })),
      };

      // Make getConsumableNotes return a note on first call
      mockClient.getConsumableNotes = vi.fn().mockResolvedValue([resolvedNote]);
      mockClient.newConsumeTransactionRequest = vi.fn().mockReturnValue({});
      mockClient.submitNewTransaction = vi
        .fn()
        .mockResolvedValue({ toString: () => "0xtx" });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          fund: vi.fn().mockResolvedValue(undefined),
          assetId: "0xfaucet",
          walletOptions: {
            storageMode: "unknown" as any,
          },
          pollIntervalMs: 1,
          maxWaitMs: 100,
        })
      );

      // getStorageMode default branch is exercised during wallet creation
      await act(async () => {
        await result.current.initialize().catch(() => {});
      });

      // The newWallet call receives a storageMode from the default branch
      expect(mockClient.newWallet).toHaveBeenCalledWith(
        { type: "public" },
        expect.anything(),
        expect.anything()
      );
    });
  });
});
