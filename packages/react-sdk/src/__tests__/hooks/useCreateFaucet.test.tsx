import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCreateFaucet } from "../../hooks/useCreateFaucet";
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

describe("useCreateFaucet", () => {
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
    it.each(["reset", "replace"])(
      "drops a pending account list after %s and publishes a current faucet's list",
      async (change) => {
        const faucet = createMockAccount({ isFaucet: vi.fn(() => true) });
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
          newFaucet: vi.fn().mockResolvedValue(faucet),
          getAccounts: vi
            .fn()
            .mockReturnValueOnce(pendingAccounts)
            .mockResolvedValue(currentAccounts),
        });
        const currentClient =
          change === "reset"
            ? previousClient
            : createMockWebClient({
                newFaucet: vi.fn().mockResolvedValue(faucet),
                getAccounts: vi.fn().mockResolvedValue(currentAccounts),
              });
        const options = { tokenSymbol: "TEST", maxSupply: 1000n };
        useMidenStore.getState().setClient(previousClient as any);
        mockUseMiden.mockReturnValue({ client: previousClient, isReady: true });
        const { result, rerender } = renderHook(() => useCreateFaucet());

        let creation!: ReturnType<typeof result.current.createFaucet>;
        act(() => {
          creation = result.current.createFaucet(options);
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
          expect(await creation).toBe(faucet);
        });

        expect(useMidenStore.getState().accounts).toBe(retainedAccounts);
        expect(result.current.faucet).toBe(faucet);
        expect(result.current.error).toBeNull();
        expect(result.current.isCreating).toBe(false);

        await act(async () => {
          expect(await result.current.createFaucet(options)).toBe(faucet);
        });
        expect(useMidenStore.getState().accounts).toBe(currentAccounts);
      }
    );

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
        "TEST", // tokenName falls back to tokenSymbol
        "TEST",
        8, // decimals (default)
        1000000n,
        2 // authScheme (default: AuthRpoFalcon512)
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
      useMidenStore.getState().setClient(mockClient as any);

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

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
        "Big Token",
        "BIG",
        8,
        largeSupply,
        2
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
