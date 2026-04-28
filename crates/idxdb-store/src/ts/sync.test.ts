import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  getNoteTags,
  getSyncHeight,
  addNoteTag,
  removeNoteTag,
  applyStateSync,
  discardTransactions,
} from "./sync.js";

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

let dbCounter = 0;
function uniqueDbName(): string {
  return `test-sync-${++dbCounter}-${Date.now()}`;
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

// ---------------------------------------------------------------------------
// Minimal applyStateSync builder
// ---------------------------------------------------------------------------

/** A FlattenedU8Vec-compatible object with zero entries. */
function emptyFlattenedVec() {
  return {
    data: () => new Uint8Array(0),
    lengths: () => [] as number[],
  };
}

/** A FlattenedU8Vec holding a single Uint8Array chunk. */
function singleFlattenedVec(chunk: Uint8Array) {
  return {
    data: () => chunk,
    lengths: () => [chunk.length],
  };
}

/** Build a minimal JsStateSyncUpdate that performs only what the test needs. */
function minimalStateUpdate(overrides: Partial<Parameters<typeof applyStateSync>[1]> = {}): Parameters<typeof applyStateSync>[1] {
  return {
    blockNum: 5,
    flattenedNewBlockHeaders: emptyFlattenedVec(),
    flattenedPartialBlockChainPeaks: emptyFlattenedVec(),
    newBlockNums: [],
    blockHasRelevantNotes: new Uint8Array(0),
    serializedNodeIds: [],
    serializedNodes: [],
    committedNoteIds: [],
    serializedInputNotes: [],
    serializedOutputNotes: [],
    accountUpdates: [],
    transactionUpdates: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// describe blocks
// ---------------------------------------------------------------------------

describe("sync", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // getSyncHeight
  // -------------------------------------------------------------------------

  describe("getSyncHeight", () => {
    it("returns blockNum 0 when DB was just created (populate hook seeds record)", async () => {
      const dbId = await openTestDb();
      const result = await getSyncHeight(dbId);
      expect(result).toEqual({ blockNum: 0 });
    });

    it("returns the persisted blockNum after updating stateSync", async () => {
      const dbId = await openTestDb();
      const db = getDatabase(dbId);
      // Manually bump blockNum to verify getSyncHeight reads it back
      await db.stateSync.update(1, { blockNum: 42 });
      const result = await getSyncHeight(dbId);
      expect(result).toEqual({ blockNum: 42 });
    });

    it("returns null when no stateSync record exists (deleted)", async () => {
      const dbId = await openTestDb();
      const db = getDatabase(dbId);
      await db.stateSync.delete(1);
      const result = await getSyncHeight(dbId);
      expect(result).toBeNull();
    });

    it("rejects when db is not opened (logWebStoreError re-throws)", async () => {
      await expect(getSyncHeight("never-opened-sync")).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getNoteTags
  // -------------------------------------------------------------------------

  describe("getNoteTags", () => {
    it("returns an empty array when no tags exist", async () => {
      const dbId = await openTestDb();
      const result = await getNoteTags(dbId);
      expect(result).toEqual([]);
    });

    it("returns tags with sourceNoteId/sourceAccountId populated correctly", async () => {
      const dbId = await openTestDb();
      await addNoteTag(dbId, new Uint8Array([0x01, 0x02]), "note-1", "acct-1");
      const tags = await getNoteTags(dbId);
      expect(tags).toHaveLength(1);
      expect(tags![0].sourceNoteId).toBe("note-1");
      expect(tags![0].sourceAccountId).toBe("acct-1");
    });

    it("converts empty string sourceNoteId to undefined", async () => {
      const dbId = await openTestDb();
      // addNoteTag stores "" when sourceNoteId is falsy; getNoteTags should normalise it back
      const db = getDatabase(dbId);
      await db.tags.add({ tag: toBase64(new Uint8Array([0x0a])), sourceNoteId: "", sourceAccountId: "" });
      const tags = await getNoteTags(dbId);
      expect(tags).toHaveLength(1);
      expect(tags![0].sourceNoteId).toBeUndefined();
      expect(tags![0].sourceAccountId).toBeUndefined();
    });

    it("returns multiple tags in insertion order", async () => {
      const dbId = await openTestDb();
      await addNoteTag(dbId, new Uint8Array([0x01]), "note-a", "acct-a");
      await addNoteTag(dbId, new Uint8Array([0x02]), "note-b", "acct-b");
      const tags = await getNoteTags(dbId);
      expect(tags).toHaveLength(2);
    });

    it("rejects when db is not opened (logWebStoreError re-throws)", async () => {
      await expect(getNoteTags("never-opened-sync")).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // addNoteTag
  // -------------------------------------------------------------------------

  describe("addNoteTag", () => {
    it("adds a tag with both sourceNoteId and sourceAccountId", async () => {
      const dbId = await openTestDb();
      const tagBytes = new Uint8Array([0xde, 0xad]);
      await addNoteTag(dbId, tagBytes, "note-1", "acct-1");

      const db = getDatabase(dbId);
      const stored = await db.tags.toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0].tag).toBe(toBase64(tagBytes));
      expect(stored[0].sourceNoteId).toBe("note-1");
      expect(stored[0].sourceAccountId).toBe("acct-1");
    });

    it("stores empty string when sourceNoteId is falsy", async () => {
      const dbId = await openTestDb();
      await addNoteTag(dbId, new Uint8Array([0x01]), "", "");

      const db = getDatabase(dbId);
      const stored = await db.tags.toArray();
      expect(stored[0].sourceNoteId).toBe("");
      expect(stored[0].sourceAccountId).toBe("");
    });

    it("rejects when db is not opened (logWebStoreError re-throws)", async () => {
      await expect(addNoteTag("never-opened-sync", new Uint8Array([1]), "n", "a")).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // removeNoteTag
  // -------------------------------------------------------------------------

  describe("removeNoteTag", () => {
    it("removes the matching tag and returns delete count 1", async () => {
      const dbId = await openTestDb();
      const tagBytes = new Uint8Array([0xab]);
      await addNoteTag(dbId, tagBytes, "note-x", "acct-x");

      const deleted = await removeNoteTag(dbId, tagBytes, "note-x", "acct-x");
      expect(deleted).toBe(1);

      const db = getDatabase(dbId);
      expect(await db.tags.count()).toBe(0);
    });

    it("returns 0 when no matching tag exists", async () => {
      const dbId = await openTestDb();
      const deleted = await removeNoteTag(dbId, new Uint8Array([0xff]), "no-such-note");
      expect(deleted).toBe(0);
    });

    it("only removes the matching tag, leaving others intact", async () => {
      const dbId = await openTestDb();
      await addNoteTag(dbId, new Uint8Array([0x01]), "note-1", "acct-1");
      await addNoteTag(dbId, new Uint8Array([0x02]), "note-2", "acct-2");

      await removeNoteTag(dbId, new Uint8Array([0x01]), "note-1", "acct-1");

      const db = getDatabase(dbId);
      const remaining = await db.tags.toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sourceNoteId).toBe("note-2");
    });

    it("uses empty string for sourceNoteId/sourceAccountId when undefined is passed", async () => {
      const dbId = await openTestDb();
      // Add tag with empty sourceNoteId/sourceAccountId
      await addNoteTag(dbId, new Uint8Array([0x05]), "", "");
      // Remove using undefined — internally converts to ""
      const deleted = await removeNoteTag(dbId, new Uint8Array([0x05]), undefined, undefined);
      expect(deleted).toBe(1);
    });

    it("rejects when db is not opened (logWebStoreError re-throws)", async () => {
      await expect(removeNoteTag("never-opened-sync", new Uint8Array([1]))).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // discardTransactions
  // -------------------------------------------------------------------------

  describe("discardTransactions", () => {
    it("removes transactions matching the provided ids", async () => {
      const dbId = await openTestDb();
      const db = getDatabase(dbId);
      const status = new Uint8Array([0]);
      await db.transactions.put({ id: "tx-1", details: new Uint8Array([1]), blockNum: 1, statusVariant: 0, status });
      await db.transactions.put({ id: "tx-2", details: new Uint8Array([2]), blockNum: 2, statusVariant: 0, status });
      await db.transactions.put({ id: "tx-3", details: new Uint8Array([3]), blockNum: 3, statusVariant: 0, status });

      await discardTransactions(dbId, ["tx-1", "tx-3"]);

      const remaining = await db.transactions.toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("tx-2");
    });

    it("is a no-op when the ids array is empty", async () => {
      const dbId = await openTestDb();
      const db = getDatabase(dbId);
      const status = new Uint8Array([0]);
      await db.transactions.put({ id: "tx-keep", details: new Uint8Array([1]), blockNum: 1, statusVariant: 0, status });

      await discardTransactions(dbId, []);

      const remaining = await db.transactions.toArray();
      expect(remaining).toHaveLength(1);
    });

    it("is a no-op when none of the ids exist", async () => {
      const dbId = await openTestDb();
      const db = getDatabase(dbId);
      await db.transactions.put({ id: "tx-1", details: new Uint8Array([1]), blockNum: 1, statusVariant: 0, status: new Uint8Array([0]) });

      await discardTransactions(dbId, ["nonexistent"]);
      const remaining = await db.transactions.toArray();
      expect(remaining).toHaveLength(1);
    });

    it("rejects when db is not opened (logWebStoreError re-throws)", async () => {
      await expect(discardTransactions("never-opened-sync", ["tx-1"])).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // applyStateSync — sync height update
  // -------------------------------------------------------------------------

  describe("applyStateSync — sync height", () => {
    it("updates sync height to the given blockNum", async () => {
      const dbId = await openTestDb();
      await applyStateSync(dbId, minimalStateUpdate({ blockNum: 10 }));
      const result = await getSyncHeight(dbId);
      expect(result).toEqual({ blockNum: 10 });
    });

    it("does not regress sync height when a lower blockNum is applied", async () => {
      const dbId = await openTestDb();
      // First advance to 20
      await applyStateSync(dbId, minimalStateUpdate({ blockNum: 20 }));
      // Then apply a lower blockNum — should not overwrite
      await applyStateSync(dbId, minimalStateUpdate({ blockNum: 5 }));
      const result = await getSyncHeight(dbId);
      expect(result).toEqual({ blockNum: 20 });
    });

    it("advances sync height when a higher blockNum is applied", async () => {
      const dbId = await openTestDb();
      await applyStateSync(dbId, minimalStateUpdate({ blockNum: 10 }));
      await applyStateSync(dbId, minimalStateUpdate({ blockNum: 30 }));
      const result = await getSyncHeight(dbId);
      expect(result).toEqual({ blockNum: 30 });
    });
  });

  // -------------------------------------------------------------------------
  // applyStateSync — block headers
  // -------------------------------------------------------------------------

  describe("applyStateSync — block headers", () => {
    it("inserts a new block header during sync", async () => {
      const dbId = await openTestDb();
      const headerBytes = new Uint8Array([0x10, 0x20]);
      const peaksBytes = new Uint8Array([0x30, 0x40]);

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 7,
        newBlockNums: [7],
        blockHasRelevantNotes: new Uint8Array([0]),
        flattenedNewBlockHeaders: singleFlattenedVec(headerBytes),
        flattenedPartialBlockChainPeaks: singleFlattenedVec(peaksBytes),
      }));

      const db = getDatabase(dbId);
      const header = await db.blockHeaders.get(7);
      expect(header).toBeDefined();
      expect(header!.blockNum).toBe(7);
      expect(header!.hasClientNotes).toBe("false");
    });

    it("marks block header hasClientNotes=true when blockHasRelevantNotes[i] === 1", async () => {
      const dbId = await openTestDb();
      const headerBytes = new Uint8Array([0xaa]);
      const peaksBytes = new Uint8Array([0xbb]);

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 15,
        newBlockNums: [15],
        blockHasRelevantNotes: new Uint8Array([1]),
        flattenedNewBlockHeaders: singleFlattenedVec(headerBytes),
        flattenedPartialBlockChainPeaks: singleFlattenedVec(peaksBytes),
      }));

      const db = getDatabase(dbId);
      const header = await db.blockHeaders.get(15);
      expect(header!.hasClientNotes).toBe("true");
    });

    it("does not overwrite an existing block header", async () => {
      const dbId = await openTestDb();
      const original = new Uint8Array([0x01]);
      const replacement = new Uint8Array([0xff]);
      const peaks = new Uint8Array([0x00]);

      // Insert block header 5 first time
      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        newBlockNums: [5],
        blockHasRelevantNotes: new Uint8Array([0]),
        flattenedNewBlockHeaders: singleFlattenedVec(original),
        flattenedPartialBlockChainPeaks: singleFlattenedVec(peaks),
      }));

      // Try to insert same block num with different data — should be skipped
      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 6,
        newBlockNums: [5],
        blockHasRelevantNotes: new Uint8Array([0]),
        flattenedNewBlockHeaders: singleFlattenedVec(replacement),
        flattenedPartialBlockChainPeaks: singleFlattenedVec(peaks),
      }));

      const db = getDatabase(dbId);
      const header = await db.blockHeaders.get(5);
      expect(header!.header).toEqual(original);
    });

    it("handles zero block headers (empty newBlockNums)", async () => {
      const dbId = await openTestDb();
      // No block headers — should complete without error
      await applyStateSync(dbId, minimalStateUpdate({ blockNum: 3 }));
      const result = await getSyncHeight(dbId);
      expect(result).toEqual({ blockNum: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // applyStateSync — partial blockchain nodes
  // -------------------------------------------------------------------------

  describe("applyStateSync — partial blockchain nodes", () => {
    it("inserts partial blockchain nodes", async () => {
      const dbId = await openTestDb();
      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 1,
        serializedNodeIds: ["42"],
        serializedNodes: ["node-data-42"],
      }));

      const db = getDatabase(dbId);
      const node = await db.partialBlockchainNodes.get(42);
      expect(node).toBeDefined();
      expect(node!.node).toBe("node-data-42");
    });

    it("overwrites an existing partial blockchain node (bulkPut)", async () => {
      const dbId = await openTestDb();

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 1,
        serializedNodeIds: ["10"],
        serializedNodes: ["first-data"],
      }));
      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 2,
        serializedNodeIds: ["10"],
        serializedNodes: ["second-data"],
      }));

      const db = getDatabase(dbId);
      const node = await db.partialBlockchainNodes.get(10);
      expect(node!.node).toBe("second-data");
    });

    it("is a no-op when serializedNodeIds is empty", async () => {
      const dbId = await openTestDb();
      // Should complete without error
      await applyStateSync(dbId, minimalStateUpdate({ blockNum: 1, serializedNodeIds: [], serializedNodes: [] }));
      const db = getDatabase(dbId);
      expect(await db.partialBlockchainNodes.count()).toBe(0);
    });

    it("rejects when nodeIndexes and nodes arrays have different lengths", async () => {
      const dbId = await openTestDb();
      // Mismatched arrays — error thrown inside Dexie transaction, aborts tx and rejects
      await expect(
        applyStateSync(dbId, minimalStateUpdate({
          blockNum: 1,
          serializedNodeIds: ["1", "2"],
          serializedNodes: ["only-one"],
        }))
      ).rejects.toThrow("nodeIndexes and nodes arrays must be of the same length");
    });
  });

  // -------------------------------------------------------------------------
  // applyStateSync — committed note tags
  // -------------------------------------------------------------------------

  describe("applyStateSync — committed note tags (updateCommittedNoteTags)", () => {
    it("removes tags whose sourceNoteId matches a committedNoteId", async () => {
      const dbId = await openTestDb();
      // Add a tag that is associated with note-A
      await addNoteTag(dbId, new Uint8Array([0x01]), "note-A", "acct-1");
      // Add a tag associated with note-B (should survive)
      await addNoteTag(dbId, new Uint8Array([0x02]), "note-B", "acct-2");

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 1,
        committedNoteIds: ["note-A"],
      }));

      const tags = await getNoteTags(dbId);
      expect(tags).toHaveLength(1);
      expect(tags![0].sourceNoteId).toBe("note-B");
    });

    it("is a no-op when committedNoteIds is empty", async () => {
      const dbId = await openTestDb();
      await addNoteTag(dbId, new Uint8Array([0x01]), "note-A", "acct-1");

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 1,
        committedNoteIds: [],
      }));

      const tags = await getNoteTags(dbId);
      expect(tags).toHaveLength(1);
    });

    it("removes all tags for multiple committedNoteIds", async () => {
      const dbId = await openTestDb();
      await addNoteTag(dbId, new Uint8Array([0x01]), "note-A", "acct-1");
      await addNoteTag(dbId, new Uint8Array([0x02]), "note-B", "acct-2");
      await addNoteTag(dbId, new Uint8Array([0x03]), "note-C", "acct-3");

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 1,
        committedNoteIds: ["note-A", "note-B"],
      }));

      const tags = await getNoteTags(dbId);
      expect(tags).toHaveLength(1);
      expect(tags![0].sourceNoteId).toBe("note-C");
    });
  });

  // -------------------------------------------------------------------------
  // applyStateSync — transaction updates
  // -------------------------------------------------------------------------

  describe("applyStateSync — transaction updates", () => {
    it("upserts a transaction record without a script", async () => {
      const dbId = await openTestDb();
      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        transactionUpdates: [{
          id: "tx-sync-1",
          details: new Uint8Array([1, 2, 3]),
          blockNum: 5,
          statusVariant: 1,
          status: new Uint8Array([4, 5, 6]),
          scriptRoot: undefined,
          txScript: undefined,
        }],
      }));

      const db = getDatabase(dbId);
      const tx = await db.transactions.where("id").equals("tx-sync-1").first();
      expect(tx).toBeDefined();
      expect(tx!.blockNum).toBe(5);
      expect(tx!.statusVariant).toBe(1);
    });

    it("upserts a transaction record WITH a script when both scriptRoot and txScript are provided", async () => {
      const dbId = await openTestDb();
      const scriptRootBytes = new Uint8Array([0xca, 0xfe]);
      const txScriptBytes = new Uint8Array([0xba, 0xbe]);

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        transactionUpdates: [{
          id: "tx-with-script",
          details: new Uint8Array([1]),
          blockNum: 5,
          statusVariant: 1,
          status: new Uint8Array([0]),
          scriptRoot: scriptRootBytes,
          txScript: txScriptBytes,
        }],
      }));

      const db = getDatabase(dbId);
      const script = await db.transactionScripts.where("scriptRoot").equals(toBase64(scriptRootBytes)).first();
      expect(script).toBeDefined();
      expect(script!.txScript).toEqual(txScriptBytes);
    });

    it("does NOT insert a script when txScript is absent (scriptRoot only)", async () => {
      const dbId = await openTestDb();
      const scriptRootBytes = new Uint8Array([0x11]);

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        transactionUpdates: [{
          id: "tx-script-root-only",
          details: new Uint8Array([1]),
          blockNum: 5,
          statusVariant: 1,
          status: new Uint8Array([0]),
          scriptRoot: scriptRootBytes,
          txScript: undefined,
        }],
      }));

      const db = getDatabase(dbId);
      // Script should not exist since txScript was absent
      const scripts = await db.transactionScripts.toArray();
      expect(scripts).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // applyStateSync — output notes
  // -------------------------------------------------------------------------

  describe("applyStateSync — output notes", () => {
    it("upserts an output note during sync", async () => {
      const dbId = await openTestDb();

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        serializedOutputNotes: [{
          noteId: "out-note-1",
          noteAssets: new Uint8Array([0x01, 0x02]),
          recipientDigest: "recipient-digest-abc",
          metadata: new Uint8Array([0x03, 0x04]),
          nullifier: undefined,
          expectedHeight: 100,
          stateDiscriminant: 1,
          state: new Uint8Array([0x05]),
        }],
      }));

      const db = getDatabase(dbId);
      const note = await db.outputNotes.where("noteId").equals("out-note-1").first();
      expect(note).toBeDefined();
      expect(note!.recipientDigest).toBe("recipient-digest-abc");
      expect(note!.expectedHeight).toBe(100);
      expect(note!.stateDiscriminant).toBe(1);
    });

    it("upserts multiple output notes in one sync call", async () => {
      const dbId = await openTestDb();

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        serializedOutputNotes: [
          {
            noteId: "out-a",
            noteAssets: new Uint8Array([0x01]),
            recipientDigest: "digest-a",
            metadata: new Uint8Array([0x02]),
            nullifier: "null-a",
            expectedHeight: 10,
            stateDiscriminant: 2,
            state: new Uint8Array([0x03]),
          },
          {
            noteId: "out-b",
            noteAssets: new Uint8Array([0x04]),
            recipientDigest: "digest-b",
            metadata: new Uint8Array([0x05]),
            nullifier: undefined,
            expectedHeight: 20,
            stateDiscriminant: 3,
            state: new Uint8Array([0x06]),
          },
        ],
      }));

      const db = getDatabase(dbId);
      const notes = await db.outputNotes.toArray();
      expect(notes).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // applyStateSync — input notes
  // -------------------------------------------------------------------------

  describe("applyStateSync — input notes", () => {
    it("upserts an input note during sync", async () => {
      const dbId = await openTestDb();

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        serializedInputNotes: [{
          noteId: "in-note-1",
          noteAssets: new Uint8Array([0x0a]),
          serialNumber: new Uint8Array([0x0b]),
          inputs: new Uint8Array([0x0c]),
          noteScriptRoot: "script-root-in",
          noteScript: new Uint8Array([0x0d]),
          nullifier: "nullifier-in-1",
          createdAt: "100",
          stateDiscriminant: 2,
          state: new Uint8Array([0x0e]),
          consumedBlockHeight: undefined,
          consumedTxOrder: undefined,
          consumerAccountId: undefined,
        }],
      }));

      const db = getDatabase(dbId);
      const note = await db.inputNotes.where("noteId").equals("in-note-1").first();
      expect(note).toBeDefined();
      expect(note!.nullifier).toBe("nullifier-in-1");
      expect(note!.stateDiscriminant).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // applyStateSync — account updates
  // -------------------------------------------------------------------------

  describe("applyStateSync — account updates", () => {
    it("applies a full account state during sync", async () => {
      const dbId = await openTestDb();

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        accountUpdates: [{
          accountId: "acct-sync-1",
          nonce: "1",
          storageRoot: "storage-root-1",
          storageSlots: [],
          storageMapEntries: [],
          vaultRoot: "vault-root-1",
          assets: [],
          codeRoot: "code-root-1",
          committed: true,
          accountCommitment: "commitment-1",
          accountSeed: undefined,
        }],
      }));

      const db = getDatabase(dbId);
      const account = await db.latestAccountHeaders.where("id").equals("acct-sync-1").first();
      expect(account).toBeDefined();
      expect(account!.nonce).toBe("1");
      expect(account!.committed).toBe(true);
      expect(account!.codeRoot).toBe("code-root-1");
    });

    it("applies multiple account updates in one sync call", async () => {
      const dbId = await openTestDb();

      await applyStateSync(dbId, minimalStateUpdate({
        blockNum: 5,
        accountUpdates: [
          {
            accountId: "acct-sync-A",
            nonce: "1",
            storageRoot: "sr-A",
            storageSlots: [],
            storageMapEntries: [],
            vaultRoot: "vr-A",
            assets: [],
            codeRoot: "cr-A",
            committed: true,
            accountCommitment: "com-A",
            accountSeed: undefined,
          },
          {
            accountId: "acct-sync-B",
            nonce: "2",
            storageRoot: "sr-B",
            storageSlots: [],
            storageMapEntries: [],
            vaultRoot: "vr-B",
            assets: [],
            codeRoot: "cr-B",
            committed: false,
            accountCommitment: "com-B",
            accountSeed: new Uint8Array([0xca, 0xfe]),
          },
        ],
      }));

      const db = getDatabase(dbId);
      const all = await db.latestAccountHeaders.toArray();
      const ids = all.map((a) => a.id);
      expect(ids).toContain("acct-sync-A");
      expect(ids).toContain("acct-sync-B");
    });
  });
});
