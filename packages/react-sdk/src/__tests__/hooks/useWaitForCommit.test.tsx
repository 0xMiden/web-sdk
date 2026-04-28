import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWaitForCommit } from "../../hooks/useWaitForCommit";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { TransactionFilter } from "@miden-sdk/miden-sdk/lazy";
import {
  createMockWebClient,
  createMockTransactionId,
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

describe("useWaitForCommit", () => {
  it("uses default timeoutMs and intervalMs when options are omitted", async () => {
    // No timeoutMs or intervalMs passed — exercises the ?? fallback branches.
    // We make the transaction immediately committed so it resolves before the
    // 10s default timeout.
    const record = {
      id: vi.fn(() => ({ toHex: () => "0xdefaulttx" })),
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

    // Omit options entirely — hits the ?? 10_000 and ?? 1_000 defaults
    await result.current.waitForCommit("0xdefaulttx");

    expect(mockClient.getTransactions).toHaveBeenCalled();
  });

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

    expect(mockClient.getTransactions).toHaveBeenCalledWith(
      TransactionFilter.all()
    );
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

    await result.current.waitForCommit(txId, {
      timeoutMs: 20,
      intervalMs: 1,
    });

    expect(mockClient.getTransactions).toHaveBeenCalledWith(
      TransactionFilter.ids([txId])
    );
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

  it("should throw timeout when no record found before deadline (lines 70-73)", async () => {
    // Return empty array — record never found, loop times out
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getTransactions: vi.fn().mockResolvedValue([]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForCommit());

    await expect(
      result.current.waitForCommit("0xtx", { timeoutMs: 5, intervalMs: 1 })
    ).rejects.toThrow("Timeout waiting for transaction commit");
  });

  it("should normalize hex without 0x prefix (line 86)", async () => {
    // Pass a tx ID string without 0x prefix to exercise the normalizeHex else branch
    const record = {
      id: vi.fn(() => ({ toHex: () => "txabc123" })), // no 0x in returned hex
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

    // Pass bare hex without 0x — normalizeHex should prepend it
    await result.current.waitForCommit("txabc123", {
      timeoutMs: 20,
      intervalMs: 1,
    });
  });

  it("should handle pending status correctly (record found but not committed/discarded yet)", async () => {
    let callCount = 0;
    const makeRecord = (committed: boolean) => ({
      id: vi.fn(() => ({ toHex: () => "0xtxpending" })),
      transactionStatus: vi.fn(() => ({
        isPending: vi.fn(() => !committed),
        isCommitted: vi.fn(() => committed),
        isDiscarded: vi.fn(() => false),
      })),
    });

    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getTransactions: vi.fn().mockImplementation(() => {
        callCount++;
        // First two calls return pending, third returns committed
        return Promise.resolve([makeRecord(callCount >= 3)]);
      }),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForCommit());

    await result.current.waitForCommit("0xtxpending", {
      timeoutMs: 200,
      intervalMs: 1,
    });

    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});
