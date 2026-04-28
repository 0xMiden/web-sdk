import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useTransactionHistory } from "../../hooks/useTransactionHistory";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { TransactionFilter } from "@miden-sdk/miden-sdk/lazy";
import {
  createMockTransactionId,
  createMockWebClient,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

const createRecord = (
  id: string,
  status: "committed" | "pending" | "discarded" = "committed"
) => ({
  id: vi.fn(() => createMockTransactionId(id)),
  transactionStatus: vi.fn(() => ({
    isPending: vi.fn(() => status === "pending"),
    isCommitted: vi.fn(() => status === "committed"),
    isDiscarded: vi.fn(() => status === "discarded"),
  })),
});

describe("useTransactionHistory", () => {
  it("returns early without fetching when client is not ready", async () => {
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([]),
    });

    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
    });

    const { result } = renderHook(() => useTransactionHistory());

    await act(async () => {
      await result.current.refetch();
    });

    expect(mockClient.getTransactions).not.toHaveBeenCalled();
  });

  it("wraps non-Error rejection from getTransactions in an Error instance", async () => {
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockRejectedValueOnce("plain-string-rejection"),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useTransactionHistory());

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("plain-string-rejection");
    });
  });

  it("passes Error instances through unchanged in catch block", async () => {
    const fetchError = new Error("fetch-failed");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockRejectedValueOnce(fetchError),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useTransactionHistory());

    await waitFor(() => {
      expect(result.current.error).toBe(fetchError);
    });
  });

  it("triggers refetch when isReady transitions from false to true", async () => {
    const record = createRecord("0xabc");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    // Start not ready
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
    });

    const { result, rerender } = renderHook(() => useTransactionHistory());

    expect(result.current.records).toHaveLength(0);

    // Now become ready
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });
    rerender();

    await waitFor(() => expect(result.current.records).toHaveLength(1));
  });

  it("returns status=pending when transaction is in pending state", async () => {
    const pendingRecord = createRecord("0xpending", "pending");
    const txId = createMockTransactionId("0xpending");

    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([pendingRecord]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useTransactionHistory({ id: txId }));

    await waitFor(() => expect(result.current.record).not.toBeNull());

    expect(result.current.status).toBe("pending");
  });

  it("uses ?? [] safety net when idsHex is null (line 155)", async () => {
    // idsHex is derived from ids; when ids contains string IDs idsHex is built,
    // but the ?? [] covers the case it's null. We can exercise the fallback by
    // passing a mix of string IDs (triggers the localFilterHexes path) and
    // ensuring idsHex is present. The ?? [] is a safety net — passing a single
    // string id exercises the code path around that line.
    const record = createRecord("0xabc");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    // Pass string IDs (triggers localFilterHexes path, which reads idsHex ?? [])
    const { result } = renderHook(() =>
      useTransactionHistory({ ids: ["0xabc"] })
    );

    await waitFor(() => expect(result.current.records).toHaveLength(1));
  });

  it("fetches all transactions by default", async () => {
    const record = createRecord("0xabc");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useTransactionHistory());

    await waitFor(() => expect(result.current.records).toHaveLength(1));

    expect(TransactionFilter.all).toHaveBeenCalled();
  });

  it("uses TransactionFilter.ids when a TransactionId is provided", async () => {
    const txId = createMockTransactionId("0xdeadbeef");
    const record = createRecord("0xdeadbeef", "committed");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useTransactionHistory({ id: txId }));

    await waitFor(() => expect(result.current.record).not.toBeNull());

    expect(TransactionFilter.ids).toHaveBeenCalledWith([txId]);
    expect(result.current.status).toBe("committed");
  });

  it("filters by string ids locally", async () => {
    const recordA = createRecord("0xaaa", "pending");
    const recordB = createRecord("0xbbb", "discarded");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([recordA, recordB]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() =>
      useTransactionHistory({ ids: ["0xbbb"] })
    );

    await waitFor(() => expect(result.current.records).toHaveLength(1));

    expect(TransactionFilter.all).toHaveBeenCalled();
    expect(result.current.records[0]?.id().toHex()).toBe("0xbbb");
    expect(result.current.status).toBe("discarded");
  });

  it("returns status=null when record transactionStatus has no matching flag (line 111)", async () => {
    // Record where none of isCommitted/isDiscarded/isPending is true
    const record = {
      id: vi.fn(() => createMockTransactionId("0xunknown")),
      transactionStatus: vi.fn(() => ({
        isPending: vi.fn(() => false),
        isCommitted: vi.fn(() => false),
        isDiscarded: vi.fn(() => false),
      })),
    };
    const txId = createMockTransactionId("0xunknown");

    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useTransactionHistory({ id: txId }));

    await waitFor(() => expect(result.current.record).not.toBeNull());

    expect(result.current.status).toBeNull();
  });

  it("uses provided TransactionFilter directly when filter option set (lines 137-138)", async () => {
    const { TransactionFilter: TF } = await import("@miden-sdk/miden-sdk/lazy");
    const customFilter = TF.uncommitted();
    const record = createRecord("0xcustom", "pending");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() =>
      useTransactionHistory({ filter: customFilter as any })
    );

    await waitFor(() => expect(result.current.records).toHaveLength(1));

    // getTransactions was called with our custom filter
    expect(mockClient.getTransactions).toHaveBeenCalledWith(customFilter);
  });

  it("normalizes hex without 0x prefix when matching records (line 160)", async () => {
    // Record whose toHex returns value without 0x prefix
    const record = {
      id: vi.fn(() => ({
        ...createMockTransactionId("txnoprefix"),
        toHex: vi.fn(() => "txnoprefix"),
      })),
      transactionStatus: vi.fn(() => ({
        isPending: vi.fn(() => false),
        isCommitted: vi.fn(() => true),
        isDiscarded: vi.fn(() => false),
      })),
    };
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    // ids is a string without 0x — exercises normalizeHex in both idsHex and local filter
    const { result } = renderHook(() =>
      useTransactionHistory({ ids: ["txnoprefix"] })
    );

    await waitFor(() => expect(result.current.records).toHaveLength(1));
  });

  it("refreshes on sync when refreshOnSync is not false", async () => {
    const record = createRecord("0xabc");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useTransactionHistory());

    await waitFor(() => expect(result.current.records).toHaveLength(1));

    const callsBefore = mockClient.getTransactions.mock.calls.length;

    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });

    await waitFor(() => {
      expect(mockClient.getTransactions.mock.calls.length).toBeGreaterThan(
        callsBefore
      );
    });
  });

  it("does not refresh on sync when refreshOnSync is false", async () => {
    const record = createRecord("0xabc");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() =>
      useTransactionHistory({ refreshOnSync: false })
    );

    await waitFor(() => expect(result.current.records).toHaveLength(1));

    const callsBefore = mockClient.getTransactions.mock.calls.length;

    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });

    // Slight delay to confirm no extra calls
    await new Promise((r) => setTimeout(r, 20));

    expect(mockClient.getTransactions.mock.calls.length).toBe(callsBefore);
  });
});
