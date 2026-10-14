import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBurnNonFungible } from "../../hooks/useBurnNonFungible";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockTransactionId,
  createMockNonFungibleAsset,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useBurnNonFungible", () => {
  it("should return initial state", () => {
    mockUseMiden.mockReturnValue({ client: null, isReady: false });

    const { result } = renderHook(() => useBurnNonFungible());

    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.stage).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("should throw when the client is not ready", async () => {
    mockUseMiden.mockReturnValue({ client: null, isReady: false });

    const { result } = renderHook(() => useBurnNonFungible());

    await expect(
      result.current.burnNonFungible({
        accountId: "0xholder",
        nonFungibleAsset: createMockNonFungibleAsset() as never,
      })
    ).rejects.toThrow("Miden client is not ready");
  });

  it("should submit a burn request from the holding account and sync", async () => {
    const mockSync = vi.fn().mockResolvedValue(undefined);
    const mockClient = createMockWebClient({
      submitNewTransaction: vi
        .fn()
        .mockResolvedValue(createMockTransactionId("0xburn")),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: mockSync,
    });
    const asset = createMockNonFungibleAsset();

    const { result } = renderHook(() => useBurnNonFungible());

    let txResult;
    await act(async () => {
      txResult = await result.current.burnNonFungible({
        accountId: "0xholder",
        nonFungibleAsset: asset as never,
      });
    });

    expect(txResult).toEqual({ transactionId: "0xburn" });
    expect(result.current.result).toEqual({ transactionId: "0xburn" });
    expect(result.current.stage).toBe("complete");
    const [holder, burnAsset] =
      mockClient.newBurnNonFungibleAssetTransactionRequest.mock.calls[0];
    expect((holder as { toString(): string }).toString()).toBe("0xholder");
    expect(burnAsset).toBe(asset);
    const [submitter] = mockClient.submitNewTransaction.mock.calls[0];
    expect((submitter as { toString(): string }).toString()).toBe("0xholder");
    expect(mockSync).toHaveBeenCalled();
  });

  it("should submit with the provider prover when one is set", async () => {
    const prover = { kind: "remote" };
    const mockClient = createMockWebClient({
      submitNewTransactionWithProver: vi
        .fn()
        .mockResolvedValue(createMockTransactionId("0xproved")),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      prover,
    });

    const { result } = renderHook(() => useBurnNonFungible());

    await act(async () => {
      await result.current.burnNonFungible({
        accountId: "0xholder",
        nonFungibleAsset: createMockNonFungibleAsset() as never,
      });
    });

    expect(mockClient.submitNewTransactionWithProver).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      prover
    );
    expect(mockClient.submitNewTransaction).not.toHaveBeenCalled();
  });

  it("should expose errors, converting non-Error values, and reset", async () => {
    const mockClient = createMockWebClient({
      newBurnNonFungibleAssetTransactionRequest: vi
        .fn()
        .mockRejectedValue("burn failed"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    const { result } = renderHook(() => useBurnNonFungible());

    await act(async () => {
      await expect(
        result.current.burnNonFungible({
          accountId: "0xholder",
          nonFungibleAsset: createMockNonFungibleAsset() as never,
        })
      ).rejects.toThrow("burn failed");
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.stage).toBe("idle");
    expect(result.current.isLoading).toBe(false);

    act(() => {
      result.current.reset();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
  });
});
