import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCreateFaucet } from "../../hooks/useCreateFaucet";
import { AsyncLock } from "../../utils/asyncLock";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockAccount,
  createMockAccountHeader,
} from "../mocks/miden-sdk";

// Mock useMiden
vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useCreateFaucet", () => {
  it.each(["resolve", "reject"])(
    "keeps the latest call busy when the replaced client's call settles (%s)",
    async (outcome) => {
      const pendingA = deferred<ReturnType<typeof createMockAccount>>();
      const pendingB = deferred<ReturnType<typeof createMockAccount>>();
      const clientA = createMockWebClient({
        newFaucet: vi.fn().mockReturnValue(pendingA.promise),
      });
      const clientB = createMockWebClient({
        newFaucet: vi.fn().mockReturnValue(pendingB.promise),
      });
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      useMidenStore.getState().setClient(clientA as never);
      const { result, rerender } = renderHook(() => useCreateFaucet());
      let callA!: Promise<unknown>;
      act(() => {
        callA = result.current
          .createFaucet({ tokenSymbol: "TEST", maxSupply: 1000000n })
          .catch((error: Error) => error);
      });
      expect(clientA.newFaucet).toHaveBeenCalledTimes(1);
      expect(result.current.isCreating).toBe(true);

      act(() => {
        useMidenStore.getState().setClient(clientB as never);
        mockUseMiden.mockReturnValue({ client: clientB, isReady: true });
      });
      rerender();
      let callB!: Promise<unknown>;
      act(() => {
        callB = result.current.createFaucet({
          tokenSymbol: "TEST",
          maxSupply: 1000000n,
        });
      });
      expect(clientB.newFaucet).toHaveBeenCalledTimes(1);
      expect(result.current.isCreating).toBe(true);

      await act(async () => {
        if (outcome === "resolve") pendingA.resolve(createMockAccount());
        else pendingA.reject(new Error("replaced call failed"));
        await callA;
      });
      expect(result.current.isCreating).toBe(true);
      expect(result.current.error).toBeNull();
      expect(clientA.getAccounts).not.toHaveBeenCalled();

      await act(async () => {
        pendingB.resolve(createMockAccount());
        await callB;
      });
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();
    }
  );

  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
      });

      const { result } = renderHook(() => useCreateFaucet());

      expect(result.current.faucet).toBeNull();
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();
      expect(typeof result.current.createFaucet).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("createFaucet", () => {
    it("should throw error when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
      });

      const { result } = renderHook(() => useCreateFaucet());

      await expect(
        result.current.createFaucet({
          tokenSymbol: "TEST",
          maxSupply: 1000000n,
        })
      ).rejects.toThrow("Miden client is not ready");
    });

    it("should create faucet with required options (name defaults to symbol)", async () => {
      const mockFaucet = createMockAccount({ isFaucet: vi.fn(() => true) });
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockResolvedValue(mockFaucet),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      let createdFaucet;
      await act(async () => {
        createdFaucet = await result.current.createFaucet({
          tokenSymbol: "TEST",
          maxSupply: 1000000n,
        });
      });

      expect(createdFaucet).toBe(mockFaucet);
      expect(result.current.faucet).toBe(mockFaucet);
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();

      // Verify default options were used; token name falls back to symbol.
      expect(mockClient.newFaucet).toHaveBeenCalledWith(
        expect.anything(), // storageMode.private() (default)
        false, // nonFungible (always false for now)
        "TEST", // tokenName falls back to tokenSymbol
        "TEST",
        8, // decimals (default)
        1000000n,
        "falcon" // authScheme (default: AuthScheme.Falcon)
      );
    });

    it("should create faucet with custom options including an explicit token name", async () => {
      const mockFaucet = createMockAccount({ isFaucet: vi.fn(() => true) });
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockResolvedValue(mockFaucet),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      await act(async () => {
        await result.current.createFaucet({
          tokenSymbol: "USDC",
          tokenName: "USD Coin",
          maxSupply: 10000000000n,
          decimals: 6,
          storageMode: "public",
          authScheme: 1,
        });
      });

      expect(mockClient.newFaucet).toHaveBeenCalledWith(
        expect.anything(), // storageMode.public()
        false,
        "USD Coin",
        "USDC",
        6,
        10000000000n,
        1
      );
    });

    it("should create faucet with different storage modes", async () => {
      const mockFaucet = createMockAccount();
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockResolvedValue(mockFaucet),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      // Test private
      await act(async () => {
        await result.current.createFaucet({
          tokenSymbol: "A",
          maxSupply: 100n,
          storageMode: "private",
        });
      });

      // Test public
      await act(async () => {
        await result.current.createFaucet({
          tokenSymbol: "B",
          maxSupply: 100n,
          storageMode: "public",
        });
      });

      expect(mockClient.newFaucet).toHaveBeenCalledTimes(2);
    });

    it("should refresh accounts list after creation", async () => {
      const mockFaucet = createMockAccount();
      const mockAccounts = [createMockAccountHeader()];
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockResolvedValue(mockFaucet),
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      await act(async () => {
        await result.current.createFaucet({
          tokenSymbol: "TEST",
          maxSupply: 1000n,
        });
      });

      expect(mockClient.getAccounts).toHaveBeenCalled();
      expect(useMidenStore.getState().accounts).toEqual(mockAccounts);
    });

    it("does not cache accounts from a faucet creation after the cache generation changes", async () => {
      const mockFaucet = createMockAccount({ isFaucet: vi.fn(() => true) });
      const staleAccounts = [createMockAccountHeader()];
      let finishAccounts!: (accounts: typeof staleAccounts) => void;
      const pendingAccounts = new Promise<typeof staleAccounts>((resolve) => {
        finishAccounts = resolve;
      });
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockResolvedValue(mockFaucet),
        getAccounts: vi.fn().mockReturnValue(pendingAccounts),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);
      const { result } = renderHook(() => useCreateFaucet());

      let creation!: Promise<unknown>;
      act(() => {
        creation = result.current.createFaucet({
          tokenSymbol: "TEST",
          maxSupply: 1000n,
        });
      });
      await waitFor(() => {
        expect(mockClient.getAccounts).toHaveBeenCalledTimes(1);
      });
      expect(result.current.isCreating).toBe(true);

      const generation = useMidenStore.getState().cacheGeneration;
      act(() => {
        useMidenStore.getState().resetInMemoryState();
      });
      expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

      await act(async () => {
        finishAccounts(staleAccounts);
        await expect(creation).resolves.toBe(mockFaucet);
      });

      expect(result.current.faucet).toBeNull();
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();
      expect(useMidenStore.getState().accounts).toEqual([]);
    });
  });

  describe("loading state", () => {
    it("should set isCreating during faucet creation", async () => {
      let resolvePromise: (value: any) => void;
      const createPromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockReturnValue(createPromise),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      // Start creation
      let createPromiseRef: Promise<any>;
      act(() => {
        createPromiseRef = result.current.createFaucet({
          tokenSymbol: "TEST",
          maxSupply: 1000n,
        });
      });

      // Should be creating
      await waitFor(() => {
        expect(result.current.isCreating).toBe(true);
      });

      // Resolve
      await act(async () => {
        resolvePromise!(createMockAccount());
        await createPromiseRef;
      });

      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      });
    });
  });

  describe("error handling", () => {
    it("should capture and expose creation errors", async () => {
      const creationError = new Error("Faucet creation failed");
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockRejectedValue(creationError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      await act(async () => {
        await expect(
          result.current.createFaucet({
            tokenSymbol: "TEST",
            maxSupply: 1000n,
          })
        ).rejects.toThrow("Faucet creation failed");
      });

      await waitFor(() => {
        expect(result.current.error).toBe(creationError);
      });
      expect(result.current.isCreating).toBe(false);
      expect(result.current.faucet).toBeNull();
    });

    it("should convert non-Error objects to Error", async () => {
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockRejectedValue("String error"),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      await act(async () => {
        await expect(
          result.current.createFaucet({
            tokenSymbol: "TEST",
            maxSupply: 1000n,
          })
        ).rejects.toThrow();
      });

      await waitFor(() => {
        expect(result.current.error).toBeInstanceOf(Error);
      });
    });
  });

  describe("reset", () => {
    it("should reset all state", async () => {
      const mockFaucet = createMockAccount();
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockResolvedValue(mockFaucet),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      // Create faucet
      await act(async () => {
        await result.current.createFaucet({
          tokenSymbol: "TEST",
          maxSupply: 1000n,
        });
      });

      expect(result.current.faucet).not.toBeNull();

      // Reset
      act(() => {
        result.current.reset();
      });

      expect(result.current.faucet).toBeNull();
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe("bigint handling", () => {
    it("should handle large maxSupply values", async () => {
      const mockFaucet = createMockAccount();
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockResolvedValue(mockFaucet),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      const largeSupply = 1000000000000000000n; // 1 quintillion

      await act(async () => {
        await result.current.createFaucet({
          tokenSymbol: "BIG",
          tokenName: "Big Token",
          maxSupply: largeSupply,
        });
      });

      expect(mockClient.newFaucet).toHaveBeenCalledWith(
        expect.anything(),
        false,
        "Big Token",
        "BIG",
        8,
        largeSupply,
        "falcon"
      );
    });

    it("falls back to private storage mode when storageMode is unknown (default branch)", async () => {
      const mockClient = createMockWebClient({
        newFaucet: vi.fn().mockResolvedValue(createMockAccount()),
        getAccounts: vi.fn().mockResolvedValue([createMockAccountHeader()]),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        runExclusive: <T,>(fn: () => Promise<T>) => fn(),
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateFaucet());

      await act(async () => {
        await result.current.createFaucet({
          tokenSymbol: "DEF",
          maxSupply: 100n,
          // Cast through unknown to bypass the type — the default case
          // returns AccountStorageMode.private().
          storageMode: "unknown" as unknown as "public",
        });
      });
      expect(mockClient.newFaucet).toHaveBeenCalled();
    });
  });
});

describe("useCreateFaucet client ownership", () => {
  it("rejects a callback retained from a replaced client before any SDK call", async () => {
    const clientA = createMockWebClient();
    useMidenStore.getState().setClient(clientA as never);
    mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
    const { result } = renderHook(() => useCreateFaucet());
    const saved = result.current.createFaucet;
    act(() => {
      useMidenStore.getState().setClient(createMockWebClient() as never);
    });

    await act(async () => {
      await expect(
        saved({ tokenSymbol: "TEST", maxSupply: 1000n })
      ).rejects.toThrow("Miden client is not ready");
    });
    expect(clientA.newFaucet).not.toHaveBeenCalled();
    expect(clientA.getAccounts).not.toHaveBeenCalled();
    expect(result.current.faucet).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isCreating).toBe(false);
  });

  it("does not create on a client replaced while waiting for the lock", async () => {
    const lock = new AsyncLock();
    const held = deferred<void>();
    const holding = lock.runExclusive(() => held.promise);
    const clientA = createMockWebClient();
    useMidenStore.getState().setClient(clientA as never);
    mockUseMiden.mockReturnValue({
      client: clientA,
      isReady: true,
      runExclusive: <T,>(fn: () => Promise<T>) => lock.runExclusive(fn),
    });
    const { result } = renderHook(() => useCreateFaucet());
    let creating!: Promise<unknown>;
    act(() => {
      creating = result.current.createFaucet({
        tokenSymbol: "TEST",
        maxSupply: 1000n,
      });
      void creating.catch(() => {});
    });
    expect(clientA.newFaucet).not.toHaveBeenCalled();
    act(() => {
      useMidenStore.getState().setClient(createMockWebClient() as never);
    });
    await act(async () => {
      held.resolve();
      await holding;
      await expect(creating).rejects.toThrow("Miden client is not ready");
    });
    expect(clientA.newFaucet).not.toHaveBeenCalled();
    expect(clientA.getAccounts).not.toHaveBeenCalled();
    expect(result.current.faucet).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isCreating).toBe(false);
  });

  it.each(["creation", "accounts", "error"])(
    "discards a replaced client's late %s without further SDK calls or state writes",
    async (stage) => {
      const pending = deferred<unknown>();
      const created = createMockAccount();
      const clientA = createMockWebClient({
        newFaucet:
          stage === "accounts"
            ? vi.fn().mockResolvedValue(created)
            : vi.fn().mockReturnValue(pending.promise),
        getAccounts:
          stage === "accounts"
            ? vi.fn().mockReturnValue(pending.promise)
            : vi.fn().mockResolvedValue([]),
      });
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
      const { result } = renderHook(() => useCreateFaucet());
      let creating!: Promise<unknown>;
      act(() => {
        creating = result.current.createFaucet({
          tokenSymbol: "TEST",
          maxSupply: 1000n,
        });
        void creating.catch(() => {});
      });
      await waitFor(() => {
        expect(
          stage === "accounts" ? clientA.getAccounts : clientA.newFaucet
        ).toHaveBeenCalledTimes(1);
      });
      const accountsB = [createMockAccountHeader("0x2000000000000002")];
      act(() => {
        useMidenStore.getState().resetInMemoryState();
        useMidenStore.getState().setClient(createMockWebClient() as never);
        useMidenStore.getState().setAccounts(accountsB as never);
      });
      const lateError = new Error("late creation failed");
      await act(async () => {
        if (stage === "error") {
          pending.reject(lateError);
          await expect(creating).rejects.toBe(lateError);
        } else {
          pending.resolve(stage === "accounts" ? [] : created);
          await expect(creating).resolves.toBe(created);
        }
      });
      expect(clientA.getAccounts).toHaveBeenCalledTimes(
        stage === "accounts" ? 1 : 0
      );
      expect(useMidenStore.getState().accounts).toBe(accountsB);
      expect(result.current.faucet).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isCreating).toBe(false);
    }
  );
});
