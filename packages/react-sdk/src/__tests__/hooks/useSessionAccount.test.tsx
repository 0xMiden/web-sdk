import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useLayoutEffect } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessionAccount } from "../../hooks/useSessionAccount";
import { useMiden } from "../../context/MidenProvider";
import { useSigner } from "../../context/SignerContext";
import { createMockSignerContext } from "../mocks/signer-context";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockAccount,
  createMockAccountId,
  createMockAccountHeader,
  createMockConsumableNoteRecord,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

vi.mock("../../context/SignerContext", () => ({
  useSigner: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;
const mockUseSigner = vi.mocked(useSigner);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  mockUseSigner.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSessionAccount", () => {
  const defaultOptions = {
    fund: vi.fn().mockResolvedValue(undefined),
    assetId: "0xfaucet",
  };

  it("ignores a saved initialize after its client was replaced", async () => {
    const clientA = createMockWebClient({
      getConsumableNotes: vi
        .fn()
        .mockResolvedValue([createMockConsumableNoteRecord()]),
    });
    const fund = vi.fn().mockResolvedValue(undefined);
    mockUseMiden.mockReturnValue({
      client: clientA,
      isReady: true,
      sync: vi.fn(),
    });
    useMidenStore.getState().setClient(clientA as never);
    const { result } = renderHook(() => useSessionAccount({ fund }));
    const initializeA = result.current.initialize;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
      useMidenStore.getState().setClient(createMockWebClient() as never);
    });
    await act(async () => {
      await initializeA();
    });
    expect(clientA.newWallet).not.toHaveBeenCalled();
    expect(clientA.getAccounts).not.toHaveBeenCalled();
    expect(clientA.syncState).not.toHaveBeenCalled();
    expect(fund).not.toHaveBeenCalled();
    expect(result.current.sessionAccountId).toBeNull();
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(localStorageMock.length).toBe(0);
  });

  it("lets B initialize while A is pending and keeps B busy when A finishes", async () => {
    const pendingA = deferred<ReturnType<typeof createMockAccount>>();
    const pendingB = deferred<ReturnType<typeof createMockAccount>>();
    const clientA = createMockWebClient({
      newWallet: vi.fn().mockReturnValue(pendingA.promise),
    });
    const clientB = createMockWebClient({
      newWallet: vi.fn().mockReturnValue(pendingB.promise),
      getConsumableNotes: vi
        .fn()
        .mockResolvedValue([createMockConsumableNoteRecord()]),
    });
    const sync = vi.fn().mockResolvedValue(undefined);
    mockUseMiden.mockReturnValue({ client: clientA, isReady: true, sync });
    useMidenStore.getState().setClient(clientA as never);
    const { result, rerender } = renderHook(() =>
      useSessionAccount({ fund: vi.fn().mockResolvedValue(undefined) })
    );
    let initializingA!: Promise<void>;
    act(() => {
      initializingA = result.current.initialize();
    });
    act(() => {
      mockUseMiden.mockReturnValue({ client: clientB, isReady: true, sync });
      useMidenStore.getState().resetInMemoryState();
      useMidenStore.getState().setClient(clientB as never);
    });
    rerender();
    let initializingB!: Promise<void>;
    act(() => {
      initializingB = result.current.initialize();
      void initializingB.catch(() => {});
    });
    expect(clientB.newWallet).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingA.resolve(createMockAccount());
      await initializingA;
    });
    await expect(result.current.initialize()).rejects.toMatchObject({
      code: "OPERATION_BUSY",
    });
    await act(async () => {
      pendingB.resolve(createMockAccount());
      await initializingB;
    });
    expect(result.current.isReady).toBe(true);
  });

  it.each(["wallet", "accounts", "fund", "sync", "notes", "request", "submit"])(
    "stops initialization when the client is replaced during %s",
    async (stage) => {
      const pending = deferred<unknown>();
      const reached = deferred<void>();
      const hold = () => {
        reached.resolve();
        return pending.promise;
      };
      const wallet = createMockAccount();
      const notes = [createMockConsumableNoteRecord()];
      const clientA = createMockWebClient({
        newWallet:
          stage === "wallet" ? vi.fn(hold) : vi.fn().mockResolvedValue(wallet),
        getAccounts:
          stage === "accounts" ? vi.fn(hold) : vi.fn().mockResolvedValue([]),
        syncState:
          stage === "sync" ? vi.fn(hold) : vi.fn().mockResolvedValue({}),
        getConsumableNotes:
          stage === "notes" ? vi.fn(hold) : vi.fn().mockResolvedValue(notes),
        newConsumeTransactionRequest:
          stage === "request" ? vi.fn(hold) : vi.fn().mockResolvedValue({}),
        submitNewTransaction:
          stage === "submit" ? vi.fn(hold) : vi.fn().mockResolvedValue({}),
      });
      const fund =
        stage === "fund" ? vi.fn(hold) : vi.fn().mockResolvedValue(undefined);
      const sync = vi.fn().mockResolvedValue(undefined);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true, sync });
      useMidenStore.getState().setClient(clientA as never);
      const { result } = renderHook(() => useSessionAccount({ fund }));
      let initializing!: Promise<void>;
      await act(async () => {
        initializing = result.current.initialize();
        await reached.promise;
      });
      const previousStep = result.current.step;
      const previousId = result.current.sessionAccountId;
      const previousWrites = localStorageMock.setItem.mock.calls.length;
      act(() => {
        useMidenStore.getState().resetInMemoryState();
        useMidenStore.getState().setClient(createMockWebClient() as never);
      });
      const calls = [
        clientA.getAccounts,
        fund,
        clientA.syncState,
        clientA.getConsumableNotes,
        clientA.newConsumeTransactionRequest,
        clientA.submitNewTransaction,
        sync,
      ];
      const previousCalls = calls.map((method) => method.mock.calls.length);
      await act(async () => {
        pending.resolve(
          stage === "wallet"
            ? wallet
            : stage === "accounts"
              ? []
              : stage === "notes"
                ? notes
                : {}
        );
        await initializing;
      });
      expect(calls.map((method) => method.mock.calls.length)).toEqual(
        previousCalls
      );
      expect(result.current.sessionAccountId).toBe(previousId);
      expect(result.current.step).toBe(previousStep);
      expect(result.current.isReady).toBe(false);
      expect(result.current.error).toBeNull();
      expect(localStorageMock.setItem).toHaveBeenCalledTimes(previousWrites);
      expect(localStorageMock.getItem("miden-session:ready")).toBeNull();
      expect(useMidenStore.getState().accounts).toEqual([]);
      if (stage === "wallet") {
        expect(fund).not.toHaveBeenCalled();
        expect(localStorageMock.getItem("miden-session:accountId")).toBeNull();
      }
      if (stage !== "submit")
        expect(clientA.submitNewTransaction).not.toHaveBeenCalled();
    }
  );

  it("stops polling after a client replacement during the polling delay", async () => {
    vi.useFakeTimers();
    try {
      const clientA = createMockWebClient({
        getConsumableNotes: vi.fn().mockResolvedValue([]),
      });
      const sync = vi.fn().mockResolvedValue(undefined);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true, sync });
      useMidenStore.getState().setClient(clientA as never);
      const { result } = renderHook(() =>
        useSessionAccount({
          fund: vi.fn().mockResolvedValue(undefined),
          pollIntervalMs: 10,
          maxWaitMs: 100,
        })
      );
      let initializing!: Promise<void>;
      await act(async () => {
        initializing = result.current.initialize();
      });
      const settled = initializing.catch(() => {});
      expect(clientA.getConsumableNotes).toHaveBeenCalledTimes(1);
      act(() => {
        useMidenStore.getState().resetInMemoryState();
        useMidenStore.getState().setClient(createMockWebClient() as never);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
        await settled;
      });
      expect(clientA.syncState).toHaveBeenCalledTimes(1);
      expect(clientA.getConsumableNotes).toHaveBeenCalledTimes(1);
      expect(clientA.newConsumeTransactionRequest).not.toHaveBeenCalled();
      expect(clientA.submitNewTransaction).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(result.current.step).toBe("consuming");
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["wallet", "closing sync"])(
    "ignores a stale rejection during %s",
    async (stage) => {
      const pending = deferred<unknown>();
      const reached = deferred<void>();
      const hold = () => {
        reached.resolve();
        return pending.promise;
      };
      const clientA = createMockWebClient({
        newWallet:
          stage === "wallet"
            ? vi.fn(hold)
            : vi.fn().mockResolvedValue(createMockAccount()),
        getConsumableNotes: vi
          .fn()
          .mockResolvedValue([createMockConsumableNoteRecord()]),
      });
      const sync = stage === "closing sync" ? vi.fn(hold) : vi.fn();
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true, sync });
      useMidenStore.getState().setClient(clientA as never);
      const { result } = renderHook(() =>
        useSessionAccount({ fund: vi.fn().mockResolvedValue(undefined) })
      );
      let initializing!: Promise<void>;
      await act(async () => {
        initializing = result.current.initialize();
        await reached.promise;
      });
      const previousStep = result.current.step;
      act(() => {
        useMidenStore.getState().resetInMemoryState();
        useMidenStore.getState().setClient(createMockWebClient() as never);
      });
      await act(async () => {
        pending.reject(new Error("stale session operation"));
        await expect(initializing).resolves.toBeUndefined();
      });
      expect(result.current.error).toBeNull();
      expect(result.current.step).toBe(previousStep);
    }
  );

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

    it("forwards a numeric walletOptions.authScheme to newWallet", async () => {
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(createMockAccount()),
        getConsumableNotes: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });
      act(() => {
        useMidenStore.getState().setClient(mockClient as never);
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          fund: vi.fn().mockResolvedValue(undefined),
          walletOptions: { authScheme: 1 },
          pollIntervalMs: 1,
          maxWaitMs: 5,
        })
      );

      await act(async () => {
        await result.current.initialize().catch(() => {});
      });

      expect(mockClient.newWallet).toHaveBeenCalledWith(expect.anything(), 1);
    });

    it("does not consume a block-locked funding note", async () => {
      // A note that unlocks at a later block would fail the whole consume
      // transaction, so the poll must keep waiting rather than submit it.
      const mockWallet = createMockAccount({
        id: vi.fn(() => ({
          toString: vi.fn(() => "0xlocked_wallet"),
          toHex: vi.fn(() => "0xlocked_wallet"),
          isFaucet: vi.fn(() => false),
          isRegularAccount: vi.fn(() => true),
          free: vi.fn(),
        })),
      });
      const locked = createMockConsumableNoteRecord(
        "0xlocked",
        "0xlocked_wallet",
        false
      );
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi.fn().mockResolvedValue([locked]),
        newConsumeTransactionRequest: vi.fn().mockResolvedValue({}),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });
      act(() => {
        useMidenStore.getState().setClient(mockClient as never);
      });

      const { result } = renderHook(() =>
        useSessionAccount({
          fund: vi.fn().mockResolvedValue(undefined),
          assetId: "0xfaucet",
          pollIntervalMs: 1,
          maxWaitMs: 5,
        })
      );

      await act(async () => {
        await result.current.initialize().catch(() => {});
      });

      expect(mockClient.newConsumeTransactionRequest).not.toHaveBeenCalled();
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
      const mockConsumableNote = createMockConsumableNoteRecord(
        "0xnote1",
        "0xsession_wallet"
      );

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi
          .fn()
          .mockResolvedValueOnce([]) // First poll: no notes
          .mockResolvedValue([mockConsumableNote]), // Second poll: funding note arrives
        newConsumeTransactionRequest: vi.fn().mockResolvedValue({}),
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
      act(() => {
        useMidenStore.getState().setClient(mockClient as never);
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

      // `newConsumeTransactionRequest` is async, so submit must receive the
      // resolved request rather than the promise. Asserting on identity is what
      // catches a dropped `await` - a permissive submit mock takes a thenable
      // without complaint, which is how that bug shipped once already.
      const consumeRequest =
        await mockClient.newConsumeTransactionRequest.mock.results[0].value;
      expect(mockClient.submitNewTransaction).toHaveBeenCalledWith(
        expect.anything(),
        consumeRequest
      );

      // The consuming account is the second, required argument.
      expect(
        mockClient.newConsumeTransactionRequest.mock.calls[0][1]
      ).toBeDefined();
    });
  });

  it("does not cache session accounts after the cache generation changes", async () => {
    const staleAccounts = [createMockAccountHeader()];
    let finishAccounts!: (accounts: typeof staleAccounts) => void;
    const pendingAccounts = new Promise<typeof staleAccounts>((resolve) => {
      finishAccounts = resolve;
    });
    const mockClient = createMockWebClient({
      newWallet: vi.fn().mockResolvedValue(createMockAccount()),
      getAccounts: vi.fn().mockReturnValue(pendingAccounts),
      getConsumableNotes: vi
        .fn()
        .mockResolvedValue([createMockConsumableNoteRecord()]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });
    act(() => {
      useMidenStore.getState().setClient(mockClient as never);
    });
    const { result } = renderHook(() => useSessionAccount(defaultOptions));

    let initializing!: Promise<void>;
    act(() => {
      initializing = result.current.initialize();
    });
    await waitFor(() => {
      expect(mockClient.getAccounts).toHaveBeenCalledTimes(1);
    });
    expect(result.current.step).toBe("creating");

    const generation = useMidenStore.getState().cacheGeneration;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });
    expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

    await act(async () => {
      finishAccounts(staleAccounts);
      await initializing;
    });

    expect(result.current.step).toBe("creating");
    expect(result.current.isReady).toBe(false);
    expect(result.current.error).toBeNull();
    expect(useMidenStore.getState().accounts).toEqual([]);
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

      const mockConsumableNote = createMockConsumableNoteRecord(
        "0xnote1",
        "0xpersisted"
      );

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getConsumableNotes: vi.fn().mockResolvedValue([mockConsumableNote]),
        newConsumeTransactionRequest: vi.fn().mockResolvedValue({}),
        submitNewTransaction: vi.fn().mockResolvedValue({
          toString: vi.fn(() => "0xtx"),
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });
      act(() => {
        useMidenStore.getState().setClient(mockClient as never);
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
      act(() => {
        useMidenStore.getState().setClient(mockClient as never);
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
});

describe("session identity and flow ownership", () => {
  function sessionClient(id = "0xsession") {
    return createMockWebClient({
      newWallet: vi
        .fn()
        .mockResolvedValue(
          createMockAccount({ id: vi.fn(() => createMockAccountId(id)) })
        ),
      getConsumableNotes: vi
        .fn()
        .mockResolvedValue([createMockConsumableNoteRecord("0xfunding", id)]),
    });
  }

  it.each([null, true])(
    "does not restore a local session before a signer client commits (signerConnected=%s)",
    async (signerConnected) => {
      localStorageMock.setItem("miden-session:accountId", "0xlocal");
      localStorageMock.setItem("miden-session:ready", "true");
      localStorageMock.setItem("miden-session:a:accountId", "0xsessionA");
      localStorageMock.setItem("miden-session:a:ready", "true");
      localStorageMock.getItem.mockClear();
      localStorageMock.removeItem.mockClear();
      mockUseSigner.mockReturnValue(createMockSignerContext());
      const context = {
        client: null,
        isReady: false,
        sync: vi.fn(),
        clientStoreName: null,
        signerConnected,
      };
      mockUseMiden.mockReturnValue(context);
      const { result, rerender } = renderHook(() =>
        useSessionAccount({ fund: vi.fn() })
      );

      expect(result.current.sessionAccountId).toBeNull();
      expect(result.current.step).toBe("idle");
      await expect(result.current.initialize()).rejects.toThrow(
        "Miden client is not ready"
      );
      act(() => result.current.reset());
      expect(localStorageMock.getItem).not.toHaveBeenCalled();
      expect(localStorageMock.removeItem).not.toHaveBeenCalled();

      const client = sessionClient();
      act(() => {
        useMidenStore.getState().setClient(client as never);
        mockUseMiden.mockReturnValue({
          ...context,
          client,
          isReady: true,
          clientStoreName: "a",
          signerConnected: true,
        });
      });
      rerender();
      expect(result.current.sessionAccountId).toBe("0xsessionA");
      expect(result.current.step).toBe("ready");
    }
  );

  it("restores a local session without a signer provider before a client commits", () => {
    localStorageMock.setItem("miden-session:accountId", "0xlocal");
    localStorageMock.setItem("miden-session:ready", "true");
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
      sync: vi.fn(),
      clientStoreName: null,
      signerConnected: null,
    });
    const { result, rerender } = renderHook(() =>
      useSessionAccount({ fund: vi.fn() })
    );
    expect(result.current.sessionAccountId).toBe("0xlocal");
    expect(result.current.step).toBe("ready");

    mockUseSigner.mockReturnValue(createMockSignerContext());
    rerender();
    expect(result.current.sessionAccountId).toBeNull();
    expect(result.current.step).toBe("idle");
  });

  it("restores only the committed signer's session across selection and client commits", async () => {
    const clientA = sessionClient("0xsessionA");
    const clientB = sessionClient("0xsessionB");
    const fund = vi.fn().mockResolvedValue(undefined);
    const sync = vi.fn().mockResolvedValue(undefined);
    mockUseMiden.mockReturnValue({
      client: clientA,
      isReady: true,
      sync,
      clientStoreName: "a",
      signerConnected: true,
    });
    useMidenStore.getState().setClient(clientA as never);
    const { result, rerender } = renderHook(() =>
      useSessionAccount({ fund, pollIntervalMs: 1, maxWaitMs: 20 })
    );
    expect(result.current.sessionAccountId).toBeNull();
    await act(async () => {
      await result.current.initialize();
    });
    expect(result.current.sessionAccountId).toBe("0xsessionA");
    expect(result.current.step).toBe("ready");

    mockUseMiden.mockReturnValue({
      client: clientA,
      isReady: true,
      sync,
      clientStoreName: "a",
      signerConnected: false,
    });
    rerender();
    expect(result.current.sessionAccountId).toBe("0xsessionA");
    clientA.newWallet.mockClear();
    fund.mockClear();
    await expect(result.current.initialize()).rejects.toThrow(
      "Signer is disconnected"
    );
    expect(clientA.newWallet).not.toHaveBeenCalled();
    expect(fund).not.toHaveBeenCalled();

    act(() => {
      mockUseMiden.mockReturnValue({
        client: clientB,
        isReady: true,
        sync,
        clientStoreName: "b",
        signerConnected: true,
      });
      useMidenStore.getState().setClient(clientB as never);
    });
    rerender();
    expect(result.current.sessionAccountId).toBeNull();
    expect(result.current.step).toBe("idle");
    await act(async () => {
      await result.current.initialize();
    });
    expect(clientB.newWallet).toHaveBeenCalledTimes(1);
    expect(fund).toHaveBeenCalledExactlyOnceWith("0xsessionB");
    expect(localStorageMock.getItem("miden-session:b:ready")).toBe("true");

    act(() => {
      mockUseMiden.mockReturnValue({
        client: clientA,
        isReady: true,
        sync,
        clientStoreName: "a",
        signerConnected: true,
      });
      useMidenStore.getState().setClient(clientA as never);
    });
    rerender();
    expect(result.current.sessionAccountId).toBe("0xsessionA");
    expect(result.current.step).toBe("ready");
    expect(
      localStorageMock.getItem.mock.calls.some(
        ([key]) =>
          key === "miden-session:accountId" || key === "miden-session:ready"
      )
    ).toBe(false);
    expect(
      localStorageMock.setItem.mock.calls.some(
        ([key]) =>
          key === "miden-session:accountId" || key === "miden-session:ready"
      )
    ).toBe(false);
  });

  it("replaces the ready session when client B commits and restores A on return", async () => {
    const clientA = sessionClient("0xsessionA");
    const clientB = sessionClient("0xsessionB");
    const fund = vi.fn().mockResolvedValue(undefined);
    const context = {
      client: clientA,
      isReady: true,
      sync: vi.fn(),
      clientStoreName: "a",
      signerConnected: true,
    };
    mockUseMiden.mockReturnValue(context);
    useMidenStore.getState().setClient(clientA as never);
    const { result, rerender } = renderHook(() => useSessionAccount({ fund }));
    await act(async () => {
      await result.current.initialize();
    });
    act(() => {
      mockUseMiden.mockReturnValue({
        ...context,
        client: clientB,
        clientStoreName: "b",
      });
      useMidenStore.getState().setClient(clientB as never);
    });
    rerender();
    expect(result.current.sessionAccountId).toBeNull();
    expect(result.current.step).toBe("idle");
    await act(async () => {
      await result.current.initialize();
    });
    expect(fund).toHaveBeenNthCalledWith(2, "0xsessionB");
    act(() => {
      mockUseMiden.mockReturnValue(context);
      useMidenStore.getState().setClient(clientA as never);
    });
    rerender();
    expect(result.current.sessionAccountId).toBe("0xsessionA");
    expect(result.current.step).toBe("ready");
  });

  it("never reads or writes plain keys for a signer session", async () => {
    localStorageMock.setItem("miden-session:accountId", "0xplain");
    localStorageMock.setItem("miden-session:ready", "true");
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    const client = sessionClient();
    mockUseMiden.mockReturnValue({
      client,
      isReady: true,
      sync: vi.fn(),
      clientStoreName: "a",
      signerConnected: true,
    });
    useMidenStore.getState().setClient(client as never);
    const { result } = renderHook(() => useSessionAccount({ fund: vi.fn() }));
    expect(result.current.sessionAccountId).toBeNull();
    await act(async () => {
      await result.current.initialize();
    });
    expect(localStorageMock.getItem("miden-session:a:accountId")).toBe(
      "0xsession"
    );
    expect(localStorageMock.getItem("miden-session:a:ready")).toBe("true");
    expect(
      localStorageMock.getItem.mock.calls.some(
        ([key]) =>
          key === "miden-session:accountId" || key === "miden-session:ready"
      )
    ).toBe(false);
    expect(
      localStorageMock.setItem.mock.calls.some(
        ([key]) =>
          key === "miden-session:accountId" || key === "miden-session:ready"
      )
    ).toBe(false);
    act(() => {
      result.current.reset();
    });
    expect(localStorageMock.removeItem.mock.calls.map(([key]) => key)).toEqual([
      "miden-session:a:accountId",
      "miden-session:a:ready",
    ]);
  });

  it("creates and funds once after StrictMode's effect replay", async () => {
    const client = sessionClient();
    const fund = vi.fn().mockResolvedValue(undefined);
    mockUseMiden.mockReturnValue({
      client,
      isReady: true,
      sync: vi.fn(),
      clientStoreName: null,
      signerConnected: null,
    });
    useMidenStore.getState().setClient(client as never);
    const { result } = renderHook(
      () => useSessionAccount({ fund, pollIntervalMs: 1, maxWaitMs: 20 }),
      {
        wrapper: ({ children }) => (
          <React.StrictMode>{children}</React.StrictMode>
        ),
      }
    );
    await act(async () => {
      await result.current.initialize();
    });
    expect(client.newWallet).toHaveBeenCalledTimes(1);
    expect(fund).toHaveBeenCalledExactlyOnceWith("0xsession");
    expect(result.current.step).toBe("ready");
    expect(localStorageMock.getItem("miden-session:accountId")).toBe(
      "0xsession"
    );
    expect(localStorageMock.getItem("miden-session:ready")).toBe("true");
  });

  it.each(["disconnect", "prefix", "store", "reset", "unmount"])(
    "ends a pending wallet flow on %s",
    async (change) => {
      const pending = deferred<ReturnType<typeof createMockAccount>>();
      const client = sessionClient();
      client.newWallet.mockReturnValueOnce(pending.promise);
      const fund = vi.fn().mockResolvedValue(undefined);
      const context = {
        client,
        isReady: true,
        sync: vi.fn(),
        clientStoreName: "a",
        signerConnected: true,
      };
      mockUseMiden.mockReturnValue(context);
      useMidenStore.getState().setClient(client as never);
      const { result, rerender, unmount } = renderHook(
        ({ prefix }) =>
          useSessionAccount({
            fund,
            storagePrefix: prefix,
            pollIntervalMs: 1,
            maxWaitMs: 20,
          }),
        { initialProps: { prefix: "old" } }
      );
      let initializing!: Promise<void>;
      act(() => {
        initializing = result.current.initialize();
      });
      if (change === "disconnect") {
        mockUseMiden.mockReturnValue({ ...context, signerConnected: false });
        rerender({ prefix: "old" });
      } else if (change === "prefix") rerender({ prefix: "new" });
      else if (change === "store") {
        mockUseMiden.mockReturnValue({ ...context, clientStoreName: "b" });
        rerender({ prefix: "old" });
      } else if (change === "reset")
        act(() => {
          result.current.reset();
        });
      else unmount();
      const before = {
        id: result.current.sessionAccountId,
        step: result.current.step,
      };
      localStorageMock.setItem.mockClear();
      await act(async () => {
        pending.resolve(
          createMockAccount({
            id: vi.fn(() => createMockAccountId("0xsession")),
          })
        );
        await initializing.catch(() => {});
      });
      expect(fund).not.toHaveBeenCalled();
      expect(client.getAccounts).not.toHaveBeenCalled();
      expect(localStorageMock.setItem).not.toHaveBeenCalled();
      expect(result.current.sessionAccountId).toBe(before.id);
      expect(result.current.step).toBe(before.step);
      expect(result.current.error).toBeNull();
    }
  );

  it.each(["disconnect", "prefix", "store", "reset", "unmount"])(
    "refuses an initialize callback saved before %s",
    async (change) => {
      const client = sessionClient();
      const fund = vi.fn().mockResolvedValue(undefined);
      const context = {
        client,
        isReady: true,
        sync: vi.fn(),
        clientStoreName: "a",
        signerConnected: true,
      };
      mockUseMiden.mockReturnValue(context);
      useMidenStore.getState().setClient(client as never);
      const { result, rerender, unmount } = renderHook(
        ({ prefix }) =>
          useSessionAccount({
            fund,
            storagePrefix: prefix,
            pollIntervalMs: 1,
            maxWaitMs: 20,
          }),
        { initialProps: { prefix: "old" } }
      );
      const initialize = result.current.initialize;
      if (change === "disconnect") {
        mockUseMiden.mockReturnValue({ ...context, signerConnected: false });
        rerender({ prefix: "old" });
      } else if (change === "prefix") rerender({ prefix: "new" });
      else if (change === "store") {
        mockUseMiden.mockReturnValue({ ...context, clientStoreName: "b" });
        rerender({ prefix: "old" });
      } else if (change === "reset")
        act(() => {
          result.current.reset();
        });
      else unmount();
      await act(async () => {
        await initialize();
      });
      expect(client.newWallet).not.toHaveBeenCalled();
      expect(fund).not.toHaveBeenCalled();
      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    }
  );

  it("keeps the post-reset flow busy when the pre-reset wallet resolves", async () => {
    const pendingA = deferred<ReturnType<typeof createMockAccount>>();
    const pendingB = deferred<ReturnType<typeof createMockAccount>>();
    const client = sessionClient();
    client.newWallet
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const fund = vi.fn().mockResolvedValue(undefined);
    mockUseMiden.mockReturnValue({
      client,
      isReady: true,
      sync: vi.fn(),
      clientStoreName: "a",
      signerConnected: true,
    });
    useMidenStore.getState().setClient(client as never);
    const { result } = renderHook(() =>
      useSessionAccount({ fund, pollIntervalMs: 1, maxWaitMs: 20 })
    );
    let initializingA!: Promise<void>;
    let initializingB!: Promise<void>;
    act(() => {
      initializingA = result.current.initialize();
    });
    act(() => {
      result.current.reset();
    });
    act(() => {
      initializingB = result.current.initialize();
    });
    await act(async () => {
      pendingA.resolve(
        createMockAccount({ id: vi.fn(() => createMockAccountId("0xsession")) })
      );
      await initializingA;
    });
    expect(fund).not.toHaveBeenCalled();
    await expect(result.current.initialize()).rejects.toMatchObject({
      code: "OPERATION_BUSY",
    });
    await act(async () => {
      pendingB.resolve(
        createMockAccount({ id: vi.fn(() => createMockAccountId("0xsession")) })
      );
      await initializingB;
    });
    expect(fund).toHaveBeenCalledExactlyOnceWith("0xsession");
    expect(result.current.step).toBe("ready");
  });

  it.each(["prefix", "store"])(
    "reads the new %s's stored session before the restore effect",
    async (change) => {
      const client = sessionClient("0xnew");
      const fund = vi.fn().mockResolvedValue(undefined);
      const context = {
        client,
        isReady: true,
        sync: vi.fn(),
        clientStoreName: "a",
        signerConnected: true,
      };
      mockUseMiden.mockReturnValue(context);
      useMidenStore.getState().setClient(client as never);
      localStorageMock.setItem("old:accountId", "0xold");
      localStorageMock.setItem("old:ready", "true");
      localStorageMock.setItem("old:a:accountId", "0xold");
      localStorageMock.setItem("old:a:ready", "true");
      localStorageMock.setItem(
        change === "prefix" ? "new:a:accountId" : "old:b:accountId",
        "0xnew"
      );
      let initializing!: Promise<void>;
      const { result, rerender } = renderHook(
        ({ prefix, start }) => {
          const session = useSessionAccount({
            fund,
            storagePrefix: prefix,
            pollIntervalMs: 1,
            maxWaitMs: 20,
          });
          useLayoutEffect(() => {
            if (start) initializing = session.initialize();
          }, [start]);
          return session;
        },
        { initialProps: { prefix: "old", start: false } }
      );
      expect(result.current.sessionAccountId).toBe("0xold");
      if (change === "store")
        mockUseMiden.mockReturnValue({ ...context, clientStoreName: "b" });
      rerender({ prefix: change === "prefix" ? "new" : "old", start: true });
      await act(async () => {
        await initializing.catch(() => {});
      });
      expect(fund).toHaveBeenCalledExactlyOnceWith("0xnew");
      expect(client.newWallet).not.toHaveBeenCalled();
      expect(result.current.sessionAccountId).toBe("0xnew");
      expect(result.current.step).toBe("ready");
    }
  );

  it("captures the fund callback when its flow starts", async () => {
    const pending = deferred<ReturnType<typeof createMockAccount>>();
    const client = sessionClient();
    client.newWallet.mockReturnValueOnce(pending.promise);
    const fundA = vi.fn().mockResolvedValue(undefined);
    const fundB = vi.fn().mockResolvedValue(undefined);
    mockUseMiden.mockReturnValue({ client, isReady: true, sync: vi.fn() });
    useMidenStore.getState().setClient(client as never);
    const { result, rerender } = renderHook(
      ({ fund }) =>
        useSessionAccount({ fund, pollIntervalMs: 1, maxWaitMs: 20 }),
      { initialProps: { fund: fundA } }
    );
    let initializing!: Promise<void>;
    act(() => {
      initializing = result.current.initialize();
    });
    rerender({ fund: fundB });
    await act(async () => {
      pending.resolve(
        createMockAccount({ id: vi.fn(() => createMockAccountId("0xsession")) })
      );
      await initializing.catch(() => {});
    });
    expect(fundA).toHaveBeenCalledExactlyOnceWith("0xsession");
    expect(fundB).not.toHaveBeenCalled();
  });

  it.each([
    "accounts",
    "fund",
    "sync",
    "notes",
    "request",
    "submit",
    "closing sync",
  ])("stops at the %s await after a same-client disconnect", async (stage) => {
    const pending = deferred<unknown>();
    const reached = deferred<void>();
    const hold = () => {
      reached.resolve();
      return pending.promise;
    };
    const client = sessionClient();
    const fund =
      stage === "fund" ? vi.fn(hold) : vi.fn().mockResolvedValue(undefined);
    const sync = stage === "closing sync" ? vi.fn(hold) : vi.fn();
    const method = {
      accounts: "getAccounts",
      sync: "syncState",
      notes: "getConsumableNotes",
      request: "newConsumeTransactionRequest",
      submit: "submitNewTransaction",
    } as const;
    if (stage in method)
      client[method[stage as keyof typeof method]].mockImplementationOnce(hold);
    const context = {
      client,
      isReady: true,
      sync,
      clientStoreName: "a",
      signerConnected: true,
    };
    mockUseMiden.mockReturnValue(context);
    useMidenStore.getState().setClient(client as never);
    const { result, rerender } = renderHook(() =>
      useSessionAccount({ fund, pollIntervalMs: 1, maxWaitMs: 20 })
    );
    let initializing!: Promise<void>;
    await act(async () => {
      initializing = result.current.initialize();
      await reached.promise;
    });
    mockUseMiden.mockReturnValue({ ...context, signerConnected: false });
    rerender();
    const before = {
      id: result.current.sessionAccountId,
      step: result.current.step,
    };
    const methods = [
      fund,
      client.syncState,
      client.getConsumableNotes,
      client.newConsumeTransactionRequest,
      client.submitNewTransaction,
      sync,
    ];
    const counts = methods.map((fn) => fn.mock.calls.length);
    const writes = localStorageMock.setItem.mock.calls.length;
    await act(async () => {
      pending.resolve(
        stage === "notes"
          ? [createMockConsumableNoteRecord("0xfunding", "0xsession")]
          : stage === "accounts"
            ? []
            : {}
      );
      await initializing.catch(() => {});
    });
    expect(methods.map((fn) => fn.mock.calls.length)).toEqual(counts);
    expect(localStorageMock.setItem).toHaveBeenCalledTimes(writes);
    expect(result.current.sessionAccountId).toBe(before.id);
    expect(result.current.step).toBe(before.step);
    expect(result.current.error).toBeNull();
  });
});
