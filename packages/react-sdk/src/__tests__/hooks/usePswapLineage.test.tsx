import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePswapLineage } from "../../hooks/usePswapLineage";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockPswapLineageRecord,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("usePswapLineage", () => {
  it("hides the loaded lineage and error on the first render after a cache reset", async () => {
    const record = createMockPswapLineageRecord("42");
    const readError = new Error("Lineage read failed");
    const mockClient = createMockWebClient({
      getPswapLineage: vi
        .fn()
        .mockResolvedValueOnce(record)
        .mockRejectedValueOnce(readError),
    });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
    const renders: ReturnType<typeof usePswapLineage>[] = [];
    const { result } = renderHook(() => {
      const lineage = usePswapLineage("42");
      renders.push(lineage);
      return lineage;
    });

    await waitFor(() => expect(result.current.lineage).toEqual(record));

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.lineage).toEqual(record);
    expect(result.current.error).toBe(readError);

    const firstResetRender = renders.length;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });

    expect(renders[firstResetRender]?.lineage).toBeNull();
    expect(renders[firstResetRender]?.error).toBeNull();
    expect(result.current.lineage).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("returns the empty initial state", () => {
    mockUseMiden.mockReturnValue({ client: null, isReady: false });

    const { result } = renderHook(() => usePswapLineage("42"));

    expect(result.current.lineage).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not fetch when no order id is supplied", async () => {
    const getPswapLineage = vi.fn().mockResolvedValue(null);
    mockUseMiden.mockReturnValue({
      client: createMockWebClient({ getPswapLineage }),
      isReady: true,
    });

    renderHook(() => usePswapLineage(null));

    await act(async () => {});
    expect(getPswapLineage).not.toHaveBeenCalled();
  });

  it("fetches a lineage by its order id and coerces bigint ids to strings", async () => {
    const record = createMockPswapLineageRecord("42");
    const mockClient = createMockWebClient({
      getPswapLineage: vi.fn().mockResolvedValue(record),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineage(42n));

    await waitFor(() => expect(result.current.lineage).not.toBeNull());
    expect(mockClient.getPswapLineage).toHaveBeenCalledWith("42");
    expect(result.current.lineage?.orderId()).toBe("42");
  });

  it("returns null when the order is not tracked", async () => {
    const mockClient = createMockWebClient({
      getPswapLineage: vi.fn().mockResolvedValue(undefined),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineage("99"));

    await waitFor(() => expect(mockClient.getPswapLineage).toHaveBeenCalled());
    expect(result.current.lineage).toBeNull();
  });

  it("refreshes after a successful sync", async () => {
    const getPswapLineage = vi.fn().mockResolvedValue(null);
    const mockClient = createMockWebClient({ getPswapLineage });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    renderHook(() => usePswapLineage("42"));

    await waitFor(() => expect(getPswapLineage).toHaveBeenCalledTimes(1));

    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });

    await waitFor(() => expect(getPswapLineage).toHaveBeenCalledTimes(2));
  });

  it("surfaces a thrown Error", async () => {
    const mockClient = createMockWebClient({
      getPswapLineage: vi.fn().mockRejectedValue(new Error("lookup failed")),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineage("42"));

    await waitFor(() =>
      expect(result.current.error?.message).toBe("lookup failed")
    );
  });

  it("wraps a non-Error throw", async () => {
    const mockClient = createMockWebClient({
      getPswapLineage: vi.fn().mockRejectedValue("explode"),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineage("42"));

    await waitFor(() => expect(result.current.error?.message).toBe("explode"));
  });

  it("refetches on demand", async () => {
    const getPswapLineage = vi.fn().mockResolvedValue(null);
    const mockClient = createMockWebClient({ getPswapLineage });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineage("42"));

    await waitFor(() => expect(getPswapLineage).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refetch();
    });

    expect(getPswapLineage).toHaveBeenCalledTimes(2);
  });
});
