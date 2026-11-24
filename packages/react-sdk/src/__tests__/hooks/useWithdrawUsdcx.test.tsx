import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWithdrawUsdcx } from "../../hooks/useWithdrawUsdcx";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockTransactionId,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({ useMiden: vi.fn() }));
const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

const RECIPIENT = "0x" + "00".repeat(12) + "dead".padStart(40, "0");

const withdrawOptions = {
  from: "0xsender",
  faucetId: "0xusdcx",
  amount: 100n,
  destinationDomain: 6,
  destinationRecipient: RECIPIENT,
};

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useWithdrawUsdcx", () => {
  it("returns the initial state", () => {
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useWithdrawUsdcx());
    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.stage).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("throws when the client is not ready", async () => {
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useWithdrawUsdcx());
    await expect(result.current.withdrawUsdcx(withdrawOptions)).rejects.toThrow(
      "Miden client is not ready"
    );
  });

  it("builds the burn request and submits it as the sender", async () => {
    const mockSync = vi.fn().mockResolvedValue(undefined);
    const client = createMockWebClient({
      submitNewTransaction: vi
        .fn()
        .mockResolvedValue(createMockTransactionId("0xburntx")),
    });
    mockUseMiden.mockReturnValue({ client, isReady: true, sync: mockSync });
    const { result } = renderHook(() => useWithdrawUsdcx());

    let txResult;
    await act(async () => {
      txResult = await result.current.withdrawUsdcx({
        ...withdrawOptions,
        amount: 100,
      });
    });

    expect(txResult).toEqual({ transactionId: "0xburntx" });
    expect(result.current.result).toEqual({ transactionId: "0xburntx" });
    expect(result.current.stage).toBe("complete");
    expect(mockSync).toHaveBeenCalledTimes(1);
    const args = client.newXReserveBurnTransactionRequest.mock.calls[0];
    expect(args[2]).toBe(100n);
    expect(args[3]).toBe(6);
    const recipient = args[4] as Uint8Array;
    expect(recipient).toBeInstanceOf(Uint8Array);
    expect(recipient).toHaveLength(32);
    expect(Array.from(recipient.slice(30))).toEqual([0xde, 0xad]);
    expect(client.submitNewTransaction.mock.calls[0][0]).toBe(args[0]);
    expect(client.submitNewTransactionWithProver).not.toHaveBeenCalled();
  });

  it("uses the configured prover and honours skipSync", async () => {
    const prover = { id: "prover" };
    const mockSync = vi.fn();
    const client = createMockWebClient({
      submitNewTransactionWithProver: vi
        .fn()
        .mockResolvedValue(createMockTransactionId("0xprovedtx")),
    });
    mockUseMiden.mockReturnValue({
      client,
      isReady: true,
      sync: mockSync,
      prover,
    });
    const { result } = renderHook(() => useWithdrawUsdcx());

    await act(async () => {
      await result.current.withdrawUsdcx({
        ...withdrawOptions,
        skipSync: true,
      });
    });

    expect(client.submitNewTransactionWithProver.mock.calls[0][2]).toBe(prover);
    expect(client.submitNewTransaction).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unsafe number amount",
      { amount: 2 ** 53 },
      /amount must be a safe integer/,
    ],
    [
      "a 20-byte recipient",
      { destinationRecipient: "0x" + "ab".repeat(20) },
      /destinationRecipient must be a 0x-prefixed 32-byte hex string/,
    ],
    [
      "a recipient without 0x",
      { destinationRecipient: "ab".repeat(32) },
      /destinationRecipient must be a 0x-prefixed 32-byte hex string/,
    ],
  ])("rejects %s before building", async (_name, override, message) => {
    const client = createMockWebClient();
    mockUseMiden.mockReturnValue({ client, isReady: true, sync: vi.fn() });
    const { result } = renderHook(() => useWithdrawUsdcx());

    await act(async () => {
      await expect(
        result.current.withdrawUsdcx({ ...withdrawOptions, ...override })
      ).rejects.toThrow(message);
    });

    expect(client.newXReserveBurnTransactionRequest).not.toHaveBeenCalled();
    expect(client.submitNewTransaction).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.stage).toBe("idle");
  });
});
