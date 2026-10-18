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
  describe.each(["replace", "reset", "reset and replace"] as const)(
    "%s before a retained refetch",
    (change) => {
      it("ignores a retained refetch after the current client's read lands", async () => {
        const previousRecord = createMockPswapLineageRecord("42");
        const currentRecord = createMockPswapLineageRecord("42");
        const previousClient = createMockWebClient({
          getPswapLineages: vi.fn().mockResolvedValue([previousRecord]),
        });
        const currentClient = createMockWebClient({
          getPswapLineages: vi.fn().mockResolvedValue([currentRecord]),
        });
        useMidenStore.getState().setClient(previousClient as any);
        mockUseMiden.mockReturnValue({ client: previousClient, isReady: true });
        const { result, rerender } = renderHook(() => usePswapLineages());

        await waitFor(() =>
          expect(result.current.lineages).toEqual([previousRecord])
        );
        const retainedRefetch = result.current.refetch;

        act(() => {
          if (change === "reset and replace") {
            useMidenStore.getState().resetInMemoryState();
          }
          useMidenStore.getState().setClient(currentClient as any);
          if (change === "reset") {
            useMidenStore.getState().resetInMemoryState();
          }
          mockUseMiden.mockReturnValue({
            client: currentClient,
            isReady: true,
          });
          rerender();
        });
        await waitFor(() =>
          expect(result.current.lineages).toEqual([currentRecord])
        );
        expect(result.current.isLoading).toBe(false);

        await act(async () => {
          await retainedRefetch();
        });

        expect(result.current.lineages).toEqual([currentRecord]);
        expect(result.current.error).toBeNull();
        expect(result.current.isLoading).toBe(false);
        expect(previousClient.getPswapLineages).toHaveBeenCalledTimes(1);
        expect(currentClient.getPswapLineages).toHaveBeenCalledTimes(1);
      });
    }
  );

  it("ignores a retained refetch while the current client's read is pending", async () => {
    const previousRecord = createMockPswapLineageRecord("42");
    const currentRecord = createMockPswapLineageRecord("42");
    let resolveCurrent!: (value: (typeof currentRecord)[]) => void;
    const currentRead = new Promise<(typeof currentRecord)[]>((resolve) => {
      resolveCurrent = resolve;
    });
    const previousClient = createMockWebClient({
      getPswapLineages: vi.fn().mockResolvedValue([previousRecord]),
    });
    const currentClient = createMockWebClient({
      getPswapLineages: vi.fn().mockReturnValue(currentRead),
    });
    useMidenStore.getState().setClient(previousClient as any);
    mockUseMiden.mockReturnValue({ client: previousClient, isReady: true });
    const { result, rerender } = renderHook(() => usePswapLineages());

    await waitFor(() =>
      expect(result.current.lineages).toEqual([previousRecord])
    );
    const retainedRefetch = result.current.refetch;

    act(() => {
      useMidenStore.getState().resetInMemoryState();
      useMidenStore.getState().setClient(currentClient as any);
      mockUseMiden.mockReturnValue({ client: currentClient, isReady: true });
      rerender();
    });
    expect(currentClient.getPswapLineages).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await retainedRefetch();
    });
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveCurrent([currentRecord]);
      await currentRead;
    });

    expect(result.current.lineages).toEqual([currentRecord]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(previousClient.getPswapLineages).toHaveBeenCalledTimes(1);
    expect(currentClient.getPswapLineages).toHaveBeenCalledTimes(1);
  });

  it("hides loaded lineages and errors on the first render after a cache reset", async () => {
    const record = createMockPswapLineageRecord("7");
    const readError = new Error("Lineages read failed");
    const mockClient = createMockWebClient({
      getPswapLineages: vi
        .fn()
        .mockResolvedValueOnce([record])
        .mockRejectedValueOnce(readError),
    });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
    const renders: ReturnType<typeof usePswapLineages>[] = [];
    const { result } = renderHook(() => {
      const lineages = usePswapLineages();
      renders.push(lineages);
      return lineages;
    });

    await waitFor(() => expect(result.current.lineages).toEqual([record]));

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.lineages).toEqual([record]);
    expect(result.current.error).toBe(readError);

    const firstResetRender = renders.length;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });

    expect(renders[firstResetRender]?.lineages).toEqual([]);
    expect(renders[firstResetRender]?.error).toBeNull();
    expect(result.current.lineages).toEqual([]);
    expect(result.current.error).toBeNull();
  });

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
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineages());

    await waitFor(() => expect(result.current.lineages).toHaveLength(1));
    expect(result.current.lineages[0]?.orderId()).toBe("7");
    expect(mockClient.getPswapLineages).toHaveBeenCalledTimes(1);
  });

  it("refreshes after a successful sync", async () => {
    const getPswapLineages = vi.fn().mockResolvedValue([]);
    const mockClient = createMockWebClient({ getPswapLineages });
    useMidenStore.getState().setClient(mockClient as any);
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
    useMidenStore.getState().setClient(mockClient as any);
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
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineages());

    await waitFor(() => expect(result.current.error?.message).toBe("kaboom"));
  });

  it("refetches on demand", async () => {
    const getPswapLineages = vi.fn().mockResolvedValue([]);
    const mockClient = createMockWebClient({ getPswapLineages });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineages());

    await waitFor(() => expect(getPswapLineages).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refetch();
    });

    expect(getPswapLineages).toHaveBeenCalledTimes(2);
  });
});
