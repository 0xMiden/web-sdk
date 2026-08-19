import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePreview } from "../../hooks/usePreview";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockChainAnchor,
  createMockTransactionRequest,
  createMockTransactionSummary,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("usePreview", () => {
  describe("initial state", () => {
    it("starts with no summary and no error", () => {
      mockUseMiden.mockReturnValue({ client: null, isReady: false });

      const { result } = renderHook(() => usePreview());

      expect(result.current.summary).toBeNull();
      expect(result.current.isPreviewing).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe("preview", () => {
    it("throws when the client is not ready", async () => {
      mockUseMiden.mockReturnValue({ client: null, isReady: false });

      const { result } = renderHook(() => usePreview());

      await act(async () => {
        await expect(
          result.current.preview({
            accountId: "0xaccount",
            request: createMockTransactionRequest(),
          })
        ).rejects.toThrow("Miden client is not ready");
      });
    });

    it("derives the summary at the sync height when no anchor is given", async () => {
      const summary = createMockTransactionSummary();
      const mockClient = createMockWebClient({
        executeForSummary: vi.fn().mockResolvedValue(summary),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => usePreview());

      const request = createMockTransactionRequest();
      let derived;
      await act(async () => {
        derived = await result.current.preview({
          accountId: "0xaccount",
          request,
        });
      });

      expect(mockClient.executeForSummary).toHaveBeenCalled();
      expect(mockClient.executeForSummaryAt).not.toHaveBeenCalled();
      expect(derived).toBe(summary);
      expect(result.current.summary).toBe(summary);
    });

    it("derives the summary at the anchor when one is given", async () => {
      const summary = createMockTransactionSummary("0xanchored");
      const mockClient = createMockWebClient({
        executeForSummaryAt: vi.fn().mockResolvedValue(summary),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => usePreview());

      const request = createMockTransactionRequest();
      const anchor = createMockChainAnchor(42);
      await act(async () => {
        await result.current.preview({
          accountId: "0xaccount",
          request,
          anchor,
        });
      });

      expect(mockClient.executeForSummaryAt).toHaveBeenCalledWith(
        expect.anything(),
        request,
        anchor
      );
      expect(mockClient.executeForSummary).not.toHaveBeenCalled();
      expect(result.current.summary).toBe(summary);
    });

    it("resolves the factory form of the request", async () => {
      const request = createMockTransactionRequest();
      const factory = vi.fn().mockResolvedValue(request);
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => usePreview());

      await act(async () => {
        await result.current.preview({
          accountId: "0xaccount",
          request: factory,
        });
      });

      expect(factory).toHaveBeenCalledWith(mockClient);
      expect(mockClient.executeForSummary).toHaveBeenCalledWith(
        expect.anything(),
        request
      );
    });

    it("routes through runExclusive when the provider supplies it", async () => {
      const runExclusive = vi.fn(<T,>(fn: () => Promise<T>) => fn());
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        runExclusive,
      });

      const { result } = renderHook(() => usePreview());

      await act(async () => {
        await result.current.preview({
          accountId: "0xaccount",
          request: createMockTransactionRequest(),
        });
      });

      expect(runExclusive).toHaveBeenCalled();
    });
  });

  describe("isPreviewing", () => {
    it("is true while the preview is in flight", async () => {
      let resolvePreview: () => void;
      const previewPromise = new Promise((resolve) => {
        resolvePreview = () => resolve(createMockTransactionSummary());
      });
      const mockClient = createMockWebClient({
        executeForSummary: vi.fn().mockReturnValue(previewPromise),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => usePreview());

      let pending: Promise<unknown>;
      act(() => {
        pending = result.current.preview({
          accountId: "0xaccount",
          request: createMockTransactionRequest(),
        });
      });

      await waitFor(() => {
        expect(result.current.isPreviewing).toBe(true);
      });

      await act(async () => {
        resolvePreview!();
        await pending;
      });

      expect(result.current.isPreviewing).toBe(false);
    });
  });

  describe("error handling", () => {
    it("surfaces the already-authorized rejection", async () => {
      const alreadyAuthorized = Object.assign(
        new Error("transaction is already fully authorized"),
        { code: "TRANSACTION_ALREADY_AUTHORIZED" }
      );
      const mockClient = createMockWebClient({
        executeForSummary: vi.fn().mockRejectedValue(alreadyAuthorized),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => usePreview());

      await act(async () => {
        await expect(
          result.current.preview({
            accountId: "0xaccount",
            request: createMockTransactionRequest(),
          })
        ).rejects.toThrow("transaction is already fully authorized");
      });

      await waitFor(() => {
        expect((result.current.error as { code?: string } | null)?.code).toBe(
          "TRANSACTION_ALREADY_AUTHORIZED"
        );
      });
    });

    it("wraps a non-Error rejection", async () => {
      const mockClient = createMockWebClient({
        executeForSummary: vi.fn().mockRejectedValue("preview-string-fail"),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => usePreview());

      await act(async () => {
        await expect(
          result.current.preview({
            accountId: "0xaccount",
            request: createMockTransactionRequest(),
          })
        ).rejects.toThrow("preview-string-fail");
      });

      await waitFor(() => {
        expect(result.current.error).toBeInstanceOf(Error);
        expect(result.current.error?.message).toBe("preview-string-fail");
      });
    });
  });

  describe("concurrency guard", () => {
    it("rejects a second preview while one is in flight", async () => {
      let resolvePreview: () => void;
      const previewPromise = new Promise((resolve) => {
        resolvePreview = () => resolve(createMockTransactionSummary());
      });
      const mockClient = createMockWebClient({
        executeForSummary: vi.fn().mockReturnValue(previewPromise),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => usePreview());

      let first: Promise<unknown>;
      act(() => {
        first = result.current.preview({
          accountId: "0xaccount",
          request: createMockTransactionRequest(),
        });
      });

      await act(async () => {
        await expect(
          result.current.preview({
            accountId: "0xaccount",
            request: createMockTransactionRequest(),
          })
        ).rejects.toThrow("A preview is already in progress");
      });

      await act(async () => {
        resolvePreview!();
        await first;
      });
    });
  });

  describe("reset", () => {
    it("clears the summary and error", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

      const { result } = renderHook(() => usePreview());

      await act(async () => {
        await result.current.preview({
          accountId: "0xaccount",
          request: createMockTransactionRequest(),
        });
      });
      expect(result.current.summary).not.toBeNull();

      act(() => {
        result.current.reset();
      });

      expect(result.current.summary).toBeNull();
      expect(result.current.isPreviewing).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });
});
