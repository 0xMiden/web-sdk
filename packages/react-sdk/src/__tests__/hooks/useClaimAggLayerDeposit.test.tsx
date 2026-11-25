import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ForeignAccount, Note } from "@miden-sdk/miden-sdk";
import type { ClaimLeafData, ClaimProofData } from "@miden-sdk/miden-sdk";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockTransactionId,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({ useMiden: vi.fn() }));
const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

// Loaded at run time so a missing hook fails an assertion, not the suite load.
const HOOK_MODULE = "../../hooks/useClaimAggLayerDeposit";
let useClaimAggLayerDeposit: () => any;
beforeAll(async () => {
  const mod = await import(/* @vite-ignore */ HOOK_MODULE).catch(() => ({}));
  useClaimAggLayerDeposit = (mod as Record<string, () => any>)
    .useClaimAggLayerDeposit;
});

const proof = { proof: true } as unknown as ClaimProofData;
const leaf = { leaf: true } as unknown as ClaimLeafData;

const claimOptions = {
  from: "0xsender",
  bridgeAccount: "0xbridge",
  proof,
  leaf,
  scale: 10,
};

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useClaimAggLayerDeposit", () => {
  it("is exported from its module", () => {
    expect(typeof useClaimAggLayerDeposit).toBe("function");
  });

  it("returns the initial state", () => {
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useClaimAggLayerDeposit());
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
    const { result } = renderHook(() => useClaimAggLayerDeposit());
    await expect(
      result.current.claimAggLayerDeposit(claimOptions)
    ).rejects.toThrow("Miden client is not ready");
  });

  it("submits the CLAIM note as the sender with the bridge declared", async () => {
    const mockSync = vi.fn().mockResolvedValue(undefined);
    const client = createMockWebClient({
      submitNewTransaction: vi
        .fn()
        .mockResolvedValue(createMockTransactionId("0xclaimtx")),
    });
    mockUseMiden.mockReturnValue({ client, isReady: true, sync: mockSync });
    const { result } = renderHook(() => useClaimAggLayerDeposit());

    let out: any;
    await act(async () => {
      out = await result.current.claimAggLayerDeposit(claimOptions);
    });

    const createClaimNote = Note.createClaimNote as ReturnType<typeof vi.fn>;
    expect(createClaimNote).toHaveBeenCalledTimes(1);
    const [p, l, scale, bridge, sender] = createClaimNote.mock.calls[0];
    expect(p).toBe(proof);
    expect(l).toBe(leaf);
    expect(scale).toBe(10);
    expect(String(bridge)).toBe("0xbridge");
    expect(String(sender)).toBe("0xsender");

    const [executing] = client.feeAwareTransactionRequestBuilder.mock.calls[0];
    expect(String(executing)).toBe("0xsender");
    const builder =
      await client.feeAwareTransactionRequestBuilder.mock.results[0].value;
    const [outputs] = builder.withOwnOutputNotes.mock.calls[0];
    expect((outputs as { notes: unknown[] }).notes).toEqual([out.note]);
    const [declared] = builder.withForeignAccounts.mock.calls[0];
    expect((declared as { pushed: unknown[] }).pushed).toHaveLength(1);
    const publicAccount = ForeignAccount.public as ReturnType<typeof vi.fn>;
    expect(String(publicAccount.mock.calls[0][0])).toBe("0xbridge");
    expect(String(client.submitNewTransaction.mock.calls[0][0])).toBe(
      "0xsender"
    );
    // The built request, not the builder, is what gets submitted.
    expect(client.submitNewTransaction.mock.calls[0][1]).toBe(
      builder.build.mock.results[0].value
    );

    expect(out.txId).toBe("0xclaimtx");
    expect(out.note.id().toString()).toBe("0xclaimnote");
    expect(result.current.result).toBe(out);
    expect(result.current.stage).toBe("complete");
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it("routes through the provided runExclusive", async () => {
    const runExclusive = vi.fn(async (fn: () => Promise<unknown>) => fn());
    const client = createMockWebClient({
      submitNewTransaction: vi
        .fn()
        .mockResolvedValue(createMockTransactionId("0xclaimtx")),
    });
    mockUseMiden.mockReturnValue({
      client,
      isReady: true,
      sync: vi.fn(),
      runExclusive,
    });
    const { result } = renderHook(() => useClaimAggLayerDeposit());

    await act(async () => {
      await result.current.claimAggLayerDeposit(claimOptions);
    });

    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(client.submitNewTransaction).toHaveBeenCalledTimes(1);
  });

  it("submits with the configured prover and skips the sync on request", async () => {
    const mockSync = vi.fn();
    const prover = { prover: true };
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
    const { result } = renderHook(() => useClaimAggLayerDeposit());

    let out: any;
    await act(async () => {
      out = await result.current.claimAggLayerDeposit({
        ...claimOptions,
        skipSync: true,
      });
    });

    expect(out.txId).toBe("0xprovedtx");
    expect(client.submitNewTransactionWithProver.mock.calls[0][2]).toBe(prover);
    expect(client.submitNewTransaction).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["above 18", 19],
    ["NaN", NaN],
  ])(
    "rejects a scale that is %s before the note is built",
    async (_label, scale) => {
      const client = createMockWebClient();
      mockUseMiden.mockReturnValue({ client, isReady: true, sync: vi.fn() });
      const { result } = renderHook(() => useClaimAggLayerDeposit());

      let caught: unknown;
      await act(async () => {
        caught = await result.current
          .claimAggLayerDeposit({ ...claimOptions, scale })
          .catch((err: unknown) => err);
      });

      expect(String(caught)).toMatch(/scale must be an integer from 0 to 18/);
      expect(Note.createClaimNote).not.toHaveBeenCalled();
      expect(client.submitNewTransaction).not.toHaveBeenCalled();
      expect(result.current.error).toBe(caught);
      expect(result.current.stage).toBe("idle");
    }
  );

  it("records a submit failure and resets", async () => {
    const client = createMockWebClient({
      submitNewTransaction: vi.fn().mockRejectedValue("rejected"),
    });
    mockUseMiden.mockReturnValue({ client, isReady: true, sync: vi.fn() });
    const { result } = renderHook(() => useClaimAggLayerDeposit());

    await act(async () => {
      await result.current
        .claimAggLayerDeposit(claimOptions)
        .catch(() => undefined);
    });
    expect(result.current.error?.message).toBe("rejected");
    expect(result.current.isLoading).toBe(false);

    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
    expect(result.current.stage).toBe("idle");
  });
});
