import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWaitForCommit } from "../../hooks/useWaitForCommit";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { TransactionFilter, TransactionId } from "@miden-sdk/miden-sdk";
import {
  createMockWebClient,
  createMockTransactionId,
} from "../mocks/miden-sdk";
import {
  installMoveAwareTransactionMocks,
  moveAwareGetTransactions,
} from "../mocks/moveAware";

// Mock useMiden
vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useWaitForCommit", () => {
  it("should throw when client is not ready", async () => {
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
    });

    const { result } = renderHook(() => useWaitForCommit());

    await expect(result.current.waitForCommit("0xtx")).rejects.toThrow(
      "Miden client is not ready"
    );
  });

  it("should resolve when transaction is committed (string id)", async () => {
    const record = {
      id: vi.fn(() => ({ toHex: () => "0xtx" })),
      transactionStatus: vi.fn(() => ({
        isPending: vi.fn(() => false),
        isCommitted: vi.fn(() => true),
        isDiscarded: vi.fn(() => false),
      })),
    };

    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForCommit());

    await result.current.waitForCommit("0xtx", {
      timeoutMs: 20,
      intervalMs: 1,
    });

    expect(TransactionId.fromHex).toHaveBeenCalledWith("0xtx");
    expect(TransactionFilter.ids).toHaveBeenCalledTimes(1);
  });

  it("should resolve when transaction is committed (TransactionId)", async () => {
    const txId = createMockTransactionId("0xtx123");
    const record = {
      id: vi.fn(() => ({ toHex: () => "0xtx123" })),
      transactionStatus: vi.fn(() => ({
        isPending: vi.fn(() => false),
        isCommitted: vi.fn(() => true),
        isDiscarded: vi.fn(() => false),
      })),
    };

    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForCommit());

    await result.current.waitForCommit(txId as never, {
      timeoutMs: 20,
      intervalMs: 1,
    });

    // The caller's handle never reaches a filter; a fresh id is built from
    // its hex instead.
    expect(TransactionId.fromHex).toHaveBeenCalledWith("0xtx123");
    expect(TransactionFilter.ids).not.toHaveBeenCalledWith([txId]);
  });

  describe("with by-value WASM handles", () => {
    let restore: () => void;

    beforeEach(() => {
      restore = installMoveAwareTransactionMocks();
    });

    afterEach(() => {
      restore();
    });

    it("keeps polling a TransactionId past the first poll", async () => {
      const txId = TransactionId.fromHex("0xtx123");
      const statuses = [false, false, true];
      let poll = 0;
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getTransactions: moveAwareGetTransactions(() => {
          const committed = statuses[poll++] ?? false;
          return [
            {
              id: () => ({ toHex: () => "0xtx123" }),
              transactionStatus: () => ({
                isPending: () => !committed,
                isCommitted: () => committed,
                isDiscarded: () => false,
              }),
            },
          ];
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
      });

      const { result } = renderHook(() => useWaitForCommit());

      await expect(
        result.current.waitForCommit(txId, { timeoutMs: 1000, intervalMs: 1 })
      ).resolves.toBeUndefined();
      expect(mockClient.getTransactions).toHaveBeenCalledTimes(3);
      // The caller still owns a live handle.
      expect(txId.toHex()).toBe("0xtx123");
    });
  });

  it("should throw when transaction is discarded", async () => {
    const record = {
      id: vi.fn(() => ({ toHex: () => "0xtx" })),
      transactionStatus: vi.fn(() => ({
        isPending: vi.fn(() => false),
        isCommitted: vi.fn(() => false),
        isDiscarded: vi.fn(() => true),
      })),
    };

    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForCommit());

    await expect(
      result.current.waitForCommit("0xtx", { timeoutMs: 20, intervalMs: 1 })
    ).rejects.toThrow("Transaction was discarded before commit");
  });

  it("treats a NaN intervalMs as the default instead of polling back to back", async () => {
    const syncState = vi.fn().mockResolvedValue({});
    const mockClient = createMockWebClient({
      syncState,
      getTransactions: vi.fn().mockResolvedValue([]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForCommit());

    await expect(
      result.current.waitForCommit("0xtx", {
        timeoutMs: 50,
        intervalMs: Number.NaN,
      })
    ).rejects.toThrow("Timeout waiting for transaction commit");
    expect(syncState.mock.calls.length).toBeLessThanOrEqual(2);
  }, 10000);

  it("gives up at the timeout, not a full interval later", async () => {
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getTransactions: vi.fn().mockResolvedValue([]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForCommit());

    const start = Date.now();
    await expect(
      result.current.waitForCommit("0xtx", { timeoutMs: 50, intervalMs: 5000 })
    ).rejects.toThrow("Timeout waiting for transaction commit");
    expect(Date.now() - start).toBeLessThan(1000);
  }, 10000);
});
