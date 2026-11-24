import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { useSend } from "../../hooks/useSend";
import { useMultiSend } from "../../hooks/useMultiSend";
import { useMint } from "../../hooks/useMint";
import { useBridge } from "../../hooks/useBridge";
import { useSwap } from "../../hooks/useSwap";
import { usePswapCreate } from "../../hooks/usePswapCreate";
import { usePswapConsume } from "../../hooks/usePswapConsume";
import { useCreateNetworkNote } from "../../hooks/useCreateNetworkNote";
import { useCreateFaucet } from "../../hooks/useCreateFaucet";
import { createMockWebClient } from "../mocks/miden-sdk";
import type { NoteScript } from "@miden-sdk/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({ useMiden: vi.fn() }));
const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

// 2^53 is not a safe integer: BigInt() of a number this size can already be
// a rounded value, so the hooks must refuse it rather than build with it.
const UNSAFE = 2 ** 53;
const SAFE_INTEGER_ERROR =
  /amount must be a safe integer when given as a number/;

let client: ReturnType<typeof createMockWebClient>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
  client = createMockWebClient();
  mockUseMiden.mockReturnValue({
    client,
    isReady: true,
    sync: vi.fn().mockResolvedValue(undefined),
  });
});

function expectNothingSubmitted() {
  expect(client.submitNewTransaction).not.toHaveBeenCalled();
  expect(client.submitNewTransactionWithProver).not.toHaveBeenCalled();
}

describe("unsafe number amounts", () => {
  it("useSend rejects an unsafe amount", async () => {
    const { result } = renderHook(() => useSend());
    await expect(
      result.current.send({
        from: "0xsender",
        to: "0xreceiver",
        assetId: "0xfaucet",
        amount: UNSAFE,
      })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expect(client.newSendTransactionRequest).not.toHaveBeenCalled();
    expectNothingSubmitted();
  });

  it("useMultiSend rejects an unsafe recipient amount", async () => {
    const { result } = renderHook(() => useMultiSend());
    await expect(
      result.current.sendMany({
        from: "0xsender",
        assetId: "0xfaucet",
        recipients: [{ to: "0xreceiver", amount: UNSAFE }],
      })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expectNothingSubmitted();
  });

  it("useMint rejects an unsafe amount", async () => {
    const { result } = renderHook(() => useMint());
    await expect(
      result.current.mint({
        targetAccountId: "0xtarget",
        faucetId: "0xfaucet",
        amount: UNSAFE,
      })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expect(client.newMintTransactionRequest).not.toHaveBeenCalled();
    expectNothingSubmitted();
  });

  it("useBridge rejects an unsafe amount", async () => {
    const { result } = renderHook(() => useBridge());
    await expect(
      result.current.bridge({
        from: "0xsender",
        bridgeAccount: "0xbridge",
        assetId: "0xfaucet",
        amount: UNSAFE,
        destinationNetwork: 1,
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expect(client.newB2AggTransactionRequest).not.toHaveBeenCalled();
    expectNothingSubmitted();
  });

  it.each([
    ["offeredAmount", { offeredAmount: UNSAFE, requestedAmount: 1n }],
    ["requestedAmount", { offeredAmount: 1n, requestedAmount: UNSAFE }],
  ])("useSwap rejects an unsafe %s", async (_name, amounts) => {
    const { result } = renderHook(() => useSwap());
    await expect(
      result.current.swap({
        accountId: "0xaccount",
        offeredFaucetId: "0xoffered",
        requestedFaucetId: "0xrequested",
        ...amounts,
      })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expect(client.newSwapTransactionRequest).not.toHaveBeenCalled();
    expectNothingSubmitted();
  });

  it.each([
    ["offeredAmount", { offeredAmount: UNSAFE, requestedAmount: 1n }],
    ["requestedAmount", { offeredAmount: 1n, requestedAmount: UNSAFE }],
  ])("usePswapCreate rejects an unsafe %s", async (_name, amounts) => {
    const { result } = renderHook(() => usePswapCreate());
    await expect(
      result.current.pswapCreate({
        accountId: "0xaccount",
        offeredFaucetId: "0xoffered",
        requestedFaucetId: "0xrequested",
        ...amounts,
      })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expect(client.newPswapCreateTransactionRequest).not.toHaveBeenCalled();
    expectNothingSubmitted();
  });

  it.each([
    ["fillAmount", { fillAmount: UNSAFE }],
    ["noteFillAmount", { fillAmount: 1n, noteFillAmount: UNSAFE }],
  ])("usePswapConsume rejects an unsafe %s", async (_name, amounts) => {
    const { result } = renderHook(() => usePswapConsume());
    await expect(
      result.current.pswapConsume({
        accountId: "0xaccount",
        note: "0xpswap_note",
        ...amounts,
      })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expect(client.newPswapConsumeTransactionRequest).not.toHaveBeenCalled();
    expectNothingSubmitted();
  });

  it("useCreateNetworkNote rejects an unsafe amount", async () => {
    const { result } = renderHook(() => useCreateNetworkNote());
    await expect(
      result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xtarget",
        script: {} as unknown as NoteScript,
        assetId: "0xfaucet",
        amount: UNSAFE,
      })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expectNothingSubmitted();
  });

  it("useCreateFaucet rejects an unsafe maxSupply", async () => {
    // createFaucet only runs for the store's current client.
    useMidenStore.getState().setClient(client as never);
    const { result } = renderHook(() => useCreateFaucet());
    await expect(
      result.current.createFaucet({ tokenSymbol: "TEST", maxSupply: UNSAFE })
    ).rejects.toThrow(SAFE_INTEGER_ERROR);
    expect(client.newFaucet).not.toHaveBeenCalled();
  });

  it("still accepts a safe number amount", async () => {
    const { result } = renderHook(() => useMint());
    await result.current.mint({
      targetAccountId: "0xtarget",
      faucetId: "0xfaucet",
      amount: Number.MAX_SAFE_INTEGER,
    });
    expect(client.newMintTransactionRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      BigInt(Number.MAX_SAFE_INTEGER)
    );
  });
});
