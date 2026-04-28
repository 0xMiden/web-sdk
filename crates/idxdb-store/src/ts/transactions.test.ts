import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  getTransactions,
  insertTransactionScript,
  upsertTransactionRecord,
} from "./transactions.js";

let dbCounter = 0;
function uniqueDbName(): string {
  return `test-transactions-${++dbCounter}-${Date.now()}`;
}

const openDbIds: string[] = [];

afterEach(async () => {
  for (const dbId of openDbIds) {
    const db = getDatabase(dbId);
    db.dexie.close();
    await db.dexie.delete();
  }
  openDbIds.length = 0;
});

async function openTestDb(): Promise<string> {
  const name = uniqueDbName();
  await openDatabase(name, "0.1.0");
  openDbIds.push(name);
  return name;
}

// Helper: uint8Array -> base64 (mirrors the source util)
function toBase64(bytes: Uint8Array): string {
  const binary = bytes.reduce((acc, b) => acc + String.fromCharCode(b), "");
  return btoa(binary);
}

describe("transactions", () => {
  let errorSpy: any;
  let logSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // upsertTransactionRecord / getTransactions — basic round-trip
  // -------------------------------------------------------------------------

  it("upserts a transaction and retrieves it with the 'all' filter", async () => {
    const dbId = await openTestDb();
    const details = new Uint8Array([1, 2, 3]);
    const status = new Uint8Array([4, 5, 6]);

    await upsertTransactionRecord(dbId, "tx-1", details, 10, 1, status);

    const results = await getTransactions(dbId, "All");
    expect(results).toHaveLength(1);
    const tx = results![0];
    expect(tx.id).toBe("tx-1");
    expect(tx.blockNum).toBe(10);
    expect(tx.statusVariant).toBe(1);
    expect(tx.details).toBe(toBase64(details));
    expect(tx.status).toBe(toBase64(status));
    expect(tx.scriptRoot).toBeUndefined();
    expect(tx.txScript).toBeUndefined();
  });

  it("upserts a transaction with a scriptRoot and retrieves it with txScript", async () => {
    const dbId = await openTestDb();
    const details = new Uint8Array([10]);
    const status = new Uint8Array([20]);
    const scriptRootBytes = new Uint8Array([0xaa, 0xbb]);
    const txScriptBytes = new Uint8Array([0xcc, 0xdd]);

    // Insert the script first
    await insertTransactionScript(dbId, scriptRootBytes, txScriptBytes);

    // Insert transaction referencing that script root
    await upsertTransactionRecord(
      dbId,
      "tx-with-script",
      details,
      5,
      1,
      status,
      scriptRootBytes
    );

    const results = await getTransactions(dbId, "All");
    expect(results).toHaveLength(1);
    const tx = results![0];
    expect(tx.id).toBe("tx-with-script");
    expect(tx.scriptRoot).toBe(toBase64(scriptRootBytes));
    expect(tx.txScript).toBe(toBase64(txScriptBytes));
  });

  it("upserts a transaction with scriptRoot but no matching script (txScript undefined)", async () => {
    const dbId = await openTestDb();
    const details = new Uint8Array([1]);
    const status = new Uint8Array([2]);
    const scriptRootBytes = new Uint8Array([0x01, 0x02]);

    // Do NOT insert a script — scriptRoot points to nothing
    await upsertTransactionRecord(
      dbId,
      "tx-no-script",
      details,
      7,
      0,
      status,
      scriptRootBytes
    );

    const results = await getTransactions(dbId, "All");
    expect(results).toHaveLength(1);
    const tx = results![0];
    expect(tx.txScript).toBeUndefined();
    expect(tx.scriptRoot).toBe(toBase64(scriptRootBytes));
  });

  it("upsert replaces existing record with same id", async () => {
    const dbId = await openTestDb();
    const details1 = new Uint8Array([1]);
    const details2 = new Uint8Array([99]);
    const status = new Uint8Array([0]);

    await upsertTransactionRecord(dbId, "tx-upsert", details1, 1, 0, status);
    await upsertTransactionRecord(dbId, "tx-upsert", details2, 2, 1, status);

    const results = await getTransactions(dbId, "All");
    expect(results).toHaveLength(1);
    expect(results![0].blockNum).toBe(2);
    expect(results![0].details).toBe(toBase64(details2));
  });

  // -------------------------------------------------------------------------
  // getTransactions — empty result path
  // -------------------------------------------------------------------------

  it("returns empty array when no transactions exist (All filter)", async () => {
    const dbId = await openTestDb();
    const results = await getTransactions(dbId, "All");
    expect(results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // getTransactions — 'Uncommitted' filter (statusVariant === 0)
  // -------------------------------------------------------------------------

  it("Uncommitted filter returns only pending transactions (statusVariant 0)", async () => {
    const dbId = await openTestDb();
    const status = new Uint8Array([0]);

    // pending
    await upsertTransactionRecord(
      dbId,
      "tx-pending",
      new Uint8Array([1]),
      1,
      0 /* STATUS_PENDING_VARIANT */,
      status
    );
    // committed
    await upsertTransactionRecord(
      dbId,
      "tx-committed",
      new Uint8Array([2]),
      2,
      1 /* STATUS_COMMITTED_VARIANT */,
      status
    );
    // discarded
    await upsertTransactionRecord(
      dbId,
      "tx-discarded",
      new Uint8Array([3]),
      3,
      2 /* STATUS_DISCARDED_VARIANT */,
      status
    );

    const results = await getTransactions(dbId, "Uncommitted");
    expect(results).toHaveLength(1);
    expect(results![0].id).toBe("tx-pending");
  });

  it("Uncommitted filter returns empty array when no pending transactions exist", async () => {
    const dbId = await openTestDb();
    await upsertTransactionRecord(
      dbId,
      "tx-committed",
      new Uint8Array([1]),
      1,
      1,
      new Uint8Array([0])
    );

    const results = await getTransactions(dbId, "Uncommitted");
    expect(results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // getTransactions — 'Ids:' filter
  // -------------------------------------------------------------------------

  it("Ids filter returns transactions matching provided ids", async () => {
    const dbId = await openTestDb();
    const status = new Uint8Array([0]);

    await upsertTransactionRecord(
      dbId,
      "tx-a",
      new Uint8Array([1]),
      1,
      1,
      status
    );
    await upsertTransactionRecord(
      dbId,
      "tx-b",
      new Uint8Array([2]),
      2,
      1,
      status
    );
    await upsertTransactionRecord(
      dbId,
      "tx-c",
      new Uint8Array([3]),
      3,
      1,
      status
    );

    const results = await getTransactions(dbId, "Ids:tx-a,tx-c");
    expect(results).toHaveLength(2);
    const ids = results!.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["tx-a", "tx-c"]));
    expect(ids).not.toContain("tx-b");
  });

  it("Ids filter with a single id returns that transaction", async () => {
    const dbId = await openTestDb();
    await upsertTransactionRecord(
      dbId,
      "tx-single",
      new Uint8Array([9]),
      5,
      1,
      new Uint8Array([1])
    );

    const results = await getTransactions(dbId, "Ids:tx-single");
    expect(results).toHaveLength(1);
    expect(results![0].id).toBe("tx-single");
  });

  it("Ids filter returns empty array when none of the ids exist", async () => {
    const dbId = await openTestDb();
    const results = await getTransactions(dbId, "Ids:nonexistent-1,nonexistent-2");
    expect(results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // getTransactions — 'ExpiredPending:' filter
  // -------------------------------------------------------------------------

  it("ExpiredPending filter returns pending txs with blockNum below threshold", async () => {
    const dbId = await openTestDb();
    const status = new Uint8Array([0]);

    // pending, blockNum 5 — should match ExpiredPending:10
    await upsertTransactionRecord(
      dbId,
      "tx-expired-pending",
      new Uint8Array([1]),
      5,
      0 /* pending */,
      status
    );
    // pending, blockNum 15 — above threshold, should NOT match
    await upsertTransactionRecord(
      dbId,
      "tx-fresh-pending",
      new Uint8Array([2]),
      15,
      0 /* pending */,
      status
    );
    // committed, blockNum 5 — committed, should NOT match
    await upsertTransactionRecord(
      dbId,
      "tx-committed",
      new Uint8Array([3]),
      5,
      1 /* committed */,
      status
    );
    // discarded, blockNum 5 — discarded, should NOT match
    await upsertTransactionRecord(
      dbId,
      "tx-discarded",
      new Uint8Array([4]),
      5,
      2 /* discarded */,
      status
    );

    const results = await getTransactions(dbId, "ExpiredPending:10");
    expect(results).toHaveLength(1);
    expect(results![0].id).toBe("tx-expired-pending");
  });

  it("ExpiredPending filter returns empty array when no transactions match", async () => {
    const dbId = await openTestDb();
    // Only committed transactions, none pending
    await upsertTransactionRecord(
      dbId,
      "tx-committed",
      new Uint8Array([1]),
      5,
      1,
      new Uint8Array([0])
    );

    const results = await getTransactions(dbId, "ExpiredPending:100");
    expect(results).toEqual([]);
  });

  it("ExpiredPending filter boundary: blockNum equal to threshold is excluded", async () => {
    const dbId = await openTestDb();
    await upsertTransactionRecord(
      dbId,
      "tx-boundary",
      new Uint8Array([1]),
      10 /* blockNum == threshold */,
      0,
      new Uint8Array([0])
    );

    // filter is strict < blockNum, so blockNum === 10 with threshold 10 is excluded
    const results = await getTransactions(dbId, "ExpiredPending:10");
    expect(results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // insertTransactionScript — round-trip without a transaction context
  // -------------------------------------------------------------------------

  it("insertTransactionScript stores a script retrievable via transactionScripts table", async () => {
    const dbId = await openTestDb();
    const scriptRootBytes = new Uint8Array([0x01, 0x02, 0x03]);
    const txScriptBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    await insertTransactionScript(dbId, scriptRootBytes, txScriptBytes);

    const db = getDatabase(dbId);
    const stored = await db.transactionScripts
      .where("scriptRoot")
      .equals(toBase64(scriptRootBytes))
      .first();

    expect(stored).toBeDefined();
    expect(stored!.scriptRoot).toBe(toBase64(scriptRootBytes));
    expect(stored!.txScript).toEqual(txScriptBytes);
  });

  it("insertTransactionScript upserts on duplicate scriptRoot", async () => {
    const dbId = await openTestDb();
    const scriptRootBytes = new Uint8Array([0xaa]);
    const script1 = new Uint8Array([0x01]);
    const script2 = new Uint8Array([0x02]);

    await insertTransactionScript(dbId, scriptRootBytes, script1);
    await insertTransactionScript(dbId, scriptRootBytes, script2);

    const db = getDatabase(dbId);
    const all = await db.transactionScripts.toArray();
    expect(all).toHaveLength(1);
    expect(all[0].txScript).toEqual(script2);
  });

  // -------------------------------------------------------------------------
  // Error paths — "never-opened" dbId
  // -------------------------------------------------------------------------

  it("getTransactions throws when db is not opened", async () => {
    await expect(
      getTransactions("never-opened", "All")
    ).rejects.toThrow();
  });

  it("upsertTransactionRecord throws when db is not opened", async () => {
    await expect(
      upsertTransactionRecord(
        "never-opened",
        "tx-err",
        new Uint8Array([1]),
        0,
        0,
        new Uint8Array([0])
      )
    ).rejects.toThrow();
  });

  it("insertTransactionScript throws when db is not opened", async () => {
    await expect(
      insertTransactionScript(
        "never-opened",
        new Uint8Array([1]),
        new Uint8Array([2])
      )
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Multiple transactions — verify all are returned by All filter
  // -------------------------------------------------------------------------

  it("returns all transactions when multiple are inserted", async () => {
    const dbId = await openTestDb();
    const status = new Uint8Array([0]);

    await upsertTransactionRecord(
      dbId,
      "multi-1",
      new Uint8Array([1]),
      1,
      0,
      status
    );
    await upsertTransactionRecord(
      dbId,
      "multi-2",
      new Uint8Array([2]),
      2,
      1,
      status
    );
    await upsertTransactionRecord(
      dbId,
      "multi-3",
      new Uint8Array([3]),
      3,
      2,
      status
    );

    const results = await getTransactions(dbId, "All");
    expect(results).toHaveLength(3);
    const ids = results!.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["multi-1", "multi-2", "multi-3"]));
  });
});
