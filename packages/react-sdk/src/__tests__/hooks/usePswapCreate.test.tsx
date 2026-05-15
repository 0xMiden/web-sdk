import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePswapCreate } from "../../hooks/usePswapCreate";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockTransactionId,
  createMockTransactionRequest,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("usePswapCreate", () => {
  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCreate());

      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
      expect(typeof result.current.pswapCreate).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("pswap create transaction", () => {
    it("should throw error when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCreate());

      await expect(
        result.current.pswapCreate({
          accountId: "0xaccount",
          offeredFaucetId: "0xfaucetA",
          offeredAmount: 100n,
          requestedFaucetId: "0xfaucetB",
          requestedAmount: 50n,
        })
      ).rejects.toThrow("Miden client is not ready");
    });

    it("should execute pswap create with default note types (private)", async () => {
      const mockTxId = createMockTransactionId("0xpswap_create_tx");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCreate());

      let txResult;
      await act(async () => {
        txResult = await result.current.pswapCreate({
          accountId: "0xaccount",
          offeredFaucetId: "0xfaucetA",
          offeredAmount: 100n,
          requestedFaucetId: "0xfaucetB",
          requestedAmount: 50n,
        });
      });

      expect(txResult).toEqual({ transactionId: "0xpswap_create_tx" });
      expect(result.current.result).toEqual({
        transactionId: "0xpswap_create_tx",
      });
      expect(result.current.stage).toBe("complete");
      expect(mockSync).toHaveBeenCalled();
      expect(mockClient.newPswapCreateTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        100n,
        expect.anything(),
        50n,
        expect.anything(),
        expect.anything()
      );
    });

    it("should execute pswap create with custom note types", async () => {
      const mockTxId = createMockTransactionId();
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await result.current.pswapCreate({
          accountId: "0xaccount",
          offeredFaucetId: "0xfaucetA",
          offeredAmount: 200n,
          requestedFaucetId: "0xfaucetB",
          requestedAmount: 100n,
          noteType: "public",
          paybackNoteType: "public",
        });
      });

      expect(mockClient.newPswapCreateTransactionRequest).toHaveBeenCalled();
    });

    it("should handle different note type combinations", async () => {
      const mockTxId = createMockTransactionId();
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCreate());

      // Private/Private (defaults)
      await act(async () => {
        await result.current.pswapCreate({
          accountId: "0x1",
          offeredFaucetId: "0xA",
          offeredAmount: 1n,
          requestedFaucetId: "0xB",
          requestedAmount: 1n,
          noteType: "private",
          paybackNoteType: "private",
        });
      });

      // Public/Public
      act(() => {
        result.current.reset();
      });
      await act(async () => {
        await result.current.pswapCreate({
          accountId: "0x1",
          offeredFaucetId: "0xA",
          offeredAmount: 1n,
          requestedFaucetId: "0xB",
          requestedAmount: 1n,
          noteType: "public",
          paybackNoteType: "public",
        });
      });

      expect(mockClient.newPswapCreateTransactionRequest).toHaveBeenCalledTimes(
        2
      );
    });

    it("should use the remote prover when one is configured", async () => {
      const mockTxId = createMockTransactionId();
      const mockProver = { url: "https://prover.example" };
      const submitWithProver = vi.fn().mockResolvedValue(mockTxId);
      const submit = vi.fn().mockResolvedValue(mockTxId);
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: submit,
        submitNewTransactionWithProver: submitWithProver,
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
        prover: mockProver,
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await result.current.pswapCreate({
          accountId: "0x1",
          offeredFaucetId: "0xA",
          offeredAmount: 100n,
          requestedFaucetId: "0xB",
          requestedAmount: 50n,
        });
      });

      expect(submitWithProver).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe("stage transitions", () => {
    it("should transition through stages during execution", async () => {
      let resolveSubmit: () => void;
      const submitPromise = new Promise<
        ReturnType<typeof createMockTransactionId>
      >((resolve) => {
        resolveSubmit = () => resolve(createMockTransactionId());
      });

      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockReturnValue(submitPromise),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCreate());

      let pswapPromise: Promise<unknown>;
      act(() => {
        pswapPromise = result.current.pswapCreate({
          accountId: "0x1",
          offeredFaucetId: "0xA",
          offeredAmount: 100n,
          requestedFaucetId: "0xB",
          requestedAmount: 50n,
        });
      });

      await waitFor(() => {
        expect(result.current.stage).toBe("proving");
      });

      await act(async () => {
        resolveSubmit!();
        await pswapPromise;
      });

      expect(result.current.stage).toBe("complete");
    });
  });

  describe("error handling", () => {
    it("should surface submit errors and reset state to idle", async () => {
      const submitError = new Error("Insufficient liquidity");
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue(submitError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await expect(
          result.current.pswapCreate({
            accountId: "0x1",
            offeredFaucetId: "0xA",
            offeredAmount: 1000000n,
            requestedFaucetId: "0xB",
            requestedAmount: 1n,
          })
        ).rejects.toThrow("Insufficient liquidity");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("Insufficient liquidity");
      });
      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
    });

    it("should surface request-build errors", async () => {
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi.fn().mockImplementation(() => {
          throw new Error("Invalid PSWAP parameters");
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await expect(
          result.current.pswapCreate({
            accountId: "0x1",
            offeredFaucetId: "0xA",
            offeredAmount: 0n,
            requestedFaucetId: "0xB",
            requestedAmount: 0n,
          })
        ).rejects.toThrow("Invalid PSWAP parameters");
      });
    });

    it("should wrap non-Error throws in Error", async () => {
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi.fn().mockImplementation(() => {
          throw "boom"; // string, not Error
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await expect(
          result.current.pswapCreate({
            accountId: "0x1",
            offeredFaucetId: "0xA",
            offeredAmount: 1n,
            requestedFaucetId: "0xB",
            requestedAmount: 1n,
          })
        ).rejects.toThrow("boom");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("boom");
      });
    });

    it("should handle same asset create error", async () => {
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi.fn().mockImplementation(() => {
          throw new Error("Cannot create PSWAP with same asset");
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await expect(
          result.current.pswapCreate({
            accountId: "0x1",
            offeredFaucetId: "0xsamefaucet",
            offeredAmount: 100n,
            requestedFaucetId: "0xsamefaucet",
            requestedAmount: 100n,
          })
        ).rejects.toThrow("Cannot create PSWAP with same asset");
      });
    });
  });

  describe("reset", () => {
    it("should clear all state", async () => {
      const mockTxId = createMockTransactionId();
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await result.current.pswapCreate({
          accountId: "0x1",
          offeredFaucetId: "0xA",
          offeredAmount: 100n,
          requestedFaucetId: "0xB",
          requestedAmount: 50n,
        });
      });

      expect(result.current.result).not.toBeNull();

      act(() => {
        result.current.reset();
      });

      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
    });
  });

  describe("loading state", () => {
    it("should track isLoading during execution", async () => {
      let resolvePromise: (value: unknown) => void;
      const submitPromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockReturnValue(submitPromise),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCreate());

      let pswapPromise: Promise<unknown>;
      act(() => {
        pswapPromise = result.current.pswapCreate({
          accountId: "0x1",
          offeredFaucetId: "0xA",
          offeredAmount: 100n,
          requestedFaucetId: "0xB",
          requestedAmount: 50n,
        });
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      await act(async () => {
        resolvePromise!(createMockTransactionId());
        await pswapPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("sync after pswap create", () => {
    it("should trigger sync on success", async () => {
      const mockTxId = createMockTransactionId();
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await result.current.pswapCreate({
          accountId: "0x1",
          offeredFaucetId: "0xA",
          offeredAmount: 100n,
          requestedFaucetId: "0xB",
          requestedAmount: 50n,
        });
      });

      expect(mockSync).toHaveBeenCalledTimes(1);
    });

    it("should not trigger sync on failure", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue(new Error("Failed")),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCreate());

      await act(async () => {
        await expect(
          result.current.pswapCreate({
            accountId: "0x1",
            offeredFaucetId: "0xA",
            offeredAmount: 100n,
            requestedFaucetId: "0xB",
            requestedAmount: 50n,
          })
        ).rejects.toThrow();
      });

      expect(mockSync).not.toHaveBeenCalled();
    });
  });

  describe("bigint handling", () => {
    it("should preserve large amounts", async () => {
      const mockTxId = createMockTransactionId();
      const mockClient = createMockWebClient({
        newPswapCreateTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCreate());

      const largeOffer = 1_000_000_000_000_000_000n;
      const largeRequest = 500_000_000_000_000_000n;

      await act(async () => {
        await result.current.pswapCreate({
          accountId: "0x1",
          offeredFaucetId: "0xA",
          offeredAmount: largeOffer,
          requestedFaucetId: "0xB",
          requestedAmount: largeRequest,
        });
      });

      expect(mockClient.newPswapCreateTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        largeOffer,
        expect.anything(),
        largeRequest,
        expect.anything(),
        expect.anything()
      );
    });
  });
});
