import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useChainAnchor } from "../../hooks/useChainAnchor";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockChainAnchor,
  createMockTransactionRequest,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useChainAnchor", () => {
  describe("initial state", () => {
    it("starts with no anchor and no error", () => {
      mockUseMiden.mockReturnValue({ client: null, isReady: false });

      const { result } = renderHook(() => useChainAnchor());

      expect(result.current.anchor).toBeNull();
      expect(result.current.isCapturing).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe("captureAnchor", () => {
    it("throws when the client is not ready", async () => {
      mockUseMiden.mockReturnValue({ client: null, isReady: false });

      const { result } = renderHook(() => useChainAnchor());

      await act(async () => {
        await expect(
          result.current.captureAnchor({
            request: createMockTransactionRequest(),
          })
        ).rejects.toThrow("Miden client is not ready");
      });
    });

    it("throws when a client exists but is still initializing", async () => {
      // The `!isReady` half of the guard: a real window during provider
      // startup that the client-is-null case does not reach.
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: false });

      const { result } = renderHook(() => useChainAnchor());

      await expect(
        result.current.captureAnchor({
          request: createMockTransactionRequest(),
        })
      ).rejects.toThrow("Miden client is not ready");
      expect(mockClient.chainAnchorForRequest).not.toHaveBeenCalled();
    });

    it("captures an anchor for the request and exposes it", async () => {
      const anchor = createMockChainAnchor(42);
      const mockClient = createMockWebClient({
        chainAnchorForRequest: vi.fn().mockResolvedValue(anchor),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => useChainAnchor());

      const request = createMockTransactionRequest();
      let captured;
      await act(async () => {
        captured = await result.current.captureAnchor({ request });
      });

      expect(mockClient.chainAnchorForRequest).toHaveBeenCalledWith(request);
      expect(captured).toBe(anchor);
      expect(result.current.anchor).toBe(anchor);
      expect(result.current.error).toBeNull();
    });

    it("resolves the factory form of the request before capturing", async () => {
      const request = createMockTransactionRequest();
      const factory = vi.fn().mockResolvedValue(request);
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => useChainAnchor());

      await act(async () => {
        await result.current.captureAnchor({ request: factory });
      });

      expect(factory).toHaveBeenCalledWith(mockClient);
      expect(mockClient.chainAnchorForRequest).toHaveBeenCalledWith(request);
    });

    it("routes through runExclusive when the provider supplies it", async () => {
      const runExclusive = vi.fn(<T,>(fn: () => Promise<T>) => fn());
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        runExclusive,
      });

      const { result } = renderHook(() => useChainAnchor());

      await act(async () => {
        await result.current.captureAnchor({
          request: createMockTransactionRequest(),
        });
      });

      expect(runExclusive).toHaveBeenCalled();
    });
  });

  describe("isCapturing", () => {
    it("is true while the capture is in flight", async () => {
      let resolveCapture: () => void;
      const capturePromise = new Promise((resolve) => {
        resolveCapture = () => resolve(createMockChainAnchor());
      });
      const mockClient = createMockWebClient({
        chainAnchorForRequest: vi.fn().mockReturnValue(capturePromise),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => useChainAnchor());

      let capture: Promise<unknown>;
      act(() => {
        capture = result.current.captureAnchor({
          request: createMockTransactionRequest(),
        });
      });

      await waitFor(() => {
        expect(result.current.isCapturing).toBe(true);
      });

      await act(async () => {
        resolveCapture!();
        await capture;
      });

      expect(result.current.isCapturing).toBe(false);
    });
  });

  describe("error handling", () => {
    it("stores and rethrows a failed capture", async () => {
      const mockClient = createMockWebClient({
        chainAnchorForRequest: vi
          .fn()
          .mockRejectedValue(new Error("block header not found")),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => useChainAnchor());

      await act(async () => {
        await expect(
          result.current.captureAnchor({
            request: createMockTransactionRequest(),
          })
        ).rejects.toThrow("block header not found");
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("block header not found");
      });
      expect(result.current.anchor).toBeNull();
    });

    it("wraps a non-Error rejection", async () => {
      const mockClient = createMockWebClient({
        chainAnchorForRequest: vi.fn().mockRejectedValue("anchor-string-fail"),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => useChainAnchor());

      await act(async () => {
        await expect(
          result.current.captureAnchor({
            request: createMockTransactionRequest(),
          })
        ).rejects.toThrow("anchor-string-fail");
      });

      await waitFor(() => {
        expect(result.current.error).toBeInstanceOf(Error);
        expect(result.current.error?.message).toBe("anchor-string-fail");
      });
    });
  });

  describe("concurrency guard", () => {
    it("rejects a second capture while one is in flight", async () => {
      let resolveCapture: () => void;
      const capturePromise = new Promise((resolve) => {
        resolveCapture = () => resolve(createMockChainAnchor());
      });
      const mockClient = createMockWebClient({
        chainAnchorForRequest: vi.fn().mockReturnValue(capturePromise),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => useChainAnchor());

      let first: Promise<unknown>;
      act(() => {
        first = result.current.captureAnchor({
          request: createMockTransactionRequest(),
        });
      });

      await act(async () => {
        await expect(
          result.current.captureAnchor({
            request: createMockTransactionRequest(),
          })
        ).rejects.toMatchObject({
          code: "OPERATION_BUSY",
          message: expect.stringContaining("already in progress"),
        });
      });

      await act(async () => {
        resolveCapture!();
        await first;
      });
    });
  });

  describe("client swap", () => {
    it("drops the captured anchor when the client changes", async () => {
      const firstClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: firstClient, isReady: true });

      const { result, rerender } = renderHook(() => useChainAnchor());

      await act(async () => {
        await result.current.captureAnchor({
          request: createMockTransactionRequest(),
        });
      });
      expect(result.current.anchor).not.toBeNull();

      // An anchor from the previous chain must not survive the swap.
      mockUseMiden.mockReturnValue({
        client: createMockWebClient(),
        isReady: true,
      });
      rerender();

      expect(result.current.anchor).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it("rejects a capture that lands after the client changed", async () => {
      let release: (value: unknown) => void = () => {};
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const firstClient = createMockWebClient();
      firstClient.chainAnchorForRequest = vi.fn(async () => {
        await gate;
        return createMockChainAnchor();
      });
      mockUseMiden.mockReturnValue({ client: firstClient, isReady: true });

      const { result, rerender } = renderHook(() => useChainAnchor());

      let captured: Promise<unknown> = Promise.resolve();
      act(() => {
        captured = result.current.captureAnchor({
          request: createMockTransactionRequest(),
        });
      });

      // Swap the client while the capture is still in flight.
      mockUseMiden.mockReturnValue({
        client: createMockWebClient(),
        isReady: true,
      });
      rerender();

      await act(async () => {
        release(undefined);
        await expect(captured).rejects.toMatchObject({
          code: "STALE_CLIENT",
        });
      });

      // The anchor belongs to the chain we left, so it must reach neither
      // state nor the caller — and it must not re-dirty the cleared error.
      expect(result.current.anchor).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it("keeps a failure from the abandoned client out of error state", async () => {
      let reject: (reason: unknown) => void = () => {};
      const gate = new Promise((_, rej) => {
        reject = rej;
      });
      const firstClient = createMockWebClient();
      firstClient.chainAnchorForRequest = vi.fn(() => gate);
      mockUseMiden.mockReturnValue({ client: firstClient, isReady: true });

      const { result, rerender } = renderHook(() => useChainAnchor());

      let captured: Promise<unknown> = Promise.resolve();
      act(() => {
        captured = result.current.captureAnchor({
          request: createMockTransactionRequest(),
        });
      });

      mockUseMiden.mockReturnValue({
        client: createMockWebClient(),
        isReady: true,
      });
      rerender();

      await act(async () => {
        reject(new Error("old chain fell over"));
        await expect(captured).rejects.toThrow("old chain fell over");
      });

      // The caller still sees it, but it must not surface as an error about
      // the chain the user has already moved to.
      expect(result.current.error).toBeNull();
    });
  });

  describe("reset", () => {
    it("clears the captured anchor and error", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => useChainAnchor());

      await act(async () => {
        await result.current.captureAnchor({
          request: createMockTransactionRequest(),
        });
      });
      expect(result.current.anchor).not.toBeNull();

      act(() => {
        result.current.reset();
      });

      expect(result.current.anchor).toBeNull();
      expect(result.current.isCapturing).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("leaves isCapturing set when the capture is still running", async () => {
      // reset() clears results; it does not cancel. Asserting this after a
      // settled capture would be vacuous, since `finally` already cleared it.
      let resolve: (value: unknown) => void = () => {};
      const gate = new Promise((res) => {
        resolve = res;
      });
      const mockClient = createMockWebClient({
        chainAnchorForRequest: vi.fn(() => gate),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => useChainAnchor());

      let pending: Promise<unknown> = Promise.resolve();
      act(() => {
        pending = result.current.captureAnchor({
          request: createMockTransactionRequest(),
        });
      });
      expect(result.current.isCapturing).toBe(true);

      act(() => {
        result.current.reset();
      });
      expect(result.current.isCapturing).toBe(true);

      await act(async () => {
        resolve(createMockChainAnchor());
        await pending;
      });
      expect(result.current.isCapturing).toBe(false);
    });
  });
});
