import { afterEach, describe, expect, it } from "vitest";

import {
  getPartialBlockchainPeaksByBlockNum,
  insertBlockHeader,
  insertPartialBlockchainNodes,
  getBlockHeaders,
  getTrackedBlockHeaders,
  getTrackedBlockHeaderNumbers,
  getPartialBlockchainNodesAll,
  getPartialBlockchainNodes,
  getPartialBlockchainNodesUpToInOrderIndex,
  pruneIrrelevantBlocks,
} from "./chainData.js";
import { getDatabase, openDatabase } from "./schema.js";
import { uniqueDbName } from "./test-utils.js";

// Track opened DB ids for per-test cleanup so suites don't leak state into
// each other (fake-indexeddb is process-global).
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

const BLOCK_NUM = 100;
const HEADER_V1 = new Uint8Array([1, 2, 3]);
const HEADER_V2 = new Uint8Array([9, 9, 9]);
const PEAKS_FROM_SYNC = new Uint8Array([10, 11, 12]);
const PEAKS_FROM_BACKFILL = new Uint8Array([99, 98, 97]);

describe("insertBlockHeader: add-if-not-exists semantics", () => {
  it("inserts a brand-new row when none exists (genesis path)", async () => {
    const dbId = await openTestDb();

    await insertBlockHeader(dbId, BLOCK_NUM, HEADER_V1, PEAKS_FROM_SYNC, false);

    const stored = await getDatabase(dbId).blockHeaders.get(BLOCK_NUM);
    expect(stored).toBeDefined();
    expect(stored!.header).toEqual(HEADER_V1);
    expect(stored!.partialBlockchainPeaks).toEqual(PEAKS_FROM_SYNC);
    expect(stored!.hasClientNotes).toBe("false");
  });

  it("does NOT overwrite existing peaks when called a second time for the same block", async () => {
    // This is the core regression test for #2037. `applyStateSync` writes the
    // correct historical peaks first. Later `get_and_store_authenticated_block`
    // calls `insertBlockHeader` with a DIFFERENT peaks payload (peaks for the
    // caller's current PartialMmr forest). The old `put` behavior clobbered
    // the first write; we must keep it.
    const dbId = await openTestDb();

    // Step 1: sync writes correct peaks for block N.
    await insertBlockHeader(dbId, BLOCK_NUM, HEADER_V1, PEAKS_FROM_SYNC, false);

    // Step 2: authenticated-block backfill tries to overwrite with wrong peaks.
    await insertBlockHeader(
      dbId,
      BLOCK_NUM,
      HEADER_V2,
      PEAKS_FROM_BACKFILL,
      true
    );

    // Peaks and header from the first write must still be there.
    const stored = await getDatabase(dbId).blockHeaders.get(BLOCK_NUM);
    expect(stored!.header).toEqual(HEADER_V1);
    expect(stored!.partialBlockchainPeaks).toEqual(PEAKS_FROM_SYNC);

    // The peaks reader uses the same table lookup — double-check it serves the
    // preserved bytes (it base64-encodes them so we decode).
    const peaks = await getPartialBlockchainPeaksByBlockNum(dbId, BLOCK_NUM);
    expect(peaks).toBeDefined();
    const decoded = Uint8Array.from(atob(peaks!.peaks!), (c) =>
      c.charCodeAt(0)
    );
    expect(decoded).toEqual(PEAKS_FROM_SYNC);
  });

  it("upgrades has_client_notes from false to true on a second call (matches SQLite set_block_header_has_client_notes)", async () => {
    // Scenario: block N was synced as irrelevant (hasClientNotes=false).
    // Later a private note with inclusion block N arrives via the transport
    // layer, `get_and_store_authenticated_block` fires with hasClientNotes=true.
    // SQLite does an explicit upgrade after its INSERT OR IGNORE; the IndexedDB
    // path must match or `get_tracked_block_header_numbers` misses this block.
    const dbId = await openTestDb();

    await insertBlockHeader(dbId, BLOCK_NUM, HEADER_V1, PEAKS_FROM_SYNC, false);

    let stored = await getDatabase(dbId).blockHeaders.get(BLOCK_NUM);
    expect(stored!.hasClientNotes).toBe("false");

    // Second insert with hasClientNotes=true.
    await insertBlockHeader(
      dbId,
      BLOCK_NUM,
      HEADER_V2, // (ignored — header stays HEADER_V1)
      PEAKS_FROM_BACKFILL, // (ignored — peaks stay PEAKS_FROM_SYNC)
      true
    );

    stored = await getDatabase(dbId).blockHeaders.get(BLOCK_NUM);
    // Header + peaks preserved...
    expect(stored!.header).toEqual(HEADER_V1);
    expect(stored!.partialBlockchainPeaks).toEqual(PEAKS_FROM_SYNC);
    // ...but has_client_notes upgraded to true.
    expect(stored!.hasClientNotes).toBe("true");
  });

  it("does NOT downgrade has_client_notes from true to false on a second call with false", async () => {
    // Mirror SQLite's semantics: `set_block_header_has_client_notes` only sets
    // the flag to true; there is no downgrade path. Once a block is known to
    // contain a client note, subsequent writes should not flip that back.
    const dbId = await openTestDb();

    await insertBlockHeader(dbId, BLOCK_NUM, HEADER_V1, PEAKS_FROM_SYNC, true);

    await insertBlockHeader(
      dbId,
      BLOCK_NUM,
      HEADER_V2,
      PEAKS_FROM_BACKFILL,
      false
    );

    const stored = await getDatabase(dbId).blockHeaders.get(BLOCK_NUM);
    expect(stored!.hasClientNotes).toBe("true");
  });
});

// ============================================================
// insertPartialBlockchainNodes
// ============================================================
describe("insertPartialBlockchainNodes", () => {
  it("inserts nodes and retrieves them", async () => {
    const dbId = await openTestDb();
    await insertPartialBlockchainNodes(
      dbId,
      ["1", "2", "3"],
      ["0xnode1", "0xnode2", "0xnode3"]
    );
    const db = getDatabase(dbId);
    const all = await db.partialBlockchainNodes.toArray();
    expect(all).toHaveLength(3);
  });

  it("no-ops when ids array is empty", async () => {
    const dbId = await openTestDb();
    await insertPartialBlockchainNodes(dbId, [], []);
    const db = getDatabase(dbId);
    const all = await db.partialBlockchainNodes.toArray();
    expect(all).toHaveLength(0);
  });

  it("rejects when ids and nodes arrays have different lengths", async () => {
    const dbId = await openTestDb();
    // The error is thrown, caught by the catch block, then re-thrown by
    // logWebStoreError — so the outer promise rejects.
    await expect(
      insertPartialBlockchainNodes(dbId, ["1", "2"], ["0xnode1"])
    ).rejects.toThrow("ids and nodes arrays must be of the same length");
  });

  it("overwrites existing nodes on re-insert (bulkPut semantics)", async () => {
    const dbId = await openTestDb();
    await insertPartialBlockchainNodes(dbId, ["1"], ["0xold"]);
    await insertPartialBlockchainNodes(dbId, ["1"], ["0xnew"]);
    const db = getDatabase(dbId);
    const node = await db.partialBlockchainNodes.get(1);
    expect(node!.node).toBe("0xnew");
  });
});

// ============================================================
// getBlockHeaders
// ============================================================
describe("getBlockHeaders", () => {
  it("returns null entries for missing block numbers", async () => {
    const dbId = await openTestDb();
    const results = await getBlockHeaders(dbId, [999]);
    expect(results).toHaveLength(1);
    expect(results![0]).toBeNull();
  });

  it("returns base64-encoded headers for existing blocks", async () => {
    const dbId = await openTestDb();
    await insertBlockHeader(dbId, 1, HEADER_V1, PEAKS_FROM_SYNC, false);
    await insertBlockHeader(dbId, 2, HEADER_V2, PEAKS_FROM_BACKFILL, true);

    const results = await getBlockHeaders(dbId, [1, 2]);
    expect(results).toHaveLength(2);
    expect(results![0]).not.toBeNull();
    expect(results![1]).not.toBeNull();
    expect(results![0]!.blockNum).toBe(1);
    expect(results![1]!.blockNum).toBe(2);
    // Both should be base64 strings
    expect(typeof results![0]!.header).toBe("string");
    expect(results![0]!.hasClientNotes).toBe(false);
    expect(results![1]!.hasClientNotes).toBe(true);
  });

  it("returns empty array for empty block list", async () => {
    const dbId = await openTestDb();
    const results = await getBlockHeaders(dbId, []);
    expect(results).toEqual([]);
  });
});

// ============================================================
// getTrackedBlockHeaders
// ============================================================
describe("getTrackedBlockHeaders", () => {
  it("returns only blocks with hasClientNotes=true", async () => {
    const dbId = await openTestDb();
    await insertBlockHeader(dbId, 10, HEADER_V1, PEAKS_FROM_SYNC, false);
    await insertBlockHeader(dbId, 20, HEADER_V2, PEAKS_FROM_BACKFILL, true);

    const results = await getTrackedBlockHeaders(dbId);
    expect(results).toHaveLength(1);
    expect(results![0].blockNum).toBe(20);
    expect(results![0].hasClientNotes).toBe(true);
    expect(typeof results![0].header).toBe("string");
    expect(typeof results![0].partialBlockchainPeaks).toBe("string");
  });

  it("returns empty array when no tracked blocks", async () => {
    const dbId = await openTestDb();
    await insertBlockHeader(dbId, 10, HEADER_V1, PEAKS_FROM_SYNC, false);
    const results = await getTrackedBlockHeaders(dbId);
    expect(results).toEqual([]);
  });
});

// ============================================================
// getTrackedBlockHeaderNumbers
// ============================================================
describe("getTrackedBlockHeaderNumbers", () => {
  it("returns primary keys of tracked blocks only", async () => {
    const dbId = await openTestDb();
    await insertBlockHeader(dbId, 5, HEADER_V1, PEAKS_FROM_SYNC, true);
    await insertBlockHeader(dbId, 6, HEADER_V2, PEAKS_FROM_BACKFILL, false);
    await insertBlockHeader(dbId, 7, HEADER_V1, PEAKS_FROM_SYNC, true);

    const nums = await getTrackedBlockHeaderNumbers(dbId);
    expect(nums).toHaveLength(2);
    expect(nums).toContain(5);
    expect(nums).toContain(7);
  });

  it("returns empty when no tracked blocks", async () => {
    const dbId = await openTestDb();
    const nums = await getTrackedBlockHeaderNumbers(dbId);
    expect(nums).toEqual([]);
  });
});

// ============================================================
// getPartialBlockchainPeaksByBlockNum
// ============================================================
describe("getPartialBlockchainPeaksByBlockNum", () => {
  it("returns {peaks: undefined} for non-existent block", async () => {
    const dbId = await openTestDb();
    const result = await getPartialBlockchainPeaksByBlockNum(dbId, 999);
    expect(result).toBeDefined();
    expect(result!.peaks).toBeUndefined();
  });

  it("returns base64-encoded peaks for existing block", async () => {
    const dbId = await openTestDb();
    await insertBlockHeader(dbId, 50, HEADER_V1, PEAKS_FROM_SYNC, false);
    const result = await getPartialBlockchainPeaksByBlockNum(dbId, 50);
    expect(result!.peaks).toBeDefined();
    const decoded = Uint8Array.from(atob(result!.peaks!), (c) =>
      c.charCodeAt(0)
    );
    expect(decoded).toEqual(PEAKS_FROM_SYNC);
  });
});

// ============================================================
// getPartialBlockchainNodesAll
// ============================================================
describe("getPartialBlockchainNodesAll", () => {
  it("returns empty array when no nodes", async () => {
    const dbId = await openTestDb();
    const result = await getPartialBlockchainNodesAll(dbId);
    expect(result).toEqual([]);
  });

  it("returns all inserted nodes", async () => {
    const dbId = await openTestDb();
    await insertPartialBlockchainNodes(dbId, ["10", "20"], ["0xa", "0xb"]);
    const result = await getPartialBlockchainNodesAll(dbId);
    expect(result).toHaveLength(2);
  });
});

// ============================================================
// getPartialBlockchainNodes
// ============================================================
describe("getPartialBlockchainNodes", () => {
  it("returns nodes for the given ids, filtering undefined for missing", async () => {
    const dbId = await openTestDb();
    await insertPartialBlockchainNodes(
      dbId,
      ["1", "3"],
      ["0xnode1", "0xnode3"]
    );
    const result = await getPartialBlockchainNodes(dbId, ["1", "2", "3"]);
    // id 2 is missing → filtered out
    expect(result).toHaveLength(2);
    const ids = result!.map((n) => n!.id);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
  });

  it("returns empty array when none of the requested ids exist", async () => {
    const dbId = await openTestDb();
    const result = await getPartialBlockchainNodes(dbId, ["99", "100"]);
    expect(result).toEqual([]);
  });
});

// ============================================================
// getPartialBlockchainNodesUpToInOrderIndex
// ============================================================
describe("getPartialBlockchainNodesUpToInOrderIndex", () => {
  it("returns nodes with id <= maxIndex", async () => {
    const dbId = await openTestDb();
    await insertPartialBlockchainNodes(
      dbId,
      ["1", "2", "3", "4", "5"],
      ["0xa", "0xb", "0xc", "0xd", "0xe"]
    );
    const result = await getPartialBlockchainNodesUpToInOrderIndex(dbId, "3");
    expect(result).toHaveLength(3);
    const ids = result!.map((n) => n.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).not.toContain(4);
  });

  it("returns empty when no nodes exist below threshold", async () => {
    const dbId = await openTestDb();
    await insertPartialBlockchainNodes(dbId, ["10", "20"], ["0xa", "0xb"]);
    const result = await getPartialBlockchainNodesUpToInOrderIndex(dbId, "5");
    expect(result).toEqual([]);
  });
});

// ============================================================
// pruneIrrelevantBlocks
// ============================================================
describe("pruneIrrelevantBlocks", () => {
  it("deletes non-tracked non-sync-height non-genesis blocks", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    // Insert sync height = 10 (default populate gives block 0)
    await db.stateSync.put({ id: 1, blockNum: 10 });

    // Block 0 (genesis), block 5 (irrelevant), block 10 (sync height), block 20 (tracked)
    await insertBlockHeader(dbId, 0, HEADER_V1, PEAKS_FROM_SYNC, false);
    await insertBlockHeader(dbId, 5, HEADER_V1, PEAKS_FROM_SYNC, false); // should be pruned
    await insertBlockHeader(dbId, 10, HEADER_V1, PEAKS_FROM_SYNC, false); // sync height, keep
    await insertBlockHeader(dbId, 20, HEADER_V2, PEAKS_FROM_BACKFILL, true); // tracked, keep

    await pruneIrrelevantBlocks(dbId, [], []);

    const remaining = await db.blockHeaders.toArray();
    const blockNums = remaining.map((r) => r.blockNum);
    expect(blockNums).not.toContain(5);
    expect(blockNums).toContain(0);
    expect(blockNums).toContain(10);
    expect(blockNums).toContain(20);
  });

  it("untracks listed blocks then prunes them", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    await db.stateSync.put({ id: 1, blockNum: 10 });
    await insertBlockHeader(dbId, 0, HEADER_V1, PEAKS_FROM_SYNC, false);
    await insertBlockHeader(dbId, 7, HEADER_V1, PEAKS_FROM_SYNC, true); // tracked, will untrack
    await insertBlockHeader(dbId, 10, HEADER_V1, PEAKS_FROM_SYNC, false);
    await insertBlockHeader(dbId, 20, HEADER_V2, PEAKS_FROM_BACKFILL, true);

    await pruneIrrelevantBlocks(dbId, [7], []);

    const remaining = await db.blockHeaders.toArray();
    const blockNums = remaining.map((r) => r.blockNum);
    expect(blockNums).not.toContain(7); // untracked then pruned
    expect(blockNums).toContain(20); // still tracked
  });

  it("removes listed MMR authentication nodes", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    await db.stateSync.put({ id: 1, blockNum: 10 });
    await insertPartialBlockchainNodes(
      dbId,
      ["1", "2", "3"],
      ["0xa", "0xb", "0xc"]
    );

    await pruneIrrelevantBlocks(dbId, [], ["1", "3"]);

    const nodes = await db.partialBlockchainNodes.toArray();
    const ids = nodes.map((n) => Number(n.id));
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
  });

  it("rejects when stateSync is undefined", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    // Delete the default stateSync entry that was populated by the 'populate' hook
    await db.stateSync.clear();

    // logWebStoreError re-throws, so the promise rejects
    await expect(pruneIrrelevantBlocks(dbId, [], [])).rejects.toThrow(
      "SyncHeight is undefined"
    );
  });
});

// ============================================================
// Error-path coverage: catch blocks call logWebStoreError (re-throws)
// Passing an unregistered dbId exercises the catch body in each function.
// ============================================================
const BAD_DB = "does-not-exist-chaindata";

describe("error paths: unregistered dbId re-throws", () => {
  it("insertBlockHeader rejects on bad dbId", async () => {
    await expect(
      insertBlockHeader(
        BAD_DB,
        1,
        new Uint8Array([1]),
        new Uint8Array([2]),
        false
      )
    ).rejects.toThrow();
  });

  it("insertPartialBlockchainNodes rejects on bad dbId (empty ids are a no-op before db access)", async () => {
    // Non-empty ids will hit getDatabase, which throws
    await expect(
      insertPartialBlockchainNodes(BAD_DB, ["1"], ["0xnode"])
    ).rejects.toThrow();
  });

  it("getBlockHeaders rejects on bad dbId", async () => {
    await expect(getBlockHeaders(BAD_DB, [1])).rejects.toThrow();
  });

  it("getTrackedBlockHeaders rejects on bad dbId", async () => {
    await expect(getTrackedBlockHeaders(BAD_DB)).rejects.toThrow();
  });

  it("getTrackedBlockHeaderNumbers rejects on bad dbId", async () => {
    await expect(getTrackedBlockHeaderNumbers(BAD_DB)).rejects.toThrow();
  });

  it("getPartialBlockchainPeaksByBlockNum rejects on bad dbId", async () => {
    await expect(
      getPartialBlockchainPeaksByBlockNum(BAD_DB, 1)
    ).rejects.toThrow();
  });

  it("getPartialBlockchainNodesAll rejects on bad dbId", async () => {
    await expect(getPartialBlockchainNodesAll(BAD_DB)).rejects.toThrow();
  });

  it("getPartialBlockchainNodes rejects on bad dbId", async () => {
    await expect(getPartialBlockchainNodes(BAD_DB, ["1"])).rejects.toThrow();
  });

  it("getPartialBlockchainNodesUpToInOrderIndex rejects on bad dbId", async () => {
    await expect(
      getPartialBlockchainNodesUpToInOrderIndex(BAD_DB, "5")
    ).rejects.toThrow();
  });

  it("pruneIrrelevantBlocks rejects on bad dbId", async () => {
    await expect(pruneIrrelevantBlocks(BAD_DB, [], [])).rejects.toThrow();
  });
});
