import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTransactionHistory } from "../../hooks/useTransactionHistory";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { TransactionFilter } from "@miden-sdk/miden-sdk";
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
  it("ignores an old client's records after a reset and replacement read succeeds", async () => {
    const previousRecord = createRecord("0xaaa");
    const currentRecord = createRecord("0xbbb");
    let resolvePrevious!: (records: Array<typeof previousRecord>) => void;
    let resolveCurrent!: (records: Array<typeof currentRecord>) => void;
    const previousRead = new Promise<Array<typeof previousRecord>>(
      (resolve) => {
        resolvePrevious = resolve;
      }
    );
    const currentRead = new Promise<Array<typeof currentRecord>>((resolve) => {
      resolveCurrent = resolve;
    });
    const previousClient = createMockWebClient({
      getTransactions: vi.fn().mockReturnValue(previousRead),
    });
    const currentClient = createMockWebClient({
      getTransactions: vi.fn().mockReturnValue(currentRead),
    });
    useMidenStore.getState().setClient(previousClient as any);
    mockUseMiden.mockReturnValue({ client: previousClient, isReady: true });
    const { result, rerender } = renderHook(() => useTransactionHistory());
    expect(previousClient.getTransactions).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);

    act(() => {
      useMidenStore.getState().resetInMemoryState();
      useMidenStore.getState().setClient(currentClient as any);
      mockUseMiden.mockReturnValue({ client: currentClient, isReady: true });
      rerender();
    });
    expect(currentClient.getTransactions).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveCurrent([currentRecord]);
      await currentRead;
    });

    expect(result.current.records).toEqual([currentRecord]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      resolvePrevious([previousRecord]);
      await previousRead;
    });

    expect(result.current.records).toEqual([currentRecord]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("ignores an older same-client rejection after the latest read succeeds", async () => {
    const currentRecord = createRecord("0xbbb");
    let rejectPrevious!: (error: Error) => void;
    let resolveCurrent!: (records: Array<typeof currentRecord>) => void;
    const previousRead = new Promise<Array<typeof currentRecord>>(
      (_, reject) => {
        rejectPrevious = reject;
      }
    );
    const currentRead = new Promise<Array<typeof currentRecord>>((resolve) => {
      resolveCurrent = resolve;
    });
    const mockClient = createMockWebClient({
      getTransactions: vi
        .fn()
        .mockReturnValueOnce(previousRead)
        .mockReturnValueOnce(currentRead),
    });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
    const { result } = renderHook(() => useTransactionHistory());
    expect(mockClient.getTransactions).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refetch();
    });
    expect(mockClient.getTransactions).toHaveBeenCalledTimes(2);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveCurrent([currentRecord]);
      await currentRead;
    });

    expect(result.current.records).toEqual([currentRecord]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      rejectPrevious(new Error("Older transaction-history read failed"));
      await previousRead.catch(() => {});
    });

    expect(result.current.error).toBeNull();
    expect(result.current.records).toEqual([currentRecord]);
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps the latest records when an older same-client read resolves last", async () => {
    const previousRecord = createRecord("0xaaa");
    const currentRecord = createRecord("0xbbb");
    let resolvePrevious!: (records: Array<typeof previousRecord>) => void;
    let resolveCurrent!: (records: Array<typeof currentRecord>) => void;
    const previousRead = new Promise<Array<typeof previousRecord>>(
      (resolve) => {
        resolvePrevious = resolve;
      }
    );
    const currentRead = new Promise<Array<typeof currentRecord>>((resolve) => {
      resolveCurrent = resolve;
    });
    const mockClient = createMockWebClient({
      getTransactions: vi
        .fn()
        .mockReturnValueOnce(previousRead)
        .mockReturnValueOnce(currentRead),
    });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
    const { result } = renderHook(() => useTransactionHistory());
    expect(mockClient.getTransactions).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refetch();
    });
    expect(mockClient.getTransactions).toHaveBeenCalledTimes(2);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveCurrent([currentRecord]);
      await currentRead;
    });

    expect(result.current.records).toEqual([currentRecord]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      resolvePrevious([previousRecord]);
      await previousRead;
    });

    expect(result.current.records).toEqual([currentRecord]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("fetches all transactions by default", async () => {
    const record = createRecord("0xabc");
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });
    useMidenStore.getState().setClient(mockClient as any);

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
    useMidenStore.getState().setClient(mockClient as any);

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() =>
      useTransactionHistory({ id: txId as never })
    );

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
    useMidenStore.getState().setClient(mockClient as any);

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
});
