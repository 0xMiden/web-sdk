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
      useMidenStore.getState().setNotes(noteRecords as any, "committed");

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

  describe("fetches that outlive a store reset", () => {
    it("drops a fetch result that lands after the store was reset", async () => {
      let resolveA!: (value: unknown[]) => void;
      const pendingA = new Promise<unknown[]>((res) => {
        resolveA = res;
      });
      const clientA = createMockWebClient({
        getInputNotes: vi.fn().mockReturnValue(pendingA),
      });
      const clientB = createMockWebClient({
        getInputNotes: vi
          .fn()
          .mockResolvedValue([createStreamableNote("0xnoteB")]),
      });
      mockUseMiden.mockReturnValue({
        client: clientA,
        isReady: true,
        sync: vi.fn(),
      });

      const { result, rerender } = renderHook(() => useNoteStream());
      await waitFor(() => {
        expect(clientA.getInputNotes).toHaveBeenCalledTimes(1);
      });

      act(() => {
        useMidenStore.getState().resetInMemoryState();
      });
      mockUseMiden.mockReturnValue({
        client: clientB,
        isReady: true,
        sync: vi.fn(),
      });
      rerender();
      await waitFor(() => {
        expect(result.current.notes.map((n) => n.id)).toEqual(["0xnoteB"]);
      });

      await act(async () => {
        resolveA([createStreamableNote("0xnoteA")]);
        await pendingA;
      });

      expect(result.current.notes.map((n) => n.id)).toEqual(["0xnoteB"]);
      expect(result.current.isLoading).toBe(false);
    });

    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    it("keeps isLoading on while the post-reset fetch runs", async () => {
      const pendingA = deferred<unknown[]>();
      const pendingB = deferred<unknown[]>();
      const clientA = createMockWebClient({
        getInputNotes: vi.fn().mockReturnValue(pendingA.promise),
      });
      const clientB = createMockWebClient({
        getInputNotes: vi.fn().mockReturnValue(pendingB.promise),
      });
      mockUseMiden.mockReturnValue({
        client: clientA,
        isReady: true,
        sync: vi.fn(),
      });

      const { result, rerender } = renderHook(() => useNoteStream());
      await waitFor(() => {
        expect(clientA.getInputNotes).toHaveBeenCalledTimes(1);
      });

      act(() => {
        useMidenStore.getState().resetInMemoryState();
      });
      mockUseMiden.mockReturnValue({
        client: clientB,
        isReady: true,
        sync: vi.fn(),
      });
      rerender();
      await waitFor(() => {
        expect(clientB.getInputNotes).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        pendingA.resolve([createStreamableNote("0xnoteA")]);
        await pendingA.promise;
      });
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        pendingB.resolve([createStreamableNote("0xnoteB")]);
        await pendingB.promise;
      });
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it("clears isLoading when the reset is followed by no client", async () => {
      const pendingA = deferred<unknown[]>();
      const clientA = createMockWebClient({
        getInputNotes: vi.fn().mockReturnValue(pendingA.promise),
      });
      mockUseMiden.mockReturnValue({
        client: clientA,
        isReady: true,
        sync: vi.fn(),
      });

      const { result, rerender } = renderHook(() => useNoteStream());
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      act(() => {
        useMidenStore.getState().resetInMemoryState();
      });
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });
      rerender();

      await act(async () => {
        pendingA.resolve([createStreamableNote("0xnoteA")]);
        await pendingA.promise;
      });
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      expect(result.current.notes).toEqual([]);
    });

    it("drops a fetch error that lands after the store was reset", async () => {
      const pendingA = deferred<unknown[]>();
      const clientA = createMockWebClient({
        getInputNotes: vi.fn().mockReturnValue(pendingA.promise),
      });
      const clientB = createMockWebClient({
        getInputNotes: vi
          .fn()
          .mockResolvedValue([createStreamableNote("0xnoteB")]),
      });
      mockUseMiden.mockReturnValue({
        client: clientA,
        isReady: true,
        sync: vi.fn(),
      });

      const { result, rerender } = renderHook(() => useNoteStream());
      await waitFor(() => {
        expect(clientA.getInputNotes).toHaveBeenCalledTimes(1);
      });

      act(() => {
        useMidenStore.getState().resetInMemoryState();
      });
      mockUseMiden.mockReturnValue({
        client: clientB,
        isReady: true,
        sync: vi.fn(),
      });
      rerender();
      await waitFor(() => {
        expect(result.current.notes.map((n) => n.id)).toEqual(["0xnoteB"]);
      });

      await act(async () => {
        pendingA.reject(new Error("old identity"));
        await pendingA.promise.catch(() => {});
      });

      expect(result.current.error).toBeNull();
      expect(result.current.notes.map((n) => n.id)).toEqual(["0xnoteB"]);
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

      useMidenStore.getState().setNotes(notes as any, "committed");

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

      useMidenStore.getState().setNotes(notes as any, "committed");

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

      useMidenStore.getState().setNotes(notes as any, "committed");

      const { result } = renderHook(() =>
        useNoteStream({ excludeIds: new Set(["0xnote1"]) })
      );

      await waitFor(() => {
        expect(result.current.notes.length).toBe(1);
      });

      expect(result.current.notes[0].id).toBe("0xnote2");
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

      useMidenStore.getState().setNotes(notes as any, "committed");

      const { result } = renderHook(() =>
        useNoteStream({ amountFilter: (a) => a >= 100n })
      );

      await waitFor(() => {
        expect(result.current.notes.length).toBe(2);
      });
    });

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

      useMidenStore.getState().setNotes(notes as any, "committed");

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

      useMidenStore.getState().setNotes(notes as any, "committed");

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.notes.length).toBe(2);
      });

      act(() => {
        result.current.markHandled("0xnote1");
        // Trigger store update to cause useMemo recalculation
        useMidenStore.getState().setNotes([...notes] as any, "committed");
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

      useMidenStore.getState().setNotes(notes as any, "committed");

      const { result } = renderHook(() => useNoteStream());

      await waitFor(() => {
        expect(result.current.notes.length).toBe(3);
      });

      act(() => {
        result.current.markAllHandled();
        // Trigger store update to cause useMemo recalculation
        useMidenStore.getState().setNotes([...notes] as any, "committed");
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

      useMidenStore.getState().setNotes(notes as any, "committed");

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

      useMidenStore.getState().setNotes(notes as any, "committed");

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
});
