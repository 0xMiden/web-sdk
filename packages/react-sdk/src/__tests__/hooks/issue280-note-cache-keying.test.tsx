import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { NoteFilter } from "@miden-sdk/miden-sdk";
import { useNotes } from "../../hooks/useNotes";
import { useNoteStream } from "../../hooks/useNoteStream";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockInputNoteRecord,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({ useMiden: vi.fn() }));
const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

const COMMITTED = [createMockInputNoteRecord("0xcommitted1")];
const CONSUMED = [createMockInputNoteRecord("0xconsumed1")];
const ALL = [
  createMockInputNoteRecord("0xcommitted1"),
  createMockInputNoteRecord("0xconsumed1"),
];

function makeClient() {
  vi.mocked(NoteFilter).mockImplementation(
    (type: unknown) => ({ _type: type, free: vi.fn() }) as never
  );

  return createMockWebClient({
    getInputNotes: vi.fn(async (filter: { _type: number }) => {
      if (filter._type === 1) return CONSUMED;
      if (filter._type === 2) return COMMITTED;
      return ALL;
    }),
    getConsumableNotes: vi.fn().mockResolvedValue([]),
  });
}

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("issue 280: note cache keying per filter", () => {
  it("a second useNotes with a different status issues its own query and returns correct notes", async () => {
    const client = makeClient();
    mockUseMiden.mockReturnValue({ client, isReady: true });
    act(() => {
      useMidenStore.getState().setClient(client as never);
    });

    const a = renderHook(() => useNotes());
    await waitFor(() => expect(a.result.current.notes.length).toBe(2));

    const b = renderHook(() => useNotes({ status: "consumed" }));
    await waitFor(() => expect(b.result.current.notes.length).toBe(1));

    const requestedTypes = (
      client.getInputNotes as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]._type);

    expect(requestedTypes).toContain(1);
    expect(b.result.current.notes[0].id()!.toString()).toBe("0xconsumed1");
  });

  it("useNotes({status}) and useNoteStream() do not clobber each other's cache", async () => {
    const client = makeClient();
    mockUseMiden.mockReturnValue({ client, isReady: true });
    act(() => {
      useMidenStore.getState().setClient(client as never);
    });

    const stream = renderHook(() => useNoteStream({ status: "committed" }));
    const consumed = renderHook(() => useNotes({ status: "consumed" }));

    await waitFor(() => expect(stream.result.current.notes.length).toBe(1));
    await waitFor(() => expect(consumed.result.current.notes.length).toBe(1));

    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });

    await waitFor(() =>
      expect(
        (client.getInputNotes as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThanOrEqual(2)
    );

    expect(stream.result.current.notes[0].id).toBe("0xcommitted1");
    expect(consumed.result.current.notes[0].id()!.toString()).toBe(
      "0xconsumed1"
    );
  });
});
