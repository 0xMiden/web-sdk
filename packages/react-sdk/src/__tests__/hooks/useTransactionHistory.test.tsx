import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTransactionHistory } from "../../hooks/useTransactionHistory";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { TransactionFilter, TransactionId } from "@miden-sdk/miden-sdk";
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
  it("hides loaded records and errors on the first render after a cache reset", async () => {
    const record = createRecord("0xaaa");
    const readError = new Error("Transaction-history read failed");
    const mockClient = createMockWebClient({
      getTransactions: vi
        .fn()
        .mockResolvedValueOnce([record])
        .mockRejectedValueOnce(readError),
    });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
    const renders: ReturnType<typeof useTransactionHistory>[] = [];
    const { result } = renderHook(() => {
      const history = useTransactionHistory({ id: "0xaaa" });
      renders.push(history);
      return history;
    });

    await waitFor(() => expect(result.current.records).toEqual([record]));

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.records).toEqual([record]);
    expect(result.current.error).toBe(readError);

    const firstResetRender = renders.length;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });

    expect(renders[firstResetRender]?.records).toEqual([]);
    expect(renders[firstResetRender]?.record).toBeNull();
    expect(renders[firstResetRender]?.status).toBeNull();
    expect(renders[firstResetRender]?.error).toBeNull();
    expect(result.current.records).toEqual([]);
    expect(result.current.error).toBeNull();
  });

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

    expect(TransactionId.fromHex).toHaveBeenCalledWith("0xdeadbeef");
    expect(TransactionFilter.ids).toHaveBeenCalledTimes(1);
    expect(TransactionFilter.ids).not.toHaveBeenCalledWith([txId]);
    expect(result.current.status).toBe("committed");
  });

  it("refetches with a caller's TransactionId after a sync without reusing it", async () => {
    const txId = createMockTransactionId("0xdeadbeef");
    const mockClient = createMockWebClient({
      getTransactions: vi
        .fn()
        .mockResolvedValueOnce([createRecord("0xdeadbeef", "pending")])
        .mockResolvedValue([createRecord("0xdeadbeef", "committed")]),
    });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() =>
      useTransactionHistory({ id: txId as never })
    );
    await waitFor(() => expect(result.current.status).toBe("pending"));

    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });

    await waitFor(() => expect(result.current.status).toBe("committed"));
    expect(mockClient.getTransactions).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(txId.toHex()).toBe("0xdeadbeef");
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

  it("calls a filter factory for every fetch so no filter is reused", async () => {
    const getTransactions = vi.fn().mockResolvedValue([createRecord("0xabc")]);
    const mockClient = createMockWebClient({ getTransactions });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    // `getTransactions` takes its filter by value: each fetch needs its own.
    const filter = vi.fn(() => TransactionFilter.uncommitted());
    const options = { filter };

    const { result } = renderHook(() => useTransactionHistory(options));
    await waitFor(() => expect(getTransactions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });
    await waitFor(() => expect(getTransactions).toHaveBeenCalledTimes(2));

    expect(filter).toHaveBeenCalledTimes(2);
    const [first, second] = getTransactions.mock.calls.map((c) => c[0]);
    expect(first).not.toBe(second);
  });

  it("passes a TransactionFilter instance through unchanged", async () => {
    const getTransactions = vi.fn().mockResolvedValue([createRecord("0xabc")]);
    const mockClient = createMockWebClient({ getTransactions });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const instance = TransactionFilter.uncommitted();

    const { result } = renderHook(() =>
      useTransactionHistory({ filter: instance })
    );
    await waitFor(() => expect(result.current.records).toHaveLength(1));

    // The mocked filters are all `{}`, so assert identity, not equality.
    expect(getTransactions.mock.calls[0][0]).toBe(instance);
  });

  describe("when a sync stamp is already stored at mount", () => {
    // MidenProvider writes `lastSyncTime` before `setClient`, so the hook
    // becomes ready on a commit that already carries a stamp.
    const setup = (getTransactions: ReturnType<typeof vi.fn>) => {
      const mockClient = createMockWebClient({ getTransactions });
      useMidenStore.getState().setClient(mockClient as any);
      useMidenStore.getState().setSyncState({ lastSyncTime: 1 });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
    };

    const consumedOnce = () => {
      let consumed = false;
      return vi.fn(async (_filter: unknown) => {
        if (consumed) throw new Error("null pointer passed to rust");
        consumed = true;
        return [createRecord("0xabc")];
      });
    };

    it("fetches once so a TransactionFilter instance is not consumed twice", async () => {
      const getTransactions = consumedOnce();
      setup(getTransactions);
      const instance = TransactionFilter.uncommitted();

      const { result } = renderHook(() =>
        useTransactionHistory({ filter: instance })
      );
      await waitFor(() => expect(result.current.records).toHaveLength(1));

      expect(getTransactions).toHaveBeenCalledTimes(1);
      expect(getTransactions.mock.calls[0][0]).toBe(instance);
      expect(result.current.error).toBeNull();
    });

    it("fetches once under StrictMode's replayed effects", async () => {
      const getTransactions = consumedOnce();
      setup(getTransactions);
      const instance = TransactionFilter.uncommitted();

      const { result } = renderHook(
        () => useTransactionHistory({ filter: instance }),
        { wrapper: StrictMode }
      );
      await waitFor(() => expect(result.current.records).toHaveLength(1));

      expect(getTransactions).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBeNull();
    });

    it("refetches once for each later sync stamp", async () => {
      const getTransactions = vi
        .fn()
        .mockResolvedValue([createRecord("0xabc")]);
      setup(getTransactions);

      renderHook(() => useTransactionHistory());
      await waitFor(() => expect(getTransactions).toHaveBeenCalledTimes(1));

      act(() => {
        useMidenStore.getState().setSyncState({ lastSyncTime: 2 });
      });
      await waitFor(() => expect(getTransactions).toHaveBeenCalledTimes(2));
    });

    it("does not refetch on a later sync stamp when refreshOnSync is false", async () => {
      const getTransactions = vi
        .fn()
        .mockResolvedValue([createRecord("0xabc")]);
      setup(getTransactions);

      renderHook(() => useTransactionHistory({ refreshOnSync: false }));
      await waitFor(() => expect(getTransactions).toHaveBeenCalledTimes(1));

      act(() => {
        useMidenStore.getState().setSyncState({ lastSyncTime: 2 });
      });
      await act(async () => {});
      expect(getTransactions).toHaveBeenCalledTimes(1);
    });
  });
});
