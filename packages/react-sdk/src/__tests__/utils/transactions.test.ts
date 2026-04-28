import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  waitForTransactionCommit,
  extractFullNotes,
  extractFullNote,
} from "../../utils/transactions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockRecord = {
  id: () => { toHex: () => string };
  transactionStatus: () => {
    isPending: () => boolean;
    isCommitted: () => boolean;
    isDiscarded: () => boolean;
  };
};

const makeRecord = (
  id: string,
  status: "pending" | "committed" | "discarded"
): MockRecord => ({
  id: () => ({ toHex: () => id }),
  transactionStatus: () => ({
    isPending: () => status === "pending",
    isCommitted: () => status === "committed",
    isDiscarded: () => status === "discarded",
  }),
});

const makeClient = (records: MockRecord[]) => ({
  syncState: vi.fn().mockResolvedValue(undefined),
  getTransactions: vi.fn().mockResolvedValue(records),
});

// ---------------------------------------------------------------------------
// waitForTransactionCommit
// ---------------------------------------------------------------------------

describe("waitForTransactionCommit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should resolve immediately when transaction is already committed", async () => {
    const txId = { toString: () => "0xtx", toHex: () => "0xtx" } as any;
    const client = makeClient([makeRecord("0xtx", "committed")]);
    const runExclusive = <T>(fn: () => Promise<T>) => fn();

    await expect(
      waitForTransactionCommit(client, runExclusive, txId, 5_000, 100)
    ).resolves.toBeUndefined();

    expect(client.syncState).toHaveBeenCalledTimes(1);
  });

  it("should throw when transaction is discarded", async () => {
    const txId = { toString: () => "0xtx", toHex: () => "0xtx" } as any;
    const client = makeClient([makeRecord("0xtx", "discarded")]);
    const runExclusive = <T>(fn: () => Promise<T>) => fn();

    await expect(
      waitForTransactionCommit(client, runExclusive, txId, 5_000, 1)
    ).rejects.toThrow("Transaction was discarded before commit");
  });

  it("should poll until committed", async () => {
    const txId = { toString: () => "0xtx", toHex: () => "0xtx" } as any;
    let callCount = 0;
    const client = {
      syncState: vi.fn().mockResolvedValue(undefined),
      getTransactions: vi.fn().mockImplementation(async () => {
        callCount++;
        // Return committed on the 3rd call
        return [makeRecord("0xtx", callCount >= 3 ? "committed" : "pending")];
      }),
    };
    const runExclusive = <T>(fn: () => Promise<T>) => fn();

    await expect(
      waitForTransactionCommit(client, runExclusive, txId, 10_000, 1)
    ).resolves.toBeUndefined();

    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("should throw timeout when no record found within maxWait", async () => {
    const txId = { toString: () => "0xtx", toHex: () => "0xtx" } as any;
    const client = {
      syncState: vi.fn().mockResolvedValue(undefined),
      getTransactions: vi.fn().mockResolvedValue([]), // empty — no matching record
    };
    const runExclusive = <T>(fn: () => Promise<T>) => fn();

    await expect(
      waitForTransactionCommit(client, runExclusive, txId, 5, 1)
    ).rejects.toThrow("Timeout waiting for transaction commit");
  });

  it("should throw timeout when transaction stays pending beyond maxWait", async () => {
    const txId = { toString: () => "0xtx", toHex: () => "0xtx" } as any;
    const client = makeClient([makeRecord("0xtx", "pending")]);
    const runExclusive = <T>(fn: () => Promise<T>) => fn();

    await expect(
      waitForTransactionCommit(client, runExclusive, txId, 5, 1)
    ).rejects.toThrow("Timeout waiting for transaction commit");
  });
});

// ---------------------------------------------------------------------------
// extractFullNotes
// ---------------------------------------------------------------------------

describe("extractFullNotes", () => {
  it("should return empty array for null/undefined txResult", () => {
    expect(extractFullNotes(null)).toEqual([]);
    expect(extractFullNotes(undefined)).toEqual([]);
  });

  it("should return empty array when executedTransaction is missing", () => {
    expect(extractFullNotes({})).toEqual([]);
  });

  it("should return empty array when outputNotes is missing", () => {
    const txResult = {
      executedTransaction: () => ({}),
    };
    expect(extractFullNotes(txResult)).toEqual([]);
  });

  it("should return empty array when notes list is empty", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [],
        }),
      }),
    };
    expect(extractFullNotes(txResult)).toEqual([]);
  });

  it("should extract private notes via intoFull", async () => {
    // NoteType.Private = 2 per the mock in setup.ts
    const PRIVATE = 2;
    const fullNote = { id: () => "0xnote" };
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [
            {
              noteType: () => PRIVATE,
              intoFull: () => fullNote,
            },
          ],
        }),
      }),
    };
    const results = extractFullNotes(txResult);
    expect(results).toEqual([fullNote]);
  });

  it("should skip public notes (noteType !== Private)", () => {
    // NoteType.Public = 1 per the mock in setup.ts
    const PUBLIC = 1;
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [
            {
              noteType: () => PUBLIC,
              intoFull: () => ({ id: () => "0xpublic" }),
            },
          ],
        }),
      }),
    };
    expect(extractFullNotes(txResult)).toEqual([]);
  });

  it("should skip notes where intoFull returns null", () => {
    const PRIVATE = 2;
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [
            {
              noteType: () => PRIVATE,
              intoFull: () => null,
            },
          ],
        }),
      }),
    };
    expect(extractFullNotes(txResult)).toEqual([]);
  });

  it("should return empty array on thrown error", () => {
    const txResult = {
      executedTransaction: () => {
        throw new Error("WASM error");
      },
    };
    expect(extractFullNotes(txResult)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractFullNote
// ---------------------------------------------------------------------------

describe("extractFullNote", () => {
  it("should return null for null/undefined input", () => {
    expect(extractFullNote(null)).toBeNull();
    expect(extractFullNote(undefined)).toBeNull();
  });

  it("should return null when executedTransaction is missing", () => {
    expect(extractFullNote({})).toBeNull();
  });

  it("should return null when notes list is empty", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [],
        }),
      }),
    };
    expect(extractFullNote(txResult)).toBeNull();
  });

  it("should return the first note via intoFull", () => {
    const fullNote = { id: () => "0xnote1" };
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [{ intoFull: () => fullNote }],
        }),
      }),
    };
    expect(extractFullNote(txResult)).toBe(fullNote);
  });

  it("should return null when intoFull returns null", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [{ intoFull: () => null }],
        }),
      }),
    };
    expect(extractFullNote(txResult)).toBeNull();
  });

  it("should return null when intoFull is missing on note", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [{}],
        }),
      }),
    };
    expect(extractFullNote(txResult)).toBeNull();
  });

  it("should return null on thrown error", () => {
    const txResult = {
      executedTransaction: () => {
        throw new Error("boom");
      },
    };
    expect(extractFullNote(txResult)).toBeNull();
  });
});
