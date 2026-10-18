import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCreateWallet } from "../../hooks/useCreateWallet";
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
    it.each(["reset", "replace"])(
      "drops a pending account list after %s and publishes a current wallet's list",
      async (change) => {
        const wallet = createMockAccount();
        const staleAccounts = [createMockAccountHeader("0x1000000000000001")];
        const retainedAccounts = [
          createMockAccountHeader("0x1000000000000002"),
        ];
        const currentAccounts = [createMockAccountHeader("0x1000000000000003")];
        let resolveAccounts!: (accounts: typeof staleAccounts) => void;
        const pendingAccounts = new Promise<typeof staleAccounts>((resolve) => {
          resolveAccounts = resolve;
        });
        const previousClient = createMockWebClient({
          newWallet: vi.fn().mockResolvedValue(wallet),
          getAccounts: vi
            .fn()
            .mockReturnValueOnce(pendingAccounts)
            .mockResolvedValue(currentAccounts),
        });
        const currentClient =
          change === "reset"
            ? previousClient
            : createMockWebClient({
                newWallet: vi.fn().mockResolvedValue(wallet),
                getAccounts: vi.fn().mockResolvedValue(currentAccounts),
              });
        useMidenStore.getState().setClient(previousClient as any);
        mockUseMiden.mockReturnValue({ client: previousClient, isReady: true });
        const { result, rerender } = renderHook(() => useCreateWallet());

        let creation!: ReturnType<typeof result.current.createWallet>;
        act(() => {
          creation = result.current.createWallet();
        });
        await waitFor(() => {
          expect(previousClient.getAccounts).toHaveBeenCalledTimes(1);
        });

        act(() => {
          if (change === "reset") {
            useMidenStore.getState().resetInMemoryState();
          } else {
            useMidenStore.getState().setClient(currentClient as any);
          }
          useMidenStore.getState().setAccounts(retainedAccounts as any);
          mockUseMiden.mockReturnValue({
            client: currentClient,
            isReady: true,
          });
          rerender();
        });
        await act(async () => {
          resolveAccounts(staleAccounts);
          expect(await creation).toBe(wallet);
        });

        expect(useMidenStore.getState().accounts).toBe(retainedAccounts);
        expect(result.current.wallet).toBe(wallet);
        expect(result.current.error).toBeNull();
        expect(result.current.isCreating).toBe(false);

        await act(async () => {
          expect(await result.current.createWallet()).toBe(wallet);
        });
        expect(useMidenStore.getState().accounts).toBe(currentAccounts);
      }
    );

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
        2, // authScheme (default: AuthRpoFalcon512)
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

      const { result } = renderHook(() => useCreateWallet());

      await act(async () => {
        await result.current.createWallet();
      });

      expect(mockClient.getAccounts).toHaveBeenCalled();
      expect(useMidenStore.getState().accounts).toEqual(mockAccounts);
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
