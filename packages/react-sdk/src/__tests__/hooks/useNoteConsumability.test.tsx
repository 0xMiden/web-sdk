import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNoteConsumability } from "../../hooks/useNoteConsumability";
import { useNotes } from "../../hooks/useNotes";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockAccountHeader,
  createMockConsumableNoteRecord,
  createMockNoteConsumability as entry,
  MOCK_PSWAP_SCRIPT_ROOT,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

const mockNote = (id: string) =>
  ({ id: vi.fn(() => ({ toString: () => id })) }) as never;

const setup = (overrides: Parameters<typeof createMockWebClient>[0] = {}) => {
  const client = createMockWebClient(overrides);
  mockUseMiden.mockReturnValue({ client, isReady: true });
  useMidenStore.getState().setClient(client as never);
  return client;
};

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useNoteConsumability", () => {
  it("screens a note for every tracked account", async () => {
    const note = mockNote("0xnote");
    const client = setup({
      getNoteConsumability: vi.fn().mockResolvedValue([entry("0xa", true)]),
    });
    const { result } = renderHook(() => useNoteConsumability(note));
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "immediately" })
    );
    expect(client.getNoteConsumability).toHaveBeenCalledWith(note);
    expect(client.getNoteConsumabilityForAccount).not.toHaveBeenCalled();
    expect(result.current.consumability).toHaveLength(1);
  });

  it("screens for one account and reports its unlock height", async () => {
    const note = mockNote("0xnote");
    const client = setup({
      getNoteConsumabilityForAccount: vi
        .fn()
        .mockResolvedValue([entry("0xaccount123", false, 321)]),
    });
    const { result } = renderHook(() =>
      useNoteConsumability(note, { accountId: "0xaccount123" })
    );
    await waitFor(() =>
      expect(result.current.status).toEqual({
        kind: "afterBlock",
        blockHeight: 321,
      })
    );
    const [screened, accountId] =
      client.getNoteConsumabilityForAccount.mock.calls[0];
    expect(screened).toBe(note);
    expect(accountId.toString()).toBe("0xaccount123");
    expect(client.getNoteConsumability).not.toHaveBeenCalled();
  });

  it("screens nothing without a note", async () => {
    const client = setup();
    const { result } = renderHook(() => useNoteConsumability(null));
    await act(async () => {
      await result.current.refetch();
    });
    expect(client.getNoteConsumability).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("screens a note again after a sync", async () => {
    const client = setup({
      getNoteConsumability: vi
        .fn()
        .mockResolvedValueOnce([entry("0xa", false, 10)])
        .mockResolvedValue([entry("0xa", true)]),
    });
    const { result } = renderHook(() =>
      useNoteConsumability(mockNote("0xnote"))
    );
    await waitFor(() =>
      expect(result.current.status).toEqual({
        kind: "afterBlock",
        blockHeight: 10,
      })
    );
    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "immediately" })
    );
    expect(client.getNoteConsumability).toHaveBeenCalledTimes(2);
  });

  it("does not screen again for a new object of the same note", async () => {
    const client = setup({
      getNoteConsumability: vi.fn().mockResolvedValue([entry("0xa", true)]),
    });
    const { result, rerender } = renderHook(
      ({ note }) => useNoteConsumability(note),
      { initialProps: { note: mockNote("0xnote") } }
    );
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "immediately" })
    );
    rerender({ note: mockNote("0xnote") });
    expect(client.getNoteConsumability).toHaveBeenCalledTimes(1);
  });

  it("drops the previous note's status when the note changes", async () => {
    let finish!: (value: unknown[]) => void;
    setup({
      getAccounts: vi.fn().mockResolvedValue([createMockAccountHeader()]),
      getNoteConsumability: vi
        .fn()
        .mockResolvedValueOnce([entry("0xa", true)])
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finish = resolve;
          })
        ),
    });
    const { result, rerender } = renderHook(
      ({ note }) => useNoteConsumability(note),
      { initialProps: { note: mockNote("0xfirst") } }
    );
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "immediately" })
    );
    rerender({ note: mockNote("0xsecond") });
    expect(result.current.status).toBeNull();
    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      finish([]);
    });
    expect(result.current.status).toEqual({ kind: "never" });
    expect(result.current.isLoading).toBe(false);
  });

  it("accepts an AccountId object", async () => {
    const client = setup({
      getNoteConsumabilityForAccount: vi
        .fn()
        .mockResolvedValue([entry("0xaccount123", true)]),
    });
    const accountId = { toString: () => "0xaccount123" } as never;
    const { result } = renderHook(() =>
      useNoteConsumability(mockNote("0xnote"), { accountId })
    );
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "immediately" })
    );
    expect(
      client.getNoteConsumabilityForAccount.mock.calls[0][1].toString()
    ).toBe("0xaccount123");
  });

  it("ignores a screen that settles after the note changed", async () => {
    let finishFirst!: (value: unknown[]) => void;
    setup({
      getAccounts: vi.fn().mockResolvedValue([createMockAccountHeader()]),
      getNoteConsumability: vi
        .fn()
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishFirst = resolve;
          })
        )
        .mockResolvedValue([]),
    });
    const { result, rerender } = renderHook(
      ({ note }) => useNoteConsumability(note),
      { initialProps: { note: mockNote("0xfirst") } }
    );
    rerender({ note: mockNote("0xsecond") });
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "never" })
    );
    await act(async () => {
      finishFirst([entry("0xa", true)]);
    });
    expect(result.current.status).toEqual({ kind: "never" });
    expect(result.current.isLoading).toBe(false);
  });

  it("leaves an unfiltered empty screen unscreened when no account is tracked", async () => {
    const client = setup({
      getNoteConsumability: vi.fn().mockResolvedValue([]),
    });
    const { result } = renderHook(() =>
      useNoteConsumability(mockNote("0xnote"))
    );
    await waitFor(() => expect(client.getAccounts).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status).toBeNull();
    expect(result.current.consumability).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("reads an unfiltered empty screen as never when an account is tracked", async () => {
    setup({
      getNoteConsumability: vi.fn().mockResolvedValue([]),
      getAccounts: vi.fn().mockResolvedValue([createMockAccountHeader()]),
    });
    const { result } = renderHook(() =>
      useNoteConsumability(mockNote("0xnote"))
    );
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "never" })
    );
    expect(result.current.consumability).toEqual([]);
  });

  it("reads a filtered empty screen as never without listing accounts", async () => {
    const client = setup({
      getNoteConsumabilityForAccount: vi.fn().mockResolvedValue([]),
    });
    const { result } = renderHook(() =>
      useNoteConsumability(mockNote("0xnote"), { accountId: "0xaccount123" })
    );
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "never" })
    );
    expect(client.getAccounts).not.toHaveBeenCalled();
  });

  it("clears a stored screen when a later unfiltered screen is empty and no account is tracked", async () => {
    setup({
      getNoteConsumability: vi
        .fn()
        .mockResolvedValueOnce([entry("0xa", true)])
        .mockResolvedValue([]),
    });
    const { result } = renderHook(() =>
      useNoteConsumability(mockNote("0xnote"))
    );
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "immediately" })
    );
    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });
    await waitFor(() => expect(result.current.status).toBeNull());
    expect(result.current.consumability).toBeNull();
  });

  it("drops a stored screen when the client that produced it is replaced", async () => {
    setup({
      getNoteConsumability: vi.fn().mockResolvedValue([entry("0xa", true)]),
    });
    const note = mockNote("0xnote");
    const { result, rerender } = renderHook(() => useNoteConsumability(note));
    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "immediately" })
    );
    let finish!: (value: unknown[]) => void;
    const next = createMockWebClient({
      getNoteConsumability: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      ),
    });
    mockUseMiden.mockReturnValue({ client: next, isReady: true });
    act(() => {
      useMidenStore.getState().setClient(next as never);
    });
    rerender();
    expect(result.current.status).toBeNull();
    expect(result.current.consumability).toBeNull();
    await act(async () => {
      finish([entry("0xa", false, 50)]);
    });
    expect(result.current.status).toEqual({
      kind: "afterBlock",
      blockHeight: 50,
    });
    mockUseMiden.mockReturnValue({ client: null, isReady: false });
    act(() => {
      useMidenStore.getState().setClient(null);
    });
    rerender();
    expect(result.current.status).toBeNull();
    expect(result.current.consumability).toBeNull();
  });

  it("wraps a non-Error rejection", async () => {
    setup({ getNoteConsumability: vi.fn().mockRejectedValue("nope") });
    const { result } = renderHook(() =>
      useNoteConsumability(mockNote("0xnote"))
    );
    await waitFor(() => expect(result.current.error?.message).toBe("nope"));
  });

  it("reports a screening error", async () => {
    setup({
      getNoteConsumability: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const { result } = renderHook(() =>
      useNoteConsumability(mockNote("0xnote"))
    );
    await waitFor(() => expect(result.current.error?.message).toBe("boom"));
    expect(result.current.status).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("leaves the notes offered for automatic consumption unchanged", async () => {
    // The hook presents what the screener reports; useNotes().consumableNotes,
    // the set to claim, still holds only payments consumable now.
    const locked = createMockConsumableNoteRecord(
      "0xlocked",
      "0xaccount123",
      false
    );
    const order = createMockConsumableNoteRecord(
      "0xorder",
      "0xaccount123",
      true,
      MOCK_PSWAP_SCRIPT_ROOT
    );
    const ready = createMockConsumableNoteRecord("0xready", "0xaccount123");
    setup({
      getInputNotes: vi.fn().mockResolvedValue([]),
      getConsumableNotes: vi.fn().mockResolvedValue([ready, locked, order]),
      getNoteConsumabilityForAccount: vi.fn(
        async (note: { id: () => unknown }) =>
          String(note.id()) === "0xlocked"
            ? [entry("0xaccount123", false, 12345)]
            : [entry("0xaccount123", true)]
      ),
    });
    const { result } = renderHook(() => ({
      notes: useNotes({ accountId: "0xaccount123" }),
      locked: useNoteConsumability(mockNote("0xlocked"), {
        accountId: "0xaccount123",
      }),
      order: useNoteConsumability(mockNote("0xorder"), {
        accountId: "0xaccount123",
      }),
    }));
    await waitFor(() => {
      expect(result.current.locked.status).toEqual({
        kind: "afterBlock",
        blockHeight: 12345,
      });
      expect(result.current.order.status).toEqual({ kind: "immediately" });
      expect(result.current.notes.consumableNotes).toHaveLength(1);
    });
    expect(
      result.current.notes.consumableNotes.map((n) =>
        n.inputNoteRecord().id()?.toString()
      )
    ).toEqual(["0xready"]);
  });
});
