import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePswapLineages } from "../../hooks/usePswapLineages";
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

describe("usePswapLineages", () => {
  it("returns the empty initial state when the client is not ready", () => {
    mockUseMiden.mockReturnValue({ client: null, isReady: false });

    const { result } = renderHook(() => usePswapLineages());

    expect(result.current.lineages).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.refetch).toBe("function");
  });

  it("does not fetch while the client is not ready", async () => {
    const getPswapLineages = vi.fn().mockResolvedValue([]);
    mockUseMiden.mockReturnValue({
      client: createMockWebClient({ getPswapLineages }),
      isReady: false,
    });

    renderHook(() => usePswapLineages());

    await act(async () => {});
    expect(getPswapLineages).not.toHaveBeenCalled();
  });

  it("fetches every tracked lineage on mount", async () => {
    const record = createMockPswapLineageRecord("7");
    const mockClient = createMockWebClient({
      getPswapLineages: vi.fn().mockResolvedValue([record]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineages());

    await waitFor(() => expect(result.current.lineages).toHaveLength(1));
    expect(result.current.lineages[0]?.orderId()).toBe("7");
    expect(mockClient.getPswapLineages).toHaveBeenCalledTimes(1);
  });

  it("refreshes after a successful sync", async () => {
    const getPswapLineages = vi.fn().mockResolvedValue([]);
    const mockClient = createMockWebClient({ getPswapLineages });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    renderHook(() => usePswapLineages());

    await waitFor(() => expect(getPswapLineages).toHaveBeenCalledTimes(1));

    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });

    await waitFor(() => expect(getPswapLineages).toHaveBeenCalledTimes(2));
  });

  it("surfaces a thrown Error", async () => {
    const mockClient = createMockWebClient({
      getPswapLineages: vi.fn().mockRejectedValue(new Error("store offline")),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineages());

    await waitFor(() =>
      expect(result.current.error?.message).toBe("store offline")
    );
    expect(result.current.lineages).toEqual([]);
  });

  it("wraps a non-Error throw", async () => {
    const mockClient = createMockWebClient({
      getPswapLineages: vi.fn().mockRejectedValue("kaboom"),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineages());

    await waitFor(() => expect(result.current.error?.message).toBe("kaboom"));
  });

  it("refetches on demand", async () => {
    const getPswapLineages = vi.fn().mockResolvedValue([]);
    const mockClient = createMockWebClient({ getPswapLineages });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineages());

    await waitFor(() => expect(getPswapLineages).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refetch();
    });

    expect(getPswapLineages).toHaveBeenCalledTimes(2);
  });
});
