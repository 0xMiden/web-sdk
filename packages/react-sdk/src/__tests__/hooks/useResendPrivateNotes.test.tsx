import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useResendPrivateNotes } from "../../hooks/useResendPrivateNotes";
import { useTransaction } from "../../hooks/useTransaction";
import { useMultiSend } from "../../hooks/useMultiSend";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import * as transactionCommit from "../../utils/transactionCommit";
import { AccountId, Address, Note } from "@miden-sdk/miden-sdk";
import {
  createMockAccount,
  createMockAccountId,
  createMockNote,
  createMockOutputNote,
  createMockTransactionId,
  createMockTransactionRequest,
  createMockWebClient,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({ useMiden: vi.fn() }));

vi.mock("../../utils/transactionCommit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/transactionCommit")>()),
  waitForTransactionCommit: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.mocked(transactionCommit.waitForTransactionCommit)
    .mockReset()
    .mockResolvedValue(undefined);
});

const relayDown = () => new Error("transport unavailable");

const request = {
  transactionId: "0xtx",
  notes: [
    { noteId: "0xn1", to: "0xr1" },
    { noteId: "0xn2", to: "mtst1recipient" },
  ],
};

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  await act(async () => {
    await run().catch((err: unknown) => (thrown = err));
  });
  if (thrown === undefined) throw new Error("expected the call to reject");
  return thrown;
}

describe("useResendPrivateNotes", () => {
  it("throws when the client is not ready", async () => {
    mockUseMiden.mockReturnValue({ client: null, isReady: false });
    const { result } = renderHook(() => useResendPrivateNotes());

    await expect(result.current.resend(request)).rejects.toThrow(
      "Miden client is not ready"
    );
  });

  it("syncs once, then relays every note with a freshly parsed address", async () => {
    const client = createMockWebClient();
    const runExclusive = vi.fn(<T,>(fn: () => Promise<T>) => fn());
    mockUseMiden.mockReturnValue({ client, isReady: true, runExclusive });
    const { result } = renderHook(() => useResendPrivateNotes());

    await act(async () => {
      await result.current.resend(request);
    });

    expect(client.syncState).toHaveBeenCalledTimes(1);
    expect(client.syncState.mock.invocationCallOrder[0]).toBeLessThan(
      client.sendPrivateOutputNote.mock.invocationCallOrder[0]
    );
    expect(client.sendPrivateOutputNote.mock.calls.map(([id]) => id)).toEqual([
      "0xn1",
      "0xn2",
    ]);
    expect(Address.fromBech32).toHaveBeenCalledWith("mtst1recipient");
    // One sync and one relay per note, each under the provider's lock.
    expect(runExclusive).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps the request's transaction id when a note still fails", async () => {
    const client = createMockWebClient({
      sendPrivateOutputNote: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(relayDown()),
    });
    mockUseMiden.mockReturnValue({ client, isReady: true });
    const { result } = renderHook(() => useResendPrivateNotes());

    const err = await rejection(() => result.current.resend(request));

    expect(err).toMatchObject({
      name: "PrivateNoteDeliveryError",
      code: "PRIVATE_NOTE_DELIVERY_FAILED",
      transactionId: "0xtx",
      commitment: "unknown",
      delivered: [{ noteId: "0xn1", to: "0xr1" }],
      undelivered: [{ noteId: "0xn2", to: "mtst1recipient" }],
    });
    expect(result.current.error).toBe(err);
  });

  it("succeeds on a later attempt and clears the error", async () => {
    const client = createMockWebClient({
      sendPrivateOutputNote: vi
        .fn()
        .mockRejectedValueOnce(relayDown())
        .mockResolvedValue(undefined),
    });
    mockUseMiden.mockReturnValue({ client, isReady: true });
    const { result } = renderHook(() => useResendPrivateNotes());
    const single = { transactionId: "0xtx", notes: [request.notes[0]] };

    await rejection(() => result.current.resend(single));
    expect(result.current.error).not.toBeNull();

    await act(async () => {
      await result.current.resend(single);
    });
    expect(result.current.error).toBeNull();
    expect(client.sendPrivateOutputNote).toHaveBeenCalledTimes(2);
  });

  it("rejects with the sync error and relays nothing when the sync fails", async () => {
    const client = createMockWebClient({
      syncState: vi.fn().mockRejectedValue(new Error("node down")),
    });
    mockUseMiden.mockReturnValue({ client, isReady: true });
    const { result } = renderHook(() => useResendPrivateNotes());

    const err = await rejection(() => result.current.resend(request));

    expect((err as Error).message).toBe("node down");
    expect(client.sendPrivateOutputNote).not.toHaveBeenCalled();
    expect(result.current.error).toBe(err);
  });

  it("resends what useTransaction reported for an AccountId target", async () => {
    const txResult = {
      id: vi.fn(() => createMockTransactionId("0xtxa")),
      executedTransaction: vi.fn(() => ({
        userOutputNotes: vi.fn(() => [
          createMockOutputNote(createMockNote("0xpa")),
        ]),
      })),
    };
    const client = createMockWebClient({
      executeTransaction: vi.fn().mockResolvedValue(txResult),
      sendPrivateOutputNote: vi
        .fn()
        .mockRejectedValueOnce(relayDown())
        .mockResolvedValue(undefined),
    });
    mockUseMiden.mockReturnValue({
      client,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });
    const { result: tx } = renderHook(() => useTransaction());
    const { result: resender } = renderHook(() => useResendPrivateNotes());

    const err = (await rejection(() =>
      tx.current.execute({
        accountId: "0xaccount",
        request: createMockTransactionRequest(),
        privateNoteTarget: createMockAccountId("0xtarget") as never,
      })
    )) as { transactionId: string; undelivered: typeof request.notes };
    expect(err.undelivered).toEqual([{ noteId: "0xpa", to: "0xtarget" }]);

    await act(async () => {
      await resender.current.resend({
        transactionId: err.transactionId,
        notes: err.undelivered,
      });
    });

    expect(AccountId.fromHex).toHaveBeenLastCalledWith("0xtarget");
    expect(client.sendPrivateOutputNote).toHaveBeenCalledTimes(2);
    expect(client.sendPrivateOutputNote.mock.calls[1][0]).toBe("0xpa");
  });

  it("resends what useMultiSend reported for an Account recipient", async () => {
    vi.mocked(Note.createP2IDNote).mockImplementation(
      () => createMockNote("0xpm") as never
    );
    const client = createMockWebClient({
      executeTransaction: vi.fn().mockResolvedValue({
        id: vi.fn(() => createMockTransactionId("0xtxm")),
      }),
      sendPrivateOutputNote: vi
        .fn()
        .mockRejectedValueOnce(relayDown())
        .mockResolvedValue(undefined),
    });
    mockUseMiden.mockReturnValue({
      client,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });
    const { result: multi } = renderHook(() => useMultiSend());
    const { result: resender } = renderHook(() => useResendPrivateNotes());
    const account = createMockAccount({
      id: vi.fn(() => createMockAccountId("0xowner")),
    });

    const err = (await rejection(() =>
      multi.current.sendMany({
        from: "0xsender",
        assetId: "0xfaucet",
        recipients: [{ to: account as never, amount: 1n }],
      })
    )) as { transactionId: string; undelivered: typeof request.notes };
    expect(err).toMatchObject({
      transactionId: "0xtxm",
      undelivered: [{ noteId: "0xpm", to: "0xowner" }],
    });

    await act(async () => {
      await resender.current.resend({
        transactionId: err.transactionId,
        notes: err.undelivered,
      });
    });

    expect(AccountId.fromHex).toHaveBeenLastCalledWith("0xowner");
    expect(client.sendPrivateOutputNote).toHaveBeenCalledTimes(2);
  });
});
