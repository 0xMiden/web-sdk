import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBatch } from "../../hooks/useBatch";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { createMockWebClient } from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

vi.mock("@miden-sdk/miden-sdk", () => ({
  BatchItem: vi.fn().mockImplementation((account, request) => ({
    account,
    request,
  })),
}));

vi.mock("../../utils/accountParsing", () => ({
  parseAccountId: vi.fn((ref: string) => ({ toString: () => ref })),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

const fakeRequest = (label: string) => ({ _label: label });

describe("useBatch", () => {
  describe("initial state", () => {
    it("returns the expected initial fields", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
        signerConnected: true,
      });
      const { result } = renderHook(() => useBatch());
      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
      expect(typeof result.current.batch).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("batch submission", () => {
    it("throws when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
        signerConnected: true,
      });
      const { result } = renderHook(() => useBatch());
      await expect(
        result.current.batch({
          items: [{ account: "0xa", request: fakeRequest("r") }],
        })
      ).rejects.toThrow("Miden client is not ready");
    });

    it("rejects an empty items array", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
        signerConnected: true,
      });
      const { result } = renderHook(() => useBatch());
      await expect(result.current.batch({ items: [] })).rejects.toThrow(
        /non-empty array/
      );
    });

    it("rejects an item missing account or request", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
        signerConnected: true,
      });
      const { result } = renderHook(() => useBatch());
      await expect(
        result.current.batch({
          items: [{ request: fakeRequest("r") } as never],
        })
      ).rejects.toThrow(/missing.*account/);
      await expect(
        result.current.batch({
          items: [{ account: "0xa" } as never],
        })
      ).rejects.toThrow(/missing.*request/);
    });

    it("submits via submitNewTransactionBatch and returns blockNumber", async () => {
      const mockClient = createMockWebClient({
        submitNewTransactionBatch: vi.fn().mockResolvedValue(42),
      });
      const sync = vi.fn().mockResolvedValue(undefined);
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync,
        signerConnected: true,
      });

      const { result } = renderHook(() => useBatch());
      let res: { blockNumber: number } | undefined;
      await act(async () => {
        res = await result.current.batch({
          items: [
            { account: "0xa", request: fakeRequest("r1") },
            { account: "0xb", request: fakeRequest("r2") },
          ],
        });
      });

      expect(res).toEqual({ blockNumber: 42 });
      expect(mockClient.submitNewTransactionBatch).toHaveBeenCalledTimes(1);
      const [itemsArg] = mockClient.submitNewTransactionBatch.mock.calls[0];
      expect(itemsArg).toHaveLength(2);
      // sync runs before submit + once after for fresh state
      expect(sync).toHaveBeenCalledTimes(2);
    });

    it("skips the pre-submit sync when skipSync=true", async () => {
      const mockClient = createMockWebClient({
        submitNewTransactionBatch: vi.fn().mockResolvedValue(7),
      });
      const sync = vi.fn().mockResolvedValue(undefined);
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync,
        signerConnected: true,
      });

      const { result } = renderHook(() => useBatch());
      await act(async () => {
        await result.current.batch({
          items: [{ account: "0xa", request: fakeRequest("r") }],
          skipSync: true,
        });
      });

      // Only the post-submit sync should have fired.
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it("surfaces submission errors and resets stage to idle", async () => {
      const err = new Error("submit failed");
      const mockClient = createMockWebClient({
        submitNewTransactionBatch: vi.fn().mockRejectedValue(err),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
        signerConnected: true,
      });

      const { result } = renderHook(() => useBatch());
      await act(async () => {
        await expect(
          result.current.batch({
            items: [{ account: "0xa", request: fakeRequest("r") }],
          })
        ).rejects.toThrow("submit failed");
      });
      expect(result.current.stage).toBe("idle");
      expect(result.current.error?.message).toBe("submit failed");
    });
  });

  describe("guards", () => {
    it("rejects when the signer is not connected", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
        signerConnected: false,
      });
      const { result } = renderHook(() => useBatch());
      await expect(
        result.current.batch({
          items: [{ account: "0xa", request: fakeRequest("r") }],
        })
      ).rejects.toThrow();
      // The submit path must not have been reached.
      expect(mockClient.submitNewTransactionBatch).not.toHaveBeenCalled();
    });

    it("rejects a concurrent batch with BATCH_BUSY while the first is in flight", async () => {
      // Hold the first submit open via a pending promise so the second call
      // sees `isBusyRef.current === true`.
      let resolveFirst: ((blockNumber: number) => void) | undefined;
      const submitNewTransactionBatch = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<number>((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValueOnce(2);
      const mockClient = createMockWebClient({ submitNewTransactionBatch });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
        signerConnected: true,
      });

      const { result } = renderHook(() => useBatch());
      let firstPromise: Promise<unknown>;
      await act(async () => {
        firstPromise = result.current.batch({
          items: [{ account: "0xa", request: fakeRequest("first") }],
        });
      });

      await expect(
        result.current.batch({
          items: [{ account: "0xb", request: fakeRequest("second") }],
        })
      ).rejects.toThrow(/in progress/i);

      // Resolve the first call so the hook unwinds cleanly.
      await act(async () => {
        resolveFirst!(1);
        await firstPromise!;
      });
    });
  });

  describe("reset", () => {
    it("clears result, error, and stage", async () => {
      const mockClient = createMockWebClient({
        submitNewTransactionBatch: vi.fn().mockResolvedValue(100),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
        signerConnected: true,
      });
      const { result } = renderHook(() => useBatch());
      await act(async () => {
        await result.current.batch({
          items: [{ account: "0xa", request: fakeRequest("r") }],
        });
      });
      expect(result.current.result).toEqual({ blockNumber: 100 });
      act(() => result.current.reset());
      expect(result.current.result).toBeNull();
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
    });
  });
});
