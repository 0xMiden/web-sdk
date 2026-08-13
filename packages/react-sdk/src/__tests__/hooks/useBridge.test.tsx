import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBridge } from "../../hooks/useBridge";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockTransactionId,
  createMockTransactionRequest,
} from "../mocks/miden-sdk";

// Mock useMiden
vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

const DEST_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const bridgeOptions = {
  from: "0xsender",
  bridgeAccount: "0xbridge",
  assetId: "0xfaucet",
  amount: 100n,
  destinationNetwork: 1,
  destinationAddress: DEST_ADDRESS,
};

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useBridge", () => {
  describe("initial state", () => {
    it("should return initial state", () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useBridge());

      expect(result.current.result).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.stage).toBe("idle");
      expect(result.current.error).toBeNull();
      expect(typeof result.current.bridge).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("bridge transaction", () => {
    it("should throw when client is not ready", async () => {
      mockUseMiden.mockReturnValue({
        client: null,
        isReady: false,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useBridge());

      await expect(result.current.bridge(bridgeOptions)).rejects.toThrow(
        "Miden client is not ready"
      );
    });

    it("should build and submit a bridge transaction", async () => {
      const mockTxId = createMockTransactionId("0xbridgetx");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useBridge());

      let txResult;
      await act(async () => {
        txResult = await result.current.bridge(bridgeOptions);
      });

      expect(txResult).toEqual({ transactionId: "0xbridgetx" });
      expect(result.current.result).toEqual({ transactionId: "0xbridgetx" });
      expect(result.current.stage).toBe("complete");
      expect(mockSync).toHaveBeenCalledTimes(1);

      // amount is normalized to bigint, destinationNetwork passed through, and a
      // (typed) EthAddress is passed as the final argument.
      expect(mockClient.newB2AggTransactionRequest).toHaveBeenCalledWith(
        expect.anything(), // sender
        expect.anything(), // bridge account
        expect.anything(), // asset / faucet id
        100n, // amount
        1, // destination network
        expect.anything() // EthAddress
      );
      expect(mockClient.submitNewTransaction).toHaveBeenCalled();
      expect(mockClient.submitNewTransactionWithProver).not.toHaveBeenCalled();
    });

    it("should route through the provided runExclusive when available", async () => {
      const runExclusive = vi.fn(async (fn: () => Promise<unknown>) => fn());
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
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
        runExclusive,
      });

      const { result } = renderHook(() => useBridge());

      await act(async () => {
        await result.current.bridge(bridgeOptions);
      });

      expect(runExclusive).toHaveBeenCalledTimes(1);
      expect(mockClient.newB2AggTransactionRequest).toHaveBeenCalled();
    });

    it("should accept a numeric amount", async () => {
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
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

      const { result } = renderHook(() => useBridge());

      await act(async () => {
        await result.current.bridge({ ...bridgeOptions, amount: 250 });
      });

      expect(mockClient.newB2AggTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        250n,
        1,
        expect.anything()
      );
    });

    it("should submit with a prover when one is configured", async () => {
      const mockTxId = createMockTransactionId("0xprovertx");
      const mockProver = { type: "remote" };
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransactionWithProver: vi.fn().mockResolvedValue(mockTxId),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
        prover: mockProver,
      });

      const { result } = renderHook(() => useBridge());

      let txResult;
      await act(async () => {
        txResult = await result.current.bridge(bridgeOptions);
      });

      expect(txResult).toEqual({ transactionId: "0xprovertx" });
      expect(mockClient.submitNewTransactionWithProver).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        mockProver
      );
      expect(mockClient.submitNewTransaction).not.toHaveBeenCalled();
    });

    it("should skip the post-bridge sync when skipSync is true", async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
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

      const { result } = renderHook(() => useBridge());

      await act(async () => {
        await result.current.bridge({ ...bridgeOptions, skipSync: true });
      });

      expect(mockSync).not.toHaveBeenCalled();
    });
  });

  describe("stage transitions", () => {
    it("should transition through proving to complete", async () => {
      let resolveSubmit: () => void;
      const submitPromise = new Promise<
        ReturnType<typeof createMockTransactionId>
      >((resolve) => {
        resolveSubmit = () => resolve(createMockTransactionId());
      });

      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockReturnValue(submitPromise),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useBridge());

      let bridgePromise: Promise<unknown>;
      act(() => {
        bridgePromise = result.current.bridge(bridgeOptions);
      });

      await waitFor(() => {
        expect(result.current.stage).toBe("proving");
      });

      await act(async () => {
        resolveSubmit!();
        await bridgePromise;
      });

      expect(result.current.stage).toBe("complete");
    });
  });

  describe("error handling", () => {
    it("should surface submission errors and not sync", async () => {
      const bridgeError = new Error("bridge failed");
      const mockSync = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue(bridgeError),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: mockSync,
      });

      const { result } = renderHook(() => useBridge());

      await act(async () => {
        await expect(result.current.bridge(bridgeOptions)).rejects.toThrow(
          "bridge failed"
        );
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("bridge failed");
      });
      expect(result.current.stage).toBe("idle");
      expect(result.current.isLoading).toBe(false);
      expect(mockSync).not.toHaveBeenCalled();
    });

    it("should surface request-building errors", async () => {
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi.fn().mockImplementation(() => {
          throw new Error("invalid destination");
        }),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useBridge());

      await act(async () => {
        await expect(result.current.bridge(bridgeOptions)).rejects.toThrow(
          "invalid destination"
        );
      });
    });

    it("should wrap non-Error throwables", async () => {
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
          .fn()
          .mockResolvedValue(createMockTransactionRequest()),
        submitNewTransaction: vi.fn().mockRejectedValue("string failure"),
      });

      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        sync: vi.fn(),
      });

      const { result } = renderHook(() => useBridge());

      await act(async () => {
        await expect(result.current.bridge(bridgeOptions)).rejects.toThrow(
          "string failure"
        );
      });

      await waitFor(() => {
        expect(result.current.error?.message).toBe("string failure");
      });
    });
  });

  describe("reset", () => {
    it("should reset all state", async () => {
      const mockClient = createMockWebClient({
        newB2AggTransactionRequest: vi
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

      const { result } = renderHook(() => useBridge());

      await act(async () => {
        await result.current.bridge(bridgeOptions);
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
});
