import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePswapCancelByOrder } from "../../hooks/usePswapCancelByOrder";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockTransactionId,
  createMockTransactionRequest,
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

describe("usePswapCancelByOrder", () => {
  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
      expect(typeof result.current.pswapCancelByOrder).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("pswap cancel-by-order transaction", () => {
    it("should throw when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await expect(
        result.current.pswapCancelByOrder({ orderId: "42" })
      ).rejects.toThrow("Miden client is not ready");
    });

    it("should resolve the creator from the lineage and submit a cancel", async () => {
      const mockTxId = createMockTransactionId("0xcancel_by_order_tx");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const lineage = createMockPswapLineageRecord("42");
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(lineage),
        buildPswapCancelByOrder: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      let txResult;
      await act(async () => {
        txResult = await result.current.pswapCancelByOrder({ orderId: 42n });
      });

      expect(txResult).toEqual({ transactionId: "0xcancel_by_order_tx" });
      expect(result.current.result).toEqual({
        transactionId: "0xcancel_by_order_tx",
      });
      expect(result.current.stage).toBe("complete");
      expect(mockSync).toHaveBeenCalled();
      expect(mockClient.getPswapLineage).toHaveBeenCalledWith("42");
      expect(lineage.creatorAccountId).toHaveBeenCalled();
      expect(mockClient.buildPswapCancelByOrder).toHaveBeenCalledWith("42");
      expect(mockClient.submitNewTransaction).toHaveBeenCalledWith(
        expect.anything(), // creator account id
        expect.anything() // tx request
      );
    });

    it("should throw a useful error when the order is not tracked", async () => {
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(null),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await act(async () => {
        await expect(
          result.current.pswapCancelByOrder({ orderId: "99" })
        ).rejects.toThrow("No PSWAP lineage tracked for order 99");
      });

      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
    });

    it("should surface the terminal-state guard from build and never submit", async () => {
      // The FullyFilled/Reclaimed guard lives in the WASM
      // `buildPswapCancelByOrder` binding, which throws before returning a
      // request. The hook must propagate that error and never reach submit.
      const lineage = createMockPswapLineageRecord("42");
      const buildCancel = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Cannot cancel PSWAP order 42: lineage is FullyFilled; only Active lineages can be cancelled."
          )
        );
      const submit = vi.fn();
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(lineage),
        buildPswapCancelByOrder: buildCancel,
        submitNewTransaction: submit,
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await act(async () => {
        await expect(
          result.current.pswapCancelByOrder({ orderId: "42" })
        ).rejects.toThrow(/lineage is FullyFilled; only Active lineages/);
      });

      expect(submit).not.toHaveBeenCalled();
      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
    });

    it("should use the remote prover when one is configured", async () => {
      const mockTxId = createMockTransactionId();
      const mockProver = { url: "https://prover.example" };
      const lineage = createMockPswapLineageRecord("42");
      const submitWithProver = vi.fn().mockResolvedValue(mockTxId);
      const submit = vi.fn().mockResolvedValue(mockTxId);
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(lineage),
        buildPswapCancelByOrder: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: submit,
        submitNewTransactionWithProver: submitWithProver,
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
        prover: mockProver,
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await act(async () => {
        await result.current.pswapCancelByOrder({ orderId: "42" });
      });

      expect(submitWithProver).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe("stage transitions", () => {
    it("should transition idle → proving → complete", async () => {
      let resolveSubmit: () => void;
      const submitPromise = new Promise<
        ReturnType<typeof createMockTransactionId>
      >((resolve) => {
        resolveSubmit = () => resolve(createMockTransactionId());
      });

      const lineage = createMockPswapLineageRecord("42");
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(lineage),
        buildPswapCancelByOrder: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockReturnValue(submitPromise),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      let cancelPromise: Promise<unknown>;
      act(() => {
        cancelPromise = result.current.pswapCancelByOrder({ orderId: "42" });
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
      const lineage = createMockPswapLineageRecord("42");
      const submitError = new Error("Not the creator");
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(lineage),
        buildPswapCancelByOrder: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue(submitError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await act(async () => {
        await expect(
          result.current.pswapCancelByOrder({ orderId: "42" })
        ).rejects.toThrow("Not the creator");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("Not the creator");
      });
      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
    });

    it("should wrap non-Error throws", async () => {
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockImplementation(() => {
          throw "boom";
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await act(async () => {
        await expect(
          result.current.pswapCancelByOrder({ orderId: "42" })
        ).rejects.toThrow("boom");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("boom");
      });
    });
  });

  describe("reset", () => {
    it("should clear all state", async () => {
      const lineage = createMockPswapLineageRecord("42");
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(lineage),
        buildPswapCancelByOrder: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi
          .fn()
          .mockResolvedValue(createMockTransactionId()),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await act(async () => {
        await result.current.pswapCancelByOrder({ orderId: "42" });
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
      const lineage = createMockPswapLineageRecord("42");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(lineage),
        buildPswapCancelByOrder: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi
          .fn()
          .mockResolvedValue(createMockTransactionId()),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await act(async () => {
        await result.current.pswapCancelByOrder({ orderId: "42" });
      });

      expect(mockSync).toHaveBeenCalledTimes(1);
    });

    it("should not trigger sync on failure", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        getPswapLineage: vi.fn().mockResolvedValue(null),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => usePswapCancelByOrder());

      await act(async () => {
        await expect(
          result.current.pswapCancelByOrder({ orderId: "42" })
        ).rejects.toThrow();
      });

      expect(mockSync).not.toHaveBeenCalled();
    });
  });
});
