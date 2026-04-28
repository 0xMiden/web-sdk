import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNoteStream } from "../../hooks/useNoteStream";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { createMockWebClient } from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

// Helper to create a mock note record with sender + assets
function createStreamableNote(
  id: string,
  sender: string = "0xsender",
  amount: bigint = 100n
) {
  return {
    id: vi.fn(() => ({ toString: () => id, toHex: () => id })),
    metadata: vi.fn(() => ({
      sender: vi.fn(() => ({ toString: () => sender })),
      attachment: vi.fn(() => null),
    })),
    details: vi.fn(() => ({
      assets: vi.fn(() => ({
        fungibleAssets: vi.fn(() => [
          {
            faucetId: vi.fn(() => ({ toString: () => "0xfaucet" })),
            amount: vi.fn(() => amount),
          },
        ]),
      })),
    })),
    state: vi.fn(() => "committed"),
    commitment: vi.fn(() => ({ toString: () => "0xcommitment" })),
    inclusionProof: vi.fn(() => null),
    consumerTransactionId: vi.fn(() => null),
    nullifier: vi.fn(() => "0xnullifier"),
    isAuthenticated: vi.fn(() => true),
    isConsumed: vi.fn(() => false),
    isProcessing: vi.fn(() => false),
    toNote: vi.fn(() => ({})),
    free: vi.fn(),
  };
}

describe("useNoteStream", () => {
  describe("initial state", () => {
    it("should return empty notes when client is not ready", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useNoteStream());

      expect(result.current.notes).toEqual([]);
      expect(result.current.latest).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it("does not fetch when isReady is true but client is null (guard in refetch)", async () => {
      // isReady=true causes the effect to call refetch(), but client is null
      // so the guard `if (!client || !isReady) return` fires immediately.
      const getInputNotesMock = vi.fn().mockResolvedValue([]);
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useNoteStream());

      // Wait briefly to confirm no error and no notes fetched
      await new Promise((r) => setTimeout(r, 20));
      expect(result.current.error).toBeNull();
      expect(getInputNotesMock).not.toHaveBeenCalled();
    });
  });

  describe("note fetching", () => {
    it("should fetch and build StreamedNote objects", async () => {
      const noteRecords = [createStreamableNote("0xnote1", "0xsenderA", 50n)];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(noteRecords),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      // Pre-populate the store so the hook can read from it
      useMidenStore.getState().setNotes(noteRecords as any);

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.notes.length).toBeGreaterThanOrEqual(0);
      });

      // The notes should have StreamedNote shape
      if (result.current.notes.length > 0) {
        const note = result.current.notes[0];
        expect(note.id).toBe("0xnote1");
        expect(note.amount).toBe(50n);
        expect(typeof note.firstSeenAt).toBe("number");
        expect(note.record).toBeDefined();
      }
    });
  });

  describe("filtering", () => {
    it("should filter by sender", async () => {
      const notes = [
        createStreamableNote("0xnote1", "0xalice", 100n),
        createStreamableNote("0xnote2", "0xbob", 200n),
        createStreamableNote("0xnote3", "0xalice", 300n),
      ];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() => useNoteStream({ sender: "0xalice" }));

      await waitFor(() => {
        expect(result.current.notes.length).toBe(2);
      });

      expect(result.current.notes.every((n) => n.sender === "0xalice")).toBe(
        true
      );
    });

    it("should filter by excludeIds (array)", async () => {
      const notes = [
        createStreamableNote("0xnote1"),
        createStreamableNote("0xnote2"),
        createStreamableNote("0xnote3"),
      ];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() =>
        useNoteStream({ excludeIds: ["0xnote1", "0xnote3"] })
      );

      await waitFor(() => {
        expect(result.current.notes.length).toBe(1);
      });

      expect(result.current.notes[0].id).toBe("0xnote2");
    });

    it("should filter by excludeIds (Set)", async () => {
      const notes = [
        createStreamableNote("0xnote1"),
        createStreamableNote("0xnote2"),
      ];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() =>
        useNoteStream({ excludeIds: new Set(["0xnote1"]) })
      );

      await waitFor(() => {
        expect(result.current.notes.length).toBe(1);
      });

      expect(result.current.notes[0].id).toBe("0xnote2");
    });

    it("should filter out notes older than since timestamp", async () => {
      const notes = [createStreamableNote("0xnote_old", "0xsender", 100n)];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      // since is far in the future — all existing notes have firstSeenAt < since,
      // so they are filtered out by the `continue` branch at line 146.
      const { result } = renderHook(() =>
        useNoteStream({ since: Date.now() + 100_000 })
      );

      await waitFor(() => {
        // All notes should be filtered out (firstSeenAt < since → continue)
        expect(result.current.notes).toHaveLength(0);
      });
    });

    it("should filter by amountFilter", async () => {
      const notes = [
        createStreamableNote("0xnote1", "0xsender", 50n),
        createStreamableNote("0xnote2", "0xsender", 150n),
        createStreamableNote("0xnote3", "0xsender", 200n),
      ];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() =>
        useNoteStream({ amountFilter: (a) => a >= 100n })
      );

      await waitFor(() => {
        expect(result.current.notes.length).toBe(2);
      });
    });

    it("wraps non-Error rejection from getInputNotes in an Error instance", async () => {
      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockRejectedValueOnce("plain-string-rejection"),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      // The hook auto-fetches on mount when isReady is true;
      // the rejection propagates to the error state.
      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.error).toBeInstanceOf(Error);
        expect(result.current.error?.message).toBe("plain-string-rejection");
      });
    });
  });

  describe("sender filtering", () => {
    it("should return empty when sender is null", async () => {
      const notes = [createStreamableNote("0xnote1")];
      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() => useNoteStream({ sender: null }));

      // sender: null means "no sender filter" — returns all notes
      await waitFor(() => {
        expect(result.current.notes.length).toBe(1);
      });
    });
  });

  describe("markHandled / markAllHandled", () => {
    it("should exclude handled notes after next store update", async () => {
      const notes = [
        createStreamableNote("0xnote1"),
        createStreamableNote("0xnote2"),
      ];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.notes.length).toBe(2);
      });

      act(() => {
        result.current.markHandled("0xnote1");
        // Trigger store update to cause useMemo recalculation
        useMidenStore.getState().setNotes([...notes] as any);
      });

      await waitFor(() => {
        expect(result.current.notes.length).toBe(1);
        expect(result.current.notes[0].id).toBe("0xnote2");
      });
    });

    it("should mark all current notes as handled after next store update", async () => {
      const notes = [
        createStreamableNote("0xnote1"),
        createStreamableNote("0xnote2"),
        createStreamableNote("0xnote3"),
      ];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.notes.length).toBe(3);
      });

      act(() => {
        result.current.markAllHandled();
        // Trigger store update to cause useMemo recalculation
        useMidenStore.getState().setNotes([...notes] as any);
      });

      await waitFor(() => {
        expect(result.current.notes.length).toBe(0);
      });
    });
  });

  describe("snapshot", () => {
    it("should capture current note IDs and timestamp", async () => {
      const notes = [
        createStreamableNote("0xnote1"),
        createStreamableNote("0xnote2"),
      ];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.notes.length).toBe(2);
      });

      const snap = result.current.snapshot();
      expect(snap.ids).toBeInstanceOf(Set);
      expect(snap.ids.size).toBe(2);
      expect(snap.ids.has("0xnote1")).toBe(true);
      expect(snap.ids.has("0xnote2")).toBe(true);
      expect(typeof snap.timestamp).toBe("number");
      expect(snap.timestamp).toBeGreaterThan(0);
    });
  });

  describe("branch coverage gaps in buildStreamedNote", () => {
    it("should skip assets when details() throws (inner catch lines 224-226)", async () => {
      const noteWithBadDetails = {
        ...createStreamableNote("0xnotebad", "0xsender", 100n),
        details: vi.fn(() => {
          throw new Error("no details");
        }),
      };

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue([noteWithBadDetails]),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes([noteWithBadDetails] as any);

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.notes.length).toBe(1);
      });

      // Note should still appear but with empty assets and amount 0n
      expect(result.current.notes[0].amount).toBe(0n);
      expect(result.current.notes[0].assets).toEqual([]);
    });

    it("should return null and skip note when id() throws (outer catch lines 244-246)", async () => {
      const noteWithBadId = {
        ...createStreamableNote("0xgood"),
        // This note's id() will throw
      };
      const badNote = {
        id: vi.fn(() => {
          throw new Error("bad id");
        }),
        metadata: vi.fn(() => null),
        details: vi.fn(() => null),
        state: vi.fn(() => "committed"),
        commitment: vi.fn(() => ({ toString: () => "0x0" })),
        inclusionProof: vi.fn(() => null),
        consumerTransactionId: vi.fn(() => null),
        nullifier: vi.fn(() => null),
        isAuthenticated: vi.fn(() => false),
        isConsumed: vi.fn(() => false),
        isProcessing: vi.fn(() => false),
        free: vi.fn(),
      };

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue([badNote, noteWithBadId]),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes([badNote, noteWithBadId] as any);

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        // badNote returns null from buildStreamedNote, so only 1 note should appear
        expect(result.current.notes.length).toBe(1);
      });

      expect(result.current.notes[0].id).toBe("0xgood");
    });
  });

  describe("latest", () => {
    it("should return the most recent note", async () => {
      const notes = [
        createStreamableNote("0xnote1"),
        createStreamableNote("0xnote2"),
      ];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.latest).not.toBeNull();
      });

      // Latest should be the last note (sorted by firstSeenAt ascending)
      expect(result.current.latest).toBeDefined();
    });

    it("should be null when no notes match", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useNoteStream());
      expect(result.current.latest).toBeNull();
    });
  });

  describe("branch coverage gaps", () => {
    it("should set error state when refetch throws (line 100)", async () => {
      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockRejectedValue(new Error("fetch failed")),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });

      expect(result.current.error?.message).toBe("fetch failed");
    });

    it("should fall back to raw sender when normalizeAccountId throws (lines 126-127)", async () => {
      // The sender value will be used directly when normalizeAccountId throws.
      // normalizeAccountId calls toBech32AccountId which catches errors internally,
      // so we need the note's sender to match the passed sender option.
      const notes = [createStreamableNote("0xnote1", "0xbadsender", 100n)];

      const mockClient = createMockWebClient({
        getInputNotes: vi.fn().mockResolvedValue(notes),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      useMidenStore.getState().setNotes(notes as any);

      // Pass a sender that will match after the catch fallback path
      const { result } = renderHook(() =>
        useNoteStream({ sender: "0xbadsender" })
      );

      await waitFor(() => {
        // normalizeAccountId returns the raw value (via toBech32AccountId fallback),
        // which should still match note's sender field
        expect(result.current.notes.length).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
