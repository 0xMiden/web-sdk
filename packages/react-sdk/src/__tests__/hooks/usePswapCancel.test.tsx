import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePswapCancel } from "../../hooks/usePswapCancel";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockTransactionId,
  createMockTransactionRequest,
  createMockInputNoteRecord,
  createMockNote,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("usePswapCancel", () => {
  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancel());

      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
      expect(typeof result.current.pswapCancel).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("pswap cancel transaction", () => {
    it("should throw when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancel());

      await expect(
        result.current.pswapCancel({
          accountId: "0xaccount",
          note: "0xpswap_note",
        })
      ).rejects.toThrow("Miden client is not ready");
    });

    it("should cancel a PSWAP note and resolve a tx id", async () => {
      const mockTxId = createMockTransactionId("0xpswap_cancel_tx");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCancel());

      let txResult;
      await act(async () => {
        txResult = await result.current.pswapCancel({
          accountId: "0xaccount",
          note: "0xpswap_note",
        });
      });

      expect(txResult).toEqual({ transactionId: "0xpswap_cancel_tx" });
      expect(result.current.result).toEqual({
        transactionId: "0xpswap_cancel_tx",
      });
      expect(result.current.stage).toBe("complete");
      expect(mockSync).toHaveBeenCalled();
      expect(mockClient.getInputNote).toHaveBeenCalledWith("0xpswap_note");
      expect(noteRecord.toNote).toHaveBeenCalled();
      expect(mockClient.newPswapCancelTransactionRequest).toHaveBeenCalledWith(
        expect.anything()
      );
    });

    it("should throw a useful error when the note is not in the store", async () => {
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(null),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await expect(
          result.current.pswapCancel({
            accountId: "0x1",
            note: "0xmissing",
          })
        ).rejects.toThrow("Note not found: 0xmissing");
      });

      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
    });

    it("should use the remote prover when one is configured", async () => {
      const mockTxId = createMockTransactionId();
      const mockProver = { url: "https://prover.example" };
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const submitWithProver = vi.fn().mockResolvedValue(mockTxId);
      const submit = vi.fn().mockResolvedValue(mockTxId);
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: submit,
        submitNewTransactionWithProver: submitWithProver,
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
        prover: mockProver,
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await result.current.pswapCancel({
          accountId: "0x1",
          note: "0xpswap_note",
        });
      });

      expect(submitWithProver).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe("stage transitions", () => {
    it("should transition idle → executing → proving → complete", async () => {
      let resolveSubmit: () => void;
      const submitPromise = new Promise<
        ReturnType<typeof createMockTransactionId>
      >((resolve) => {
        resolveSubmit = () => resolve(createMockTransactionId());
      });

      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockReturnValue(submitPromise),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCancel());

      let cancelPromise: Promise<unknown>;
      act(() => {
        cancelPromise = result.current.pswapCancel({
          accountId: "0x1",
          note: "0xpswap_note",
        });
      });

      await waitFor(() => {
        expect(result.current.stage).toBe("proving");
      });

      await act(async () => {
        resolveSubmit!();
        await cancelPromise;
      });

      expect(result.current.stage).toBe("complete");
    });
  });

  describe("error handling", () => {
    it("should surface submit errors", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const submitError = new Error("Not the creator");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue(submitError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await expect(
          result.current.pswapCancel({
            accountId: "0x1",
            note: "0xpswap_note",
          })
        ).rejects.toThrow("Not the creator");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("Not the creator");
      });
      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
    });

    it("should wrap non-Error throws", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi.fn().mockImplementation(() => {
          throw "boom";
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await expect(
          result.current.pswapCancel({
            accountId: "0x1",
            note: "0xpswap_note",
          })
        ).rejects.toThrow("boom");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("boom");
      });
    });
  });

  describe("reset", () => {
    it("should clear all state", async () => {
      const mockTxId = createMockTransactionId();
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await result.current.pswapCancel({
          accountId: "0x1",
          note: "0xpswap_note",
        });
      });

      expect(result.current.result).not.toBeNull();

      act(() => {
        result.current.reset();
      });

      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
    });
  });

  describe("sync after cancel", () => {
    it("should trigger sync on success", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi
          .fn()
          .mockResolvedValue(createMockTransactionId()),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await result.current.pswapCancel({
          accountId: "0x1",
          note: "0xpswap_note",
        });
      });

      expect(mockSync).toHaveBeenCalledTimes(1);
    });

    it("should not trigger sync on failure", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue(new Error("Failed")),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await expect(
          result.current.pswapCancel({
            accountId: "0x1",
            note: "0xpswap_note",
          })
        ).rejects.toThrow();
      });

      expect(mockSync).not.toHaveBeenCalled();
    });
  });

  describe("note input polymorphism", () => {
    it("should accept an InputNoteRecord directly and skip the store lookup", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const getInputNote = vi.fn();
      const mockClient = createMockWebClient({
        getInputNote,
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi
          .fn()
          .mockResolvedValue(createMockTransactionId()),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await result.current.pswapCancel({
          accountId: "0x1",
          note: noteRecord,
        });
      });

      expect(getInputNote).not.toHaveBeenCalled();
      expect(noteRecord.toNote).toHaveBeenCalled();
    });

    it("should accept a Note directly and skip the store lookup", async () => {
      const note = createMockNote("0xpswap_note");
      const getInputNote = vi.fn();
      const mockClient = createMockWebClient({
        getInputNote,
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi
          .fn()
          .mockResolvedValue(createMockTransactionId()),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await result.current.pswapCancel({
          accountId: "0x1",
          note,
        });
      });

      expect(getInputNote).not.toHaveBeenCalled();
      expect(mockClient.newPswapCancelTransactionRequest).toHaveBeenCalledWith(
        note
      );
    });

    it("should accept a NoteId-like object and look up by its hex", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      // NoteId surface: toString() only, no .toNote() or .id(). `as never`
      // below sidesteps the structural NoteInput typing — the real WASM
      // NoteId class isn't constructible in this test environment.
      const noteIdLike = { toString: () => "0xpswap_note" };
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapCancelTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi
          .fn()
          .mockResolvedValue(createMockTransactionId()),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCancel());

      await act(async () => {
        await result.current.pswapCancel({
          accountId: "0x1",
          note: noteIdLike as never,
        });
      });

      expect(mockClient.getInputNote).toHaveBeenCalledWith("0xpswap_note");
      expect(noteRecord.toNote).toHaveBeenCalled();
    });
  });
});
