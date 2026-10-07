import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransaction } from "../../hooks/useTransaction";
import { useSend } from "../../hooks/useSend";
import { useMultiSend } from "../../hooks/useMultiSend";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import * as transactionCommit from "../../utils/transactionCommit";
import { Address, AccountId, Note, NoteType } from "@miden-sdk/miden-sdk";
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

// The commit wait is driven directly so its outcomes need no real or fake time.
vi.mock("../../utils/transactionCommit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/transactionCommit")>()),
  waitForTransactionCommit: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;
const waitForCommit = vi.mocked(transactionCommit.waitForTransactionCommit);

const discarded = () =>
  new transactionCommit.TransactionDiscardedError() as Error;
const timedOut = () => new Error("Timeout waiting for transaction commit");
const relayDown = () => new Error("transport unavailable");

beforeEach(() => {
  useMidenStore.getState().reset();
  waitForCommit.mockReset().mockResolvedValue(undefined);
});

const txResultWith = (txHex: string, outputs: unknown[]) => ({
  id: vi.fn(() => createMockTransactionId(txHex)),
  executedTransaction: vi.fn(() => ({
    userOutputNotes: vi.fn(() => outputs),
    outputNotes: vi.fn(() => ({ notes: vi.fn(() => outputs) })),
  })),
  serialize: vi.fn(() => new Uint8Array()),
});

const privateOutput = (id: string) => createMockOutputNote(createMockNote(id));

const clientFor = (
  txResult: unknown,
  overrides: Parameters<typeof createMockWebClient>[0] = {}
) =>
  createMockWebClient({
    executeTransaction: vi.fn().mockResolvedValue(txResult),
    submitProvenTransaction: vi.fn().mockResolvedValue(100),
    ...overrides,
  });

const ready = (client: unknown) =>
  mockUseMiden.mockReturnValue({
    client,
    isReady: true,
    sync: vi.fn().mockResolvedValue(undefined),
  });

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  await act(async () => {
    await run().catch((err: unknown) => (thrown = err));
  });
  if (thrown === undefined) throw new Error("expected the call to reject");
  return thrown;
}

describe("useTransaction with privateNoteTarget", () => {
  const execute = (
    hook: { current: ReturnType<typeof useTransaction> },
    privateNoteTarget: unknown = "0xrecipient"
  ) =>
    hook.current.execute({
      accountId: "0xaccount",
      request: createMockTransactionRequest(),
      privateNoteTarget: privateNoteTarget as string,
    });

  it("rejects with the transaction id when the relay fails after commit", async () => {
    const client = clientFor(txResultWith("0xtx1", [privateOutput("0xp1")]), {
      sendPrivateOutputNote: vi.fn().mockRejectedValue(relayDown()),
    });
    ready(client);
    const { result } = renderHook(() => useTransaction());

    const err = await rejection(() => execute(result));

    expect(err).toMatchObject({
      name: "PrivateNoteDeliveryError",
      code: "PRIVATE_NOTE_DELIVERY_FAILED",
      transactionId: "0xtx1",
      commitment: "committed",
      delivered: [],
      undelivered: [{ noteId: "0xp1", to: "0xrecipient" }],
    });
    expect((err as { cause?: Error }).cause?.message).toBe(
      "transport unavailable"
    );
    expect(result.current.error).toBe(err);
    expect(result.current.result).toBeNull();
    expect(result.current.stage).toBe("idle");
  });

  it("reports every owed note with an unknown commitment when apply fails", async () => {
    const client = clientFor(
      txResultWith("0xtx2", [privateOutput("0xp1"), privateOutput("0xp2")]),
      { applyTransaction: vi.fn().mockRejectedValue(new Error("store full")) }
    );
    ready(client);
    const { result } = renderHook(() => useTransaction());

    const err = await rejection(() => execute(result));

    expect(err).toMatchObject({
      code: "PRIVATE_NOTE_DELIVERY_FAILED",
      transactionId: "0xtx2",
      commitment: "unknown",
      delivered: [],
      undelivered: [
        { noteId: "0xp1", to: "0xrecipient" },
        { noteId: "0xp2", to: "0xrecipient" },
      ],
    });
    expect(waitForCommit).not.toHaveBeenCalled();
    expect(client.sendPrivateOutputNote).not.toHaveBeenCalled();
  });

  it("reports every owed note with an unknown commitment when the commit wait times out", async () => {
    waitForCommit.mockRejectedValue(timedOut());
    const client = clientFor(txResultWith("0xtx3", [privateOutput("0xp1")]));
    ready(client);
    const { result } = renderHook(() => useTransaction());

    const err = await rejection(() => execute(result));

    expect(err).toMatchObject({
      code: "PRIVATE_NOTE_DELIVERY_FAILED",
      transactionId: "0xtx3",
      commitment: "unknown",
      undelivered: [{ noteId: "0xp1", to: "0xrecipient" }],
    });
    expect(client.sendPrivateOutputNote).not.toHaveBeenCalled();
  });

  it("rejects with a plain error when the transaction is discarded", async () => {
    waitForCommit.mockRejectedValue(discarded());
    const client = clientFor(txResultWith("0xtx4", [privateOutput("0xp1")]));
    ready(client);
    const { result } = renderHook(() => useTransaction());

    const err = await rejection(() => execute(result));

    expect((err as Error).message).toBe(
      "Transaction was discarded before commit"
    );
    expect(err).not.toHaveProperty("code");
    expect(client.sendPrivateOutputNote).not.toHaveBeenCalled();
  });

  it("relays each private note with its own address", async () => {
    const client = clientFor(
      txResultWith("0xtx5", [privateOutput("0xp1"), privateOutput("0xp2")])
    );
    ready(client);
    const { result } = renderHook(() => useTransaction());

    let summary: unknown;
    await act(async () => {
      summary = await execute(result);
    });

    expect(summary).toEqual({ transactionId: "0xtx5" });
    expect(client.sendPrivateOutputNote).toHaveBeenCalledTimes(2);
    const [[firstId, firstAddress], [secondId, secondAddress]] =
      client.sendPrivateOutputNote.mock.calls;
    expect([firstId, secondId]).toEqual(["0xp1", "0xp2"]);
    expect(firstAddress).not.toBe(secondAddress);
  });

  it("attempts every note and reports only the ones that failed", async () => {
    const client = clientFor(
      txResultWith("0xtx6", [privateOutput("0xp1"), privateOutput("0xp2")]),
      {
        sendPrivateOutputNote: vi
          .fn()
          .mockRejectedValueOnce(relayDown())
          .mockResolvedValue(undefined),
      }
    );
    ready(client);
    const { result } = renderHook(() => useTransaction());

    const err = await rejection(() => execute(result));

    expect(client.sendPrivateOutputNote).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({
      commitment: "committed",
      delivered: [{ noteId: "0xp2", to: "0xrecipient" }],
      undelivered: [{ noteId: "0xp1", to: "0xrecipient" }],
    });
  });

  it("reports a private note whose full note cannot be read as undelivered", async () => {
    const unreadable = privateOutput("0xp1");
    unreadable.intoFull.mockImplementation(() => {
      throw new Error("partial note");
    });
    const client = clientFor(
      txResultWith("0xtx7", [unreadable, privateOutput("0xp2")])
    );
    ready(client);
    const { result } = renderHook(() => useTransaction());

    const err = await rejection(() => execute(result));

    expect(client.sendPrivateOutputNote).toHaveBeenCalledTimes(1);
    expect(client.sendPrivateOutputNote.mock.calls[0][0]).toBe("0xp2");
    expect(err).toMatchObject({
      transactionId: "0xtx7",
      commitment: "committed",
      delivered: [{ noteId: "0xp2", to: "0xrecipient" }],
      undelivered: [{ noteId: "0xp1", to: "0xrecipient" }],
    });
  });

  it("does not count a public output note as owed", async () => {
    const client = clientFor(
      txResultWith("0xtx8", [
        createMockOutputNote(createMockNote("0xpub"), NoteType.Public),
      ])
    );
    ready(client);
    const { result } = renderHook(() => useTransaction());

    await act(async () => {
      await execute(result);
    });

    expect(client.sendPrivateOutputNote).not.toHaveBeenCalled();
  });

  it("rejects a malformed privateNoteTarget before executing", async () => {
    vi.mocked(Address.fromBech32).mockImplementationOnce(() => {
      throw new Error("invalid address");
    });
    vi.mocked(AccountId.fromBech32).mockImplementationOnce(() => {
      throw new Error("invalid bech32");
    });
    const client = clientFor(txResultWith("0xtx9", [privateOutput("0xp1")]));
    ready(client);
    const { result } = renderHook(() => useTransaction());

    const err = await rejection(() => execute(result, "mtst1notanaddress"));

    expect((err as Error).message).toBe("invalid bech32");
    expect(client.executeTransaction).not.toHaveBeenCalled();
    expect(client.submitProvenTransaction).not.toHaveBeenCalled();
  });

  it("clears the previous result when a new call starts", async () => {
    const client = clientFor(txResultWith("0xtx10", [privateOutput("0xp1")]));
    ready(client);
    const { result } = renderHook(() => useTransaction());
    await act(async () => {
      await execute(result);
    });
    expect(result.current.result).toEqual({ transactionId: "0xtx10" });

    client.sendPrivateOutputNote.mockRejectedValueOnce(relayDown());
    await rejection(() => execute(result));

    expect(result.current.result).toBeNull();
  });
});

describe("useSend with a private note", () => {
  const send = (hook: { current: ReturnType<typeof useSend> }) =>
    hook.current.send({
      from: "0x1",
      to: "0x2",
      assetId: "0x3",
      amount: 100n,
      noteType: "private",
    });

  it("rejects with the transaction id when the relay fails after commit", async () => {
    const client = clientFor(txResultWith("0xsend1", [privateOutput("0xn1")]), {
      sendPrivateOutputNote: vi.fn().mockRejectedValue(relayDown()),
    });
    ready(client);
    const { result } = renderHook(() => useSend());

    const err = await rejection(() => send(result));

    expect(err).toMatchObject({
      name: "PrivateNoteDeliveryError",
      code: "PRIVATE_NOTE_DELIVERY_FAILED",
      transactionId: "0xsend1",
      commitment: "committed",
      undelivered: [{ noteId: "0xn1", to: "0x2" }],
    });
    expect(result.current.result).toBeNull();
    expect(result.current.stage).toBe("idle");
  });

  it("reports the note with an unknown commitment when apply fails", async () => {
    const client = clientFor(txResultWith("0xsend2", [privateOutput("0xn1")]), {
      applyTransaction: vi.fn().mockRejectedValue(new Error("store full")),
    });
    ready(client);
    const { result } = renderHook(() => useSend());

    const err = await rejection(() => send(result));

    expect(err).toMatchObject({
      transactionId: "0xsend2",
      commitment: "unknown",
      undelivered: [{ noteId: "0xn1", to: "0x2" }],
    });
  });

  it("reports the note with an unknown commitment when the commit wait times out", async () => {
    waitForCommit.mockRejectedValue(timedOut());
    const client = clientFor(txResultWith("0xsend3", [privateOutput("0xn1")]));
    ready(client);
    const { result } = renderHook(() => useSend());

    const err = await rejection(() => send(result));

    expect(err).toMatchObject({
      transactionId: "0xsend3",
      commitment: "unknown",
      undelivered: [{ noteId: "0xn1", to: "0x2" }],
    });
    expect(client.sendPrivateOutputNote).not.toHaveBeenCalled();
  });

  it("rejects with a plain error when the transaction is discarded", async () => {
    waitForCommit.mockRejectedValue(discarded());
    const client = clientFor(txResultWith("0xsend4", [privateOutput("0xn1")]));
    ready(client);
    const { result } = renderHook(() => useSend());

    const err = await rejection(() => send(result));

    expect((err as Error).message).toBe(
      "Transaction was discarded before commit"
    );
    expect(err).not.toHaveProperty("code");
  });

  it("reports a note with no full note to relay with the transaction id", async () => {
    const partial = privateOutput("0xn1");
    partial.intoFull.mockReturnValue(null as never);
    const client = clientFor(txResultWith("0xsend5", [partial]));
    ready(client);
    const { result } = renderHook(() => useSend());

    const err = await rejection(() => send(result));

    expect(err).toMatchObject({
      code: "PRIVATE_NOTE_DELIVERY_FAILED",
      transactionId: "0xsend5",
      commitment: "unknown",
      undelivered: [{ noteId: "0xn1", to: "0x2" }],
    });
    expect((err as Error).message).toContain(
      "Missing full note for private send"
    );
    expect(client.applyTransaction).toHaveBeenCalledTimes(1);
    expect(waitForCommit).not.toHaveBeenCalled();
  });

  it("clears the previous result when a new call starts", async () => {
    const client = clientFor(txResultWith("0xsend6", [privateOutput("0xn1")]));
    ready(client);
    const { result } = renderHook(() => useSend());
    await act(async () => {
      await send(result);
    });
    expect(result.current.result).toEqual({ txId: "0xsend6", note: null });

    client.sendPrivateOutputNote.mockRejectedValueOnce(relayDown());
    await rejection(() => send(result));

    expect(result.current.result).toBeNull();
  });
});

describe("useMultiSend with private recipients", () => {
  const sendMany = (
    hook: { current: ReturnType<typeof useMultiSend> },
    recipients: Array<{ to: unknown; amount: bigint }> = [
      { to: "0xr1", amount: 1n },
    ]
  ) =>
    hook.current.sendMany({
      from: "0xsender",
      assetId: "0xfaucet",
      recipients: recipients as Array<{ to: string; amount: bigint }>,
    });

  // Each created note gets its own id, as real notes do.
  const distinctNoteIds = () => {
    let n = 0;
    vi.mocked(Note.createP2IDNote).mockImplementation(() => {
      n += 1;
      return createMockNote(`0xm${n}`) as never;
    });
  };

  beforeEach(distinctNoteIds);

  const client = (overrides: Parameters<typeof createMockWebClient>[0] = {}) =>
    clientFor(txResultWith("0xmulti", []), overrides);

  it("rejects with the transaction id when the relay fails after commit", async () => {
    const c = client({
      sendPrivateOutputNote: vi.fn().mockRejectedValue(relayDown()),
    });
    ready(c);
    const { result } = renderHook(() => useMultiSend());

    const err = await rejection(() => sendMany(result));

    expect(err).toMatchObject({
      name: "PrivateNoteDeliveryError",
      code: "PRIVATE_NOTE_DELIVERY_FAILED",
      transactionId: "0xmulti",
      commitment: "committed",
      undelivered: [{ noteId: "0xm1", to: "0xr1" }],
    });
    expect(result.current.result).toBeNull();
  });

  it("reports every owed note with an unknown commitment when apply fails", async () => {
    const c = client({
      applyTransaction: vi.fn().mockRejectedValue(new Error("store full")),
    });
    ready(c);
    const { result } = renderHook(() => useMultiSend());

    const err = await rejection(() => sendMany(result));

    expect(err).toMatchObject({
      transactionId: "0xmulti",
      commitment: "unknown",
      undelivered: [{ noteId: "0xm1", to: "0xr1" }],
    });
  });

  it("reports every owed note with an unknown commitment when the commit wait times out", async () => {
    waitForCommit.mockRejectedValue(timedOut());
    const c = client();
    ready(c);
    const { result } = renderHook(() => useMultiSend());

    const err = await rejection(() => sendMany(result));

    expect(err).toMatchObject({
      transactionId: "0xmulti",
      commitment: "unknown",
      undelivered: [{ noteId: "0xm1", to: "0xr1" }],
    });
  });

  it("rejects with a plain error when the transaction is discarded", async () => {
    waitForCommit.mockRejectedValue(discarded());
    const c = client();
    ready(c);
    const { result } = renderHook(() => useMultiSend());

    const err = await rejection(() => sendMany(result));

    expect((err as Error).message).toBe(
      "Transaction was discarded before commit"
    );
    expect(err).not.toHaveProperty("code");
  });

  it("attempts every recipient after one relay fails", async () => {
    const c = client({
      sendPrivateOutputNote: vi
        .fn()
        .mockRejectedValueOnce(relayDown())
        .mockResolvedValue(undefined),
    });
    ready(c);
    const { result } = renderHook(() => useMultiSend());

    const err = await rejection(() =>
      sendMany(result, [
        { to: "0xr1", amount: 1n },
        { to: "0xr2", amount: 2n },
      ])
    );

    expect(c.sendPrivateOutputNote).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({
      commitment: "committed",
      delivered: [{ noteId: "0xm2", to: "0xr2" }],
      undelivered: [{ noteId: "0xm1", to: "0xr1" }],
    });
  });

  it("names object recipients by their account id", async () => {
    const c = client({
      sendPrivateOutputNote: vi.fn().mockRejectedValue(relayDown()),
    });
    ready(c);
    const { result } = renderHook(() => useMultiSend());

    const err = await rejection(() =>
      sendMany(result, [
        { to: createMockAccountId("0xaa"), amount: 1n },
        {
          to: createMockAccount({
            id: vi.fn(() => createMockAccountId("0xbb")),
          }),
          amount: 2n,
        },
      ])
    );

    expect(err).toMatchObject({
      undelivered: [
        { noteId: "0xm1", to: "0xaa" },
        { noteId: "0xm2", to: "0xbb" },
      ],
    });
  });

  it("clears the previous result when a new call starts", async () => {
    const c = client();
    ready(c);
    const { result } = renderHook(() => useMultiSend());
    await act(async () => {
      await sendMany(result);
    });
    expect(result.current.result).toEqual({ transactionId: "0xmulti" });

    c.sendPrivateOutputNote.mockRejectedValueOnce(relayDown());
    await rejection(() => sendMany(result));

    expect(result.current.result).toBeNull();
  });
});
