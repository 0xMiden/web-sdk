import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoteType } from "@miden-sdk/miden-sdk";
import * as transactionCommit from "../../utils/transactionCommit";
import { PrivateNoteDeliveryError } from "../../utils/errors";
import {
  privateOutputNotesOwed,
  readOwedPrivateNotes,
  recipientRef,
  sentNoteOwed,
  settlePrivateNotes,
} from "../../utils/privateNoteDelivery";
import {
  createMockAccountHeader,
  createMockAccountId,
  createMockNote,
  createMockOutputNote,
  createMockWebClient,
} from "../mocks/miden-sdk";

vi.mock("../../utils/transactionCommit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/transactionCommit")>()),
  waitForTransactionCommit: vi.fn(),
}));

const waitForCommit = vi.mocked(transactionCommit.waitForTransactionCommit);
const passthrough = <T>(fn: () => Promise<T>) => fn();

beforeEach(() => {
  waitForCommit.mockReset().mockResolvedValue(undefined);
});

describe("PrivateNoteDeliveryError", () => {
  it("counts the undelivered notes against all owed ones", () => {
    const err = new PrivateNoteDeliveryError({
      transactionId: "0xtx",
      commitment: "committed",
      delivered: [{ noteId: "0x1", to: "0xa" }],
      undelivered: [{ noteId: "0x2", to: "0xb" }],
      cause: new Error("transport unavailable"),
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("PRIVATE_NOTE_DELIVERY_FAILED");
    expect(err.message).toBe(
      "Transaction 0xtx was committed, but 1 of 2 private notes was not delivered: transport unavailable"
    );
  });

  it("says so when the notes could not be read, and renders a non-Error cause", () => {
    const err = new PrivateNoteDeliveryError({
      transactionId: "0xtx",
      commitment: "unknown",
      delivered: [],
      undelivered: [],
      cause: "boom",
    });
    expect(err.message).toBe(
      "Transaction 0xtx was submitted, but its private notes could not be read: boom"
    );
    expect(err.cause).toBe("boom");
  });

  it("leaves the reason out when there is no cause", () => {
    const err = new PrivateNoteDeliveryError({
      transactionId: "0xtx",
      commitment: "unknown",
      delivered: [],
      undelivered: [
        { noteId: "0x1", to: "0xa" },
        { noteId: "0x2", to: "0xa" },
      ],
    });
    expect(err.message).toBe(
      "Transaction 0xtx was submitted, but 2 of 2 private notes were not delivered"
    );
  });
});

describe("recipientRef", () => {
  it("keeps a string as given and names an object by its account id", () => {
    expect(recipientRef("mtst1abc")).toBe("mtst1abc");
    expect(recipientRef(createMockAccountId("0xid") as never)).toBe("0xid");
    expect(recipientRef(createMockAccountHeader("0xhdr") as never)).toBe(
      "0xhdr"
    );
  });
});

describe("owed notes", () => {
  // The kernel's fee note is private-typed here so only the accessor keeps it
  // out of what is owed.
  const withFeeNoteFirst = () => {
    const userNote = createMockOutputNote(createMockNote("0xuser"));
    const feeNote = createMockOutputNote(createMockNote("0xfee"));
    return {
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [feeNote, userNote] }),
        userOutputNotes: () => [userNote],
      }),
    };
  };

  it("owes only the user note when outputNotes() lists the fee note first", () => {
    expect(
      sentNoteOwed(withFeeNoteFirst(), "0xto").map((note) => note.noteId)
    ).toEqual(["0xuser"]);
    expect(
      privateOutputNotesOwed(withFeeNoteFirst(), "0xto").map(
        (note) => note.noteId
      )
    ).toEqual(["0xuser"]);
  });

  it("reports a result without userOutputNotes() as unreadable", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [createMockOutputNote(createMockNote("0xn"))],
        }),
      }),
    };
    const owed = readOwedPrivateNotes(() =>
      privateOutputNotesOwed(txResult, "0xto")
    );
    expect(owed.unreadable).toBeDefined();
    expect(owed.notes).toEqual([]);
    expect(
      readOwedPrivateNotes(() => sentNoteOwed(txResult, "0xto")).unreadable
    ).toBeDefined();
  });

  it("marks a note whose intoFull() returns nothing as unavailable", () => {
    const partial = createMockOutputNote(createMockNote("0xn"));
    partial.intoFull.mockReturnValue(undefined as never);
    const [owed] = privateOutputNotesOwed(
      { executedTransaction: () => ({ userOutputNotes: () => [partial] }) },
      "0xto"
    );
    expect(owed.unavailable?.message).toBe(
      "Private output note 0xn has no full note to relay"
    );
  });

  it("skips public notes", () => {
    const txResult = {
      executedTransaction: () => ({
        userOutputNotes: () => [
          createMockOutputNote(createMockNote("0xpub"), NoteType.Public),
        ],
      }),
    };
    expect(privateOutputNotesOwed(txResult, "0xto")).toEqual([]);
  });

  it("rejects a send transaction that created no note", () => {
    const txResult = {
      executedTransaction: () => ({ userOutputNotes: () => [] }),
    };
    expect(() => sentNoteOwed(txResult, "0xto")).toThrow(
      "The send transaction created no output note"
    );
  });

  it("reports a read failure instead of an empty list", () => {
    const cause = new Error("unreadable");
    expect(
      readOwedPrivateNotes(() => {
        throw cause;
      })
    ).toEqual({ notes: [], unreadable: { cause } });
  });
});

describe("settlePrivateNotes", () => {
  const settle = (
    owed: Parameters<typeof settlePrivateNotes>[0]["owed"],
    apply: () => Promise<unknown> = () => Promise.resolve()
  ) => {
    const client = createMockWebClient();
    return {
      client,
      run: settlePrivateNotes({
        client: client as never,
        runExclusiveSafe: passthrough,
        transactionId: "0xtx",
        owed,
        apply,
      }),
    };
  };

  it("keeps an apply failure plain when nothing is owed", async () => {
    const applyError = new Error("store full");
    const { run } = settle({ notes: [] }, () => Promise.reject(applyError));
    await expect(run).rejects.toBe(applyError);
  });

  it("reports an unreadable transaction even when apply fails", async () => {
    const { run } = settle(
      { notes: [], unreadable: { cause: new Error("unreadable") } },
      () => Promise.reject(new Error("store full"))
    );
    await expect(run).rejects.toMatchObject({
      code: "PRIVATE_NOTE_DELIVERY_FAILED",
      commitment: "unknown",
      undelivered: [],
    });
  });

  it("keeps a commit-wait failure plain when nothing is owed", async () => {
    const timeout = new Error("Timeout waiting for transaction commit");
    waitForCommit.mockRejectedValue(timeout);
    const { run } = settle({ notes: [] });
    await expect(run).rejects.toBe(timeout);
  });

  it("waits for commit and relays nothing when nothing is owed", async () => {
    const { client, run } = settle({ notes: [] });
    await run;
    expect(waitForCommit).toHaveBeenCalledTimes(1);
    expect(client.sendPrivateOutputNote).not.toHaveBeenCalled();
  });

  it("reports a note with no full note after the others are delivered", async () => {
    const { client, run } = settle({
      notes: [
        { noteId: "0x1", to: "0xa" },
        { noteId: "0x2", to: "0xa", unavailable: new Error("no full note") },
      ],
    });
    await expect(run).rejects.toMatchObject({
      commitment: "committed",
      delivered: [{ noteId: "0x1", to: "0xa" }],
      undelivered: [{ noteId: "0x2", to: "0xa" }],
      message: expect.stringContaining("no full note"),
    });
    expect(client.sendPrivateOutputNote).toHaveBeenCalledTimes(1);
  });
});
