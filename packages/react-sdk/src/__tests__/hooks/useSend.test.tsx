import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSend } from "../../hooks/useSend";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockTransactionRequest,
  createMockTransactionResult,
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

describe("useSend", () => {
  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSend());

      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
      expect(typeof result.current.send).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("send transaction", () => {
    it("should throw error when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSend());

      await expect(
        result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          amount: 100n,
        })
      ).rejects.toThrow("Miden client is not ready");
    });

    it("should execute send transaction with default options", async () => {
      const mockTxResult = createMockTransactionResult("0xtx123");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useSend());

      let txResult;
      await act(async () => {
        txResult = await result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          amount: 100n,
        });
      });

      expect(txResult).toEqual({ txId: "0xtx123", note: null });
      expect(result.current.result).toEqual({ txId: "0xtx123", note: null });
      expect(result.current.stage).toBe("complete");
      expect(result.current.isLoading).toBe(false);
      expect(mockSync).toHaveBeenCalled();
    });

    it("should execute send transaction with custom options", async () => {
      const mockTxResult = createMockTransactionResult();
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          amount: 500n,
          noteType: "public",
          recallHeight: 1000,
          timelockHeight: 500,
        });
      });

      expect(mockClient.newSendTransactionRequest).toHaveBeenCalledWith(
        expect.anything(), // fromAccountId
        expect.anything(), // toAccountId
        expect.anything(), // assetIdObj
        expect.anything(), // noteType (public)
        500n,
        1000,
        500
      );
    });

    it("should execute send with returnNote=true via submitNewTransaction", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockTxId = { toString: vi.fn(() => "0xtx456") };
      const mockClient = createMockWebClient({
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useSend());

      let txResult: any;
      await act(async () => {
        txResult = await result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          amount: 100n,
          returnNote: true,
        });
      });

      expect(txResult.txId).toBe("0xtx456");
      expect(txResult.note).not.toBeNull();
      expect(result.current.stage).toBe("complete");
      expect(mockClient.submitNewTransaction).toHaveBeenCalled();
      expect(mockClient.executeTransaction).not.toHaveBeenCalled();
      expect(mockSync).toHaveBeenCalled();
    });

    it("should handle different note types", async () => {
      const mockTxResult = createMockTransactionResult();
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useSend());

      // Test private
      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
          noteType: "private",
        });
      });

      // Test public
      act(() => {
        result.current.reset();
      });
      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
          noteType: "public",
        });
      });

      expect(mockClient.newSendTransactionRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe("stage transitions", () => {
    it("should transition through stages during execution", async () => {
      let resolveExecute: () => void;
      let resolveProve: () => void;
      let resolveSubmit: () => void;

      const executePromise = new Promise((resolve) => {
        resolveExecute = () => resolve(createMockTransactionResult());
      });
      const provePromise = new Promise((resolve) => {
        resolveProve = () => resolve({});
      });
      const submitPromise = new Promise((resolve) => {
        resolveSubmit = () => resolve(100);
      });

      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockReturnValue(executePromise),
        proveTransaction: vi.fn().mockReturnValue(provePromise),
        submitProvenTransaction: vi.fn().mockReturnValue(submitPromise),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      // Start send
      let sendPromise: Promise<any>;
      act(() => {
        sendPromise = result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
        });
      });

      await waitFor(() => {
        expect(result.current.stage).toBe("executing");
      });

      // Resolve execute -> proving
      resolveExecute!();
      await waitFor(() => {
        expect(result.current.stage).toBe("proving");
      });

      // Resolve prove -> submitting
      resolveProve!();
      await waitFor(() => {
        expect(result.current.stage).toBe("submitting");
      });

      await act(async () => {
        resolveSubmit!();
        await sendPromise;
      });

      expect(result.current.stage).toBe("complete");
    });
  });

  describe("error handling", () => {
    it("should handle transaction errors", async () => {
      const txError = new Error("Insufficient balance");
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockRejectedValue(txError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await expect(
          result.current.send({
            from: "0x1",
            to: "0x2",
            assetId: "0x3",
            amount: 1000000n,
          })
        ).rejects.toThrow("Insufficient balance");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("Insufficient balance");
      });
      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
    });

    it("should handle request creation errors", async () => {
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi.fn().mockImplementation(() => {
          throw new Error("Invalid parameters");
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await expect(
          result.current.send({
            from: "0x1",
            to: "0x2",
            assetId: "0x3",
            amount: 1n,
          })
        ).rejects.toThrow("Invalid parameters");
      });

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });
    });
  });

  describe("reset", () => {
    it("should reset all state", async () => {
      const mockTxResult = createMockTransactionResult();
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      // Execute send
      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
        });
      });

      expect(result.current.result).not.toBeNull();
      expect(result.current.stage).toBe("complete");

      // Reset
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
    it("should set isLoading during transaction", async () => {
      let resolveExecute: () => void;
      const executePromise = new Promise((resolve) => {
        resolveExecute = () => resolve(createMockTransactionResult());
      });

      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockReturnValue(executePromise),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      // Start send
      let sendPromise: Promise<any>;
      act(() => {
        sendPromise = result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
        });
      });

      // Should be loading
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      // Resolve
      await act(async () => {
        resolveExecute!();
        await sendPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("concurrency guard", () => {
    it("should reject concurrent sends with SEND_BUSY", async () => {
      let resolveExecute: () => void;
      const executePromise = new Promise((resolve) => {
        resolveExecute = () => resolve(createMockTransactionResult());
      });

      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockReturnValue(executePromise),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      // Start first send
      let firstSend: Promise<any>;
      act(() => {
        firstSend = result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
        });
      });

      // Try second send while first is in progress
      await expect(
        result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
        })
      ).rejects.toThrow("A send is already in progress");

      // Resolve first send
      await act(async () => {
        resolveExecute!();
        await firstSend;
      });
    });
  });

  describe("auto-sync", () => {
    it("should call sync before send by default", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockTxResult = createMockTransactionResult();
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
        });
      });

      // sync called before send + after send = at least 2 calls
      expect(mockSync).toHaveBeenCalled();
    });

    it("should skip sync when skipSync is true", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockTxResult = createMockTransactionResult();
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 1n,
          skipSync: true,
        });
      });

      // sync should only be called once (the post-send sync), not before
      expect(mockSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendAll", () => {
    it("should query account balance when sendAll is true", async () => {
      const mockAccount = {
        vault: vi.fn(() => ({
          getBalance: vi.fn(() => 500n),
        })),
      };

      const mockTxResult = createMockTransactionResult();
      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(mockAccount),
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          sendAll: true,
        });
      });

      expect(mockClient.getAccount).toHaveBeenCalled();
      expect(result.current.stage).toBe("complete");
    });

    it("should throw when sendAll balance is zero", async () => {
      const mockAccount = {
        vault: vi.fn(() => ({
          getBalance: vi.fn(() => 0n),
        })),
      };

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await expect(
          result.current.send({
            from: "0x1",
            to: "0x2",
            assetId: "0x3",
            sendAll: true,
          })
        ).rejects.toThrow("zero balance");
      });
    });
  });

  describe("send option validation branches (lines 134-148)", () => {
    it("should throw when no assetId or faucetId provided (line 136)", async () => {
      mockUseMiden.mockReturnValue({
        client: createMockWebClient(),
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await expect(
          result.current.send({
            from: "0x1",
            to: "0x2",
            amount: 100n,
            // assetId and faucetId both absent
          } as any)
        ).rejects.toThrow("Asset ID is required");
      });
    });

    it("should throw when attachment provided with recallHeight (lines 146-149)", async () => {
      mockUseMiden.mockReturnValue({
        client: createMockWebClient(),
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await expect(
          result.current.send({
            from: "0x1",
            to: "0x2",
            assetId: "0x3",
            amount: 100n,
            attachment: { kind: "none" } as any,
            recallHeight: 1000,
          })
        ).rejects.toThrow(
          "recallHeight and timelockHeight are not supported when attachment is provided"
        );
      });
    });

    it("should use proveTransactionWithProver when store config has prover (line 247)", async () => {
      const mockTxResult = createMockTransactionResult("0xtxstoreprover");
      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransactionWithProver: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      // Set store config with a prover so proveWithFallback uses proveTransactionWithProver
      useMidenStore
        .getState()
        .setConfig({ rpcUrl: "testnet", prover: "local" });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 100n,
          noteType: "public",
        });
      });

      expect(mockClient.proveTransactionWithProver).toHaveBeenCalled();
      expect(result.current.stage).toBe("complete");
    });
  });

  describe("private note branch coverage", () => {
    it("should throw Missing full note when extractFullNote returns null (lines 276-277)", async () => {
      // Return a txResult whose executedTransaction throws so extractFullNote catches and returns null
      const brokenTxResult = {
        id: vi.fn(() => ({
          toHex: vi.fn(() => "0xtxbad"),
          toString: vi.fn(() => "0xtxbad"),
        })),
        executedTransaction: vi.fn(() => {
          throw new Error("no output notes");
        }),
      };

      const record = {
        id: vi.fn(() => ({ toHex: () => "0xtxbad" })),
        transactionStatus: vi.fn(() => ({
          isPending: vi.fn(() => false),
          isCommitted: vi.fn(() => true),
          isDiscarded: vi.fn(() => false),
        })),
      };

      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(brokenTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        getTransactions: vi.fn().mockResolvedValue([record]),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await expect(
          result.current.send({
            from: "0x1",
            to: "0x2",
            assetId: "0x3",
            amount: 100n,
            noteType: "private",
          })
        ).rejects.toThrow("Missing full note for private send");
      });
    });

    it("should use submitNewTransactionWithProver in returnNote path (line 183)", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockTxId = { toString: vi.fn(() => "0xtxprover456") };
      const mockProver = { type: "local" };
      const mockClient = createMockWebClient({
        submitNewTransactionWithProver: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
        prover: mockProver,
      });

      const { result } = renderHook(() => useSend());

      let txResult: any;
      await act(async () => {
        txResult = await result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          amount: 100n,
          returnNote: true,
        });
      });

      expect(txResult.txId).toBe("0xtxprover456");
      expect(mockClient.submitNewTransactionWithProver).toHaveBeenCalled();
    });

    it("should build P2ID note with attachment (lines 209-222)", async () => {
      const mockTxResult = createMockTransactionResult("0xtxattach");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        executeTransaction: vi.fn().mockResolvedValue(mockTxResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 100n,
          noteType: "public",
          // attachment triggers the hasAttachment path
          attachment: { kind: "none" } as any,
        });
      });

      // executeTransaction called (not submitNewTransaction) — attachment path
      expect(mockClient.executeTransaction).toHaveBeenCalled();
      expect(result.current.stage).toBe("complete");
    });

    it("should send private note when fullNote is available (lines 279-291)", async () => {
      const txResult = createMockTransactionResult("0xtxprivate");
      const record = {
        id: vi.fn(() => ({ toHex: () => "0xtxprivate" })),
        transactionStatus: vi.fn(() => ({
          isPending: vi.fn(() => false),
          isCommitted: vi.fn(() => true),
          isDiscarded: vi.fn(() => false),
        })),
      };

      const mockClient = createMockWebClient({
        newSendTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        executeTransaction: vi.fn().mockResolvedValue(txResult),
        proveTransaction: vi.fn().mockResolvedValue({}),
        submitProvenTransaction: vi.fn().mockResolvedValue(100),
        applyTransaction: vi.fn().mockResolvedValue({}),
        getTransactions: vi.fn().mockResolvedValue([record]),
        sendPrivateNote: vi.fn().mockResolvedValue(undefined),
        syncState: vi.fn().mockResolvedValue({}),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await result.current.send({
          from: "0x1",
          to: "0x2",
          assetId: "0x3",
          amount: 100n,
          noteType: "private",
        });
      });

      expect(mockClient.sendPrivateNote).toHaveBeenCalledTimes(1);
      expect(result.current.stage).toBe("complete");
    });
  });

  describe("sendAll balance edge cases", () => {
    it("should throw when vault getBalance returns null (lines 113-115)", async () => {
      const mockAccount = {
        vault: vi.fn(() => ({
          getBalance: vi.fn(() => null),
        })),
      };

      const mockClient = createMockWebClient({
        getAccount: vi.fn().mockResolvedValue(mockAccount),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await expect(
          result.current.send({
            from: "0x1",
            to: "0x2",
            assetId: "0x3",
            sendAll: true,
          })
        ).rejects.toThrow("Could not query account balance");
      });
    });

    it("should throw when amount is undefined and sendAll is false (lines 125-127)", async () => {
      mockUseMiden.mockReturnValue({
        client: createMockWebClient(),
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useSend());

      await act(async () => {
        await expect(
          result.current.send({
            from: "0x1",
            to: "0x2",
            assetId: "0x3",
            // amount is undefined, sendAll is false
          } as any)
        ).rejects.toThrow("Amount is required");
      });
    });
  });
});
