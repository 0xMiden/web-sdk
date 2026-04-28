import { describe, it, expect, vi } from "vitest";
import {
  waitForTransactionCommit,
  extractFullNotes,
  extractFullNote,
} from "../../utils/transactions";
import { NoteType } from "@miden-sdk/miden-sdk";

const passthrough = <T>(fn: () => Promise<T>) => fn();

const makeClient = (
  status: "committed" | "pending" | "discarded",
  options: { firstCalls?: number } = {}
) => {
  let calls = 0;
  return {
    syncState: vi.fn().mockResolvedValue(undefined),
    getTransactions: vi.fn().mockImplementation(() => {
      calls += 1;
      // Optionally return no record for the first N calls (to simulate the
      // record showing up later).
      if (options.firstCalls && calls <= options.firstCalls) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          id: () => ({ toHex: () => "0xtx" }),
          transactionStatus: () => ({
            isPending: () => status === "pending",
            isCommitted: () => status === "committed",
            isDiscarded: () => status === "discarded",
          }),
        },
      ]);
    }),
  };
};

describe("waitForTransactionCommit", () => {
  it("resolves immediately when the tx is already committed", async () => {
    const client = makeClient("committed");
    const txId = { toHex: () => "0xtx" } as never;
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 100, 10)
    ).resolves.toBeUndefined();
    expect(client.syncState).toHaveBeenCalledTimes(1);
  });

  it("throws when the tx becomes discarded", async () => {
    const client = makeClient("discarded");
    const txId = { toHex: () => "0xtx" } as never;
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 100, 10)
    ).rejects.toThrow("discarded before commit");
  });

  it("times out when the tx stays pending past maxWaitMs", async () => {
    const client = makeClient("pending");
    const txId = { toHex: () => "0xtx" } as never;
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 30, 10)
    ).rejects.toThrow("Timeout waiting for transaction commit");
  });

  it("polls until the tx record appears, then commits", async () => {
    // First two getTransactions calls return [], third returns committed.
    const client = makeClient("committed", { firstCalls: 2 });
    const txId = { toHex: () => "0xtx" } as never;
    await expect(
      waitForTransactionCommit(client, passthrough, txId, 200, 10)
    ).resolves.toBeUndefined();
    expect(client.getTransactions).toHaveBeenCalledTimes(3);
  });

  it("calls runExclusiveSafe for sync + getTransactions on every tick", async () => {
    const client = makeClient("committed");
    const exclusive = vi.fn(<T>(fn: () => Promise<T>) => fn());
    const txId = { toHex: () => "0xtx" } as never;
    await waitForTransactionCommit(client, exclusive, txId, 50, 10);
    // One sync + one getTransactions per tick; one tick suffices.
    expect(exclusive).toHaveBeenCalledTimes(2);
  });
});

describe("extractFullNotes", () => {
  it("returns [] when the tx result has no executedTransaction", () => {
    expect(extractFullNotes({})).toEqual([]);
  });

  it("returns [] when accessor throws", () => {
    const txResult = {
      executedTransaction: () => {
        throw new Error("boom");
      },
    } as never;
    expect(extractFullNotes(txResult)).toEqual([]);
  });

  it("returns [] when there are no output notes", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [] }),
      }),
    } as never;
    expect(extractFullNotes(txResult)).toEqual([]);
  });

  it("filters only Private notes that intoFull() can resolve", () => {
    const fullPrivate = { kind: "private-note" } as never;
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [
            // Public note — skipped.
            {
              noteType: () => NoteType.Public,
              intoFull: () => ({ kind: "public-note" }),
            },
            // Private note that intoFull resolves.
            {
              noteType: () => NoteType.Private,
              intoFull: () => fullPrivate,
            },
            // Private note where intoFull returns null (also skipped).
            {
              noteType: () => NoteType.Private,
              intoFull: () => null,
            },
          ],
        }),
      }),
    } as never;
    expect(extractFullNotes(txResult)).toEqual([fullPrivate]);
  });
});

describe("extractFullNote", () => {
  it("returns null when there are no notes", () => {
    const txResult = {
      executedTransaction: () => ({ outputNotes: () => ({ notes: () => [] }) }),
    } as never;
    expect(extractFullNote(txResult)).toBeNull();
  });

  it("returns null when the accessor throws", () => {
    const txResult = {
      executedTransaction: () => {
        throw new Error("boom");
      },
    } as never;
    expect(extractFullNote(txResult)).toBeNull();
  });

  it("returns the first note's intoFull() result", () => {
    const note = { kind: "first-note" } as never;
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [
            { intoFull: () => note },
            { intoFull: () => ({ kind: "second-note" }) },
          ],
        }),
      }),
    } as never;
    expect(extractFullNote(txResult)).toBe(note);
  });

  it("returns null when intoFull() returns null", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [{ intoFull: () => null }] }),
      }),
    } as never;
    expect(extractFullNote(txResult)).toBeNull();
  });
});
