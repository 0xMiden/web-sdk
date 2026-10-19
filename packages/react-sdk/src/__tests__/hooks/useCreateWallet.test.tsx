import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCreateWallet } from "../../hooks/useCreateWallet";
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

describe("useCreateWallet", () => {
  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
      });

      const { result } = renderHook(() => useCreateWallet());

      expect(result.current.wallet).toBeNull();
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();
      expect(typeof result.current.createWallet).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("createWallet", () => {
    it("should throw error when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
      });

      const { result } = renderHook(() => useCreateWallet());

      await expect(result.current.createWallet()).rejects.toThrow(
        "Miden client is not ready"
      );
    });

    it("should create wallet with default options", async () => {
      const mockWallet = createMockAccount();
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getAccounts: vi.fn().mockResolvedValue([createMockAccountHeader()]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      let createdWallet;
      await act(async () => {
        createdWallet = await result.current.createWallet();
      });

      expect(createdWallet).toBe(mockWallet);
      expect(result.current.wallet).toBe(mockWallet);
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();

      // Verify default options were used
      expect(mockClient.newWallet).toHaveBeenCalledWith(
        expect.anything(), // storageMode.private()
        "falcon", // authScheme (default: AuthScheme.Falcon)
        undefined // initSeed
      );
    });

    it("should create wallet with custom options", async () => {
      const mockWallet = createMockAccount();
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      const initSeed = new Uint8Array(32);
      await act(async () => {
        await result.current.createWallet({
          storageMode: "public",
          authScheme: 1,
          initSeed,
        });
      });

      expect(mockClient.newWallet).toHaveBeenCalledWith(
        expect.anything(), // storageMode.public()
        1,
        initSeed
      );
    });

    it("should create wallet with private storage mode", async () => {
      const mockWallet = createMockAccount();
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      await act(async () => {
        await result.current.createWallet({ storageMode: "private" });
      });

      expect(mockClient.newWallet).toHaveBeenCalled();
    });

    it("should refresh accounts list after creation", async () => {
      const mockWallet = createMockAccount();
      const mockAccounts = [createMockAccountHeader()];
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getAccounts: vi.fn().mockResolvedValue(mockAccounts),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      await act(async () => {
        await result.current.createWallet();
      });

      expect(mockClient.getAccounts).toHaveBeenCalled();
      expect(useMidenStore.getState().accounts).toEqual(mockAccounts);
    });

    it("does not cache accounts from a wallet creation after the cache generation changes", async () => {
      const mockWallet = createMockAccount();
      const staleAccounts = [createMockAccountHeader()];
      let finishAccounts!: (accounts: typeof staleAccounts) => void;
      const pendingAccounts = new Promise<typeof staleAccounts>((resolve) => {
        finishAccounts = resolve;
      });
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getAccounts: vi.fn().mockReturnValue(pendingAccounts),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);
      const { result } = renderHook(() => useCreateWallet());

      let creation!: Promise<unknown>;
      act(() => {
        creation = result.current.createWallet();
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
        await expect(creation).resolves.toBe(mockWallet);
      });

      expect(result.current.wallet).toBeNull();
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();
      expect(useMidenStore.getState().accounts).toEqual([]);
    });
  });

  describe("loading state", () => {
    it("should set isCreating during wallet creation", async () => {
      let resolvePromise: (value: any) => void;
      const createPromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockReturnValue(createPromise),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      // Start creation
      let createPromiseRef: Promise<any>;
      act(() => {
        createPromiseRef = result.current.createWallet();
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
      const creationError = new Error("Wallet creation failed");
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockRejectedValue(creationError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      await act(async () => {
        await expect(result.current.createWallet()).rejects.toThrow(
          "Wallet creation failed"
        );
      });

      await waitFor(() => {
        expect(result.current.error).toBe(creationError);
      });
      expect(result.current.isCreating).toBe(false);
      expect(result.current.wallet).toBeNull();
    });

    it("should convert non-Error objects to Error", async () => {
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockRejectedValue("String error"),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      await act(async () => {
        await expect(result.current.createWallet()).rejects.toThrow();
      });

      await waitFor(() => {
        expect(result.current.error).toBeInstanceOf(Error);
        expect(result.current.error?.message).toBe("String error");
      });
    });
  });

  describe("reset", () => {
    it("should reset all state", async () => {
      const mockWallet = createMockAccount();
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(mockWallet),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      // Create wallet
      await act(async () => {
        await result.current.createWallet();
      });

      expect(result.current.wallet).not.toBeNull();

      // Reset
      act(() => {
        result.current.reset();
      });

      expect(result.current.wallet).toBeNull();
      expect(result.current.isCreating).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should allow creating new wallet after reset", async () => {
      const mockWallet1 = createMockAccount();
      const mockWallet2 = createMockAccount();
      const mockClient = createMockWebClient({
        newWallet: vi
          .fn()
          .mockResolvedValueOnce(mockWallet1)
          .mockResolvedValueOnce(mockWallet2),
        getAccounts: vi.fn().mockResolvedValue([]),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());

      // First creation
      await act(async () => {
        await result.current.createWallet();
      });

      expect(result.current.wallet).toBe(mockWallet1);

      // Reset
      act(() => {
        result.current.reset();
      });

      // Second creation
      await act(async () => {
        await result.current.createWallet();
      });

      expect(result.current.wallet).toBe(mockWallet2);
    });

    it("falls back to private storage mode when storageMode is unknown (default branch)", async () => {
      const mockClient = createMockWebClient({
        newWallet: vi.fn().mockResolvedValue(createMockAccount()),
        getAccounts: vi.fn().mockResolvedValue([createMockAccountHeader()]),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        runExclusive: <T,>(fn: () => Promise<T>) => fn(),
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useCreateWallet());
      await act(async () => {
        await result.current.createWallet({
          // Cast to bypass the union; the default branch returns private().
          storageMode: "unknown" as unknown as "public",
        });
      });
      expect(mockClient.newWallet).toHaveBeenCalled();
    });
  });
});

describe("useCreateWallet client ownership", () => {
  it("rejects a callback retained from a replaced client before any SDK call", async () => {
    const clientA = createMockWebClient();
    useMidenStore.getState().setClient(clientA as never);
    mockUseMiden.mockReturnValue({ client: clientA, isReady: true });
    const { result } = renderHook(() => useCreateWallet());
    const saved = result.current.createWallet;
    act(() => {
      useMidenStore.getState().setClient(createMockWebClient() as never);
    });

    await act(async () => {
      await expect(saved()).rejects.toThrow("Miden client is not ready");
    });
    expect(clientA.newWallet).not.toHaveBeenCalled();
    expect(clientA.getAccounts).not.toHaveBeenCalled();
    expect(result.current.wallet).toBeNull();
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
    const { result } = renderHook(() => useCreateWallet());
    let creating!: Promise<unknown>;
    act(() => {
      creating = result.current.createWallet();
      void creating.catch(() => {});
    });
    expect(clientA.newWallet).not.toHaveBeenCalled();
    act(() => {
      useMidenStore.getState().setClient(createMockWebClient() as never);
    });
    await act(async () => {
      held.resolve();
      await holding;
      await expect(creating).rejects.toThrow("Miden client is not ready");
    });
    expect(clientA.newWallet).not.toHaveBeenCalled();
    expect(clientA.getAccounts).not.toHaveBeenCalled();
    expect(result.current.wallet).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isCreating).toBe(false);
  });

  it.each(["creation", "accounts", "error"])(
    "discards a replaced client's late %s without further SDK calls or state writes",
    async (stage) => {
      const pending = deferred<unknown>();
      const created = createMockAccount();
      const clientA = createMockWebClient({
        newWallet:
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
      const { result } = renderHook(() => useCreateWallet());
      let creating!: Promise<unknown>;
      act(() => {
        creating = result.current.createWallet();
        void creating.catch(() => {});
      });
      await waitFor(() => {
        expect(
          stage === "accounts" ? clientA.getAccounts : clientA.newWallet
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
      expect(result.current.wallet).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isCreating).toBe(false);
    }
  );
});
