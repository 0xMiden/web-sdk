import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePswapLineagesFor } from "../../hooks/usePswapLineagesFor";
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

describe("usePswapLineagesFor", () => {
  it("hides loaded lineages and errors on the first render after a cache reset", async () => {
    const record = createMockPswapLineageRecord("3");
    const readError = new Error("Account lineages read failed");
    const mockClient = createMockWebClient({
      getPswapLineagesFor: vi
        .fn()
        .mockResolvedValueOnce([record])
        .mockRejectedValueOnce(readError),
    });
    useMidenStore.getState().setClient(mockClient as any);
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
    const renders: ReturnType<typeof usePswapLineagesFor>[] = [];
    const { result } = renderHook(() => {
      const lineages = usePswapLineagesFor("0xcreator");
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

  it("returns the empty initial state", () => {
    mockUseMiden.mockReturnValue({ client: null, isReady: false });

    const { result } = renderHook(() => usePswapLineagesFor("0xaccount"));

    expect(result.current.lineages).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not fetch when no account is supplied", async () => {
    const getPswapLineagesFor = vi.fn().mockResolvedValue([]);
    mockUseMiden.mockReturnValue({
      client: createMockWebClient({ getPswapLineagesFor }),
      isReady: true,
    });

    renderHook(() => usePswapLineagesFor(null));

    await act(async () => {});
    expect(getPswapLineagesFor).not.toHaveBeenCalled();
  });

  it("fetches lineages for the given account", async () => {
    const record = createMockPswapLineageRecord("3");
    const mockClient = createMockWebClient({
      getPswapLineagesFor: vi.fn().mockResolvedValue([record]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineagesFor("0xcreator"));

    await waitFor(() => expect(result.current.lineages).toHaveLength(1));
    expect(mockClient.getPswapLineagesFor).toHaveBeenCalledTimes(1);
    expect(result.current.lineages[0]?.orderId()).toBe("3");
  });

  it("refreshes after a successful sync", async () => {
    const getPswapLineagesFor = vi.fn().mockResolvedValue([]);
    const mockClient = createMockWebClient({ getPswapLineagesFor });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    renderHook(() => usePswapLineagesFor("0xcreator"));

    await waitFor(() => expect(getPswapLineagesFor).toHaveBeenCalledTimes(1));

    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });

    await waitFor(() => expect(getPswapLineagesFor).toHaveBeenCalledTimes(2));
  });

  it("surfaces a thrown Error", async () => {
    const mockClient = createMockWebClient({
      getPswapLineagesFor: vi.fn().mockRejectedValue(new Error("bad account")),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineagesFor("0xcreator"));

    await waitFor(() =>
      expect(result.current.error?.message).toBe("bad account")
    );
  });

  it("wraps a non-Error throw", async () => {
    const mockClient = createMockWebClient({
      getPswapLineagesFor: vi.fn().mockRejectedValue("nope"),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineagesFor("0xcreator"));

    await waitFor(() => expect(result.current.error?.message).toBe("nope"));
  });

  it("refetches on demand", async () => {
    const getPswapLineagesFor = vi.fn().mockResolvedValue([]);
    const mockClient = createMockWebClient({ getPswapLineagesFor });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => usePswapLineagesFor("0xcreator"));

    await waitFor(() => expect(getPswapLineagesFor).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refetch();
    });

    expect(getPswapLineagesFor).toHaveBeenCalledTimes(2);
  });
});
