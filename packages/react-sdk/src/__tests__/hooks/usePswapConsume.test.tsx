import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePswapConsume } from "../../hooks/usePswapConsume";
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

describe("usePswapConsume", () => {
  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapConsume());

      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
      expect(typeof result.current.pswapConsume).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("pswap consume transaction", () => {
    it("should throw when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapConsume());

      await expect(
        result.current.pswapConsume({
          accountId: "0xaccount",
          note: "0xpswap_note",
          fillAmount: 25n,
        })
      ).rejects.toThrow("Miden client is not ready");
    });

    it("should fill a PSWAP note (defaults noteFillAmount to 0)", async () => {
      const mockTxId = createMockTransactionId("0xpswap_consume_tx");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapConsumeTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapConsume());

      let txResult;
      await act(async () => {
        txResult = await result.current.pswapConsume({
          accountId: "0xaccount",
          note: "0xpswap_note",
          fillAmount: 25n,
        });
      });

      expect(txResult).toEqual({ transactionId: "0xpswap_consume_tx" });
      expect(result.current.result).toEqual({
        transactionId: "0xpswap_consume_tx",
      });
      expect(result.current.stage).toBe("complete");
      expect(mockSync).toHaveBeenCalled();
      expect(mockClient.getInputNote).toHaveBeenCalledWith("0xpswap_note");
      expect(noteRecord.toNote).toHaveBeenCalled();
      expect(mockClient.newPswapConsumeTransactionRequest).toHaveBeenCalledWith(
        expect.anything(), // note
        expect.anything(), // accountId
        25n, // fillAmount
        0n // noteFillAmount default
      );
    });

    it("should pass through an explicit noteFillAmount", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapConsumeTransactionRequest: vi
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

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await result.current.pswapConsume({
          accountId: "0x1",
          note: "0xpswap_note",
          fillAmount: 30n,
          noteFillAmount: 5n,
        });
      });

      expect(mockClient.newPswapConsumeTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        30n,
        5n
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

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await expect(
          result.current.pswapConsume({
            accountId: "0x1",
            note: "0xmissing",
            fillAmount: 25n,
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
        newPswapConsumeTransactionRequest: vi
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

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await result.current.pswapConsume({
          accountId: "0x1",
          note: "0xpswap_note",
          fillAmount: 25n,
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
        newPswapConsumeTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockReturnValue(submitPromise),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapConsume());

      let consumePromise: Promise<unknown>;
      act(() => {
        consumePromise = result.current.pswapConsume({
          accountId: "0x1",
          note: "0xpswap_note",
          fillAmount: 25n,
        });
      });

      await waitFor(() => {
        expect(result.current.stage).toBe("proving");
      });

      await act(async () => {
        resolveSubmit!();
        await consumePromise;
      });

      expect(result.current.stage).toBe("complete");
    });
  });

  describe("error handling", () => {
    it("should surface submit errors and reset stage to idle", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const submitError = new Error("Fill exceeded requested amount");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapConsumeTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue(submitError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await expect(
          result.current.pswapConsume({
            accountId: "0x1",
            note: "0xpswap_note",
            fillAmount: 9999n,
          })
        ).rejects.toThrow("Fill exceeded requested amount");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe(
          "Fill exceeded requested amount"
        );
      });
      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
    });

    it("should wrap non-Error throws", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapConsumeTransactionRequest: vi.fn().mockImplementation(() => {
          throw "boom";
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await expect(
          result.current.pswapConsume({
            accountId: "0x1",
            note: "0xpswap_note",
            fillAmount: 25n,
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
        newPswapConsumeTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await result.current.pswapConsume({
          accountId: "0x1",
          note: "0xpswap_note",
          fillAmount: 25n,
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

  describe("sync after consume", () => {
    it("should trigger sync on success", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapConsumeTransactionRequest: vi
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

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await result.current.pswapConsume({
          accountId: "0x1",
          note: "0xpswap_note",
          fillAmount: 25n,
        });
      });

      expect(mockSync).toHaveBeenCalledTimes(1);
    });

    it("should not trigger sync on failure", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapConsumeTransactionRequest: vi
          .fn()
          .mockReturnValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue(new Error("Failed")),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await expect(
          result.current.pswapConsume({
            accountId: "0x1",
            note: "0xpswap_note",
            fillAmount: 25n,
          })
        ).rejects.toThrow();
      });

      expect(mockSync).not.toHaveBeenCalled();
    });
  });

  describe("bigint coercion", () => {
    it("should accept number for fillAmount and convert to bigint", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const mockClient = createMockWebClient({
        getInputNote: vi.fn().mockResolvedValue(noteRecord),
        newPswapConsumeTransactionRequest: vi
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

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await result.current.pswapConsume({
          accountId: "0x1",
          note: "0xpswap_note",
          fillAmount: 25,
        });
      });

      expect(mockClient.newPswapConsumeTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        25n,
        0n
      );
    });
  });

  describe("note input polymorphism", () => {
    it("should accept an InputNoteRecord directly and skip the store lookup", async () => {
      const noteRecord = createMockInputNoteRecord("0xpswap_note");
      const getInputNote = vi.fn();
      const mockClient = createMockWebClient({
        getInputNote,
        newPswapConsumeTransactionRequest: vi
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

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await result.current.pswapConsume({
          accountId: "0x1",
          note: noteRecord,
          fillAmount: 25n,
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
        newPswapConsumeTransactionRequest: vi
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

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await result.current.pswapConsume({
          accountId: "0x1",
          note,
          fillAmount: 25n,
        });
      });

      expect(getInputNote).not.toHaveBeenCalled();
      expect(mockClient.newPswapConsumeTransactionRequest).toHaveBeenCalledWith(
        note,
        expect.anything(),
        25n,
        0n
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
        newPswapConsumeTransactionRequest: vi
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

      const { result } = renderHook(() => usePswapConsume());

      await act(async () => {
        await result.current.pswapConsume({
          accountId: "0x1",
          note: noteIdLike as never,
          fillAmount: 25n,
        });
      });

      expect(mockClient.getInputNote).toHaveBeenCalledWith("0xpswap_note");
      expect(noteRecord.toNote).toHaveBeenCalled();
    });
  });
});
