import { describe, it, expect, afterEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  upsertInputNote,
  upsertOutputNote,
  upsertNoteScript,
  getInputNoteByOffset,
  getInputNotes,
  getInputNotesFromIds,
  getInputNotesFromNullifiers,
  getOutputNotes,
  getOutputNotesFromIds,
  getOutputNotesFromNullifiers,
  getUnspentInputNoteNullifiers,
  getNoteScript,
} from "./notes.js";

// Unique DB names to avoid collisions between tests.
let dbCounter = 0;
function uniqueDbName(): string {
  return `test-notes-${++dbCounter}-${Date.now()}`;
}

// Track DB IDs for cleanup.
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

// Consumed state discriminants (must match InputNoteState constants on the Rust side).
const STATE_CONSUMED_AUTHENTICATED_LOCAL = 6;
const STATE_CONSUMED_UNAUTHENTICATED_LOCAL = 7;
const STATE_CONSUMED_EXTERNAL = 8;
const STATE_EXPECTED = 0;

const CONSUMED_STATES = new Uint8Array([
  STATE_CONSUMED_AUTHENTICATED_LOCAL,
  STATE_CONSUMED_UNAUTHENTICATED_LOCAL,
  STATE_CONSUMED_EXTERNAL,
]);

// Unspent state discriminants (stateDiscriminant 2, 4, 5)
const STATE_COMMITTED = 2;
const STATE_PROCESSING_AUTHENTICATED = 4;
const STATE_PROCESSING_UNAUTHENTICATED = 5;

const DUMMY_BYTES = new Uint8Array([1, 2, 3]);
const DUMMY_SCRIPT_ROOT = "script-root-1";

/**
 * Insert a minimal input note with consumption metadata.
 * The noteId is stored in the `createdAt` field so we can recover it from the
 * processed (base64-encoded) output of `getInputNoteByOffset`.
 */
async function insertNote(
  dbId: string,
  noteId: string,
  opts: {
    stateDiscriminant?: number;
    consumedBlockHeight?: number;
    consumedTxOrder?: number;
    consumerAccountId?: string;
    scriptRoot?: string;
    nullifier?: string;
  } = {}
) {
  await upsertInputNote(
    dbId,
    noteId,
    DUMMY_BYTES,
    DUMMY_BYTES,
    DUMMY_BYTES,
    opts.scriptRoot ?? DUMMY_SCRIPT_ROOT,
    DUMMY_BYTES,
    opts.nullifier ?? `nullifier-${noteId}`,
    noteId, // store noteId as createdAt so we can read it back from processed output
    opts.stateDiscriminant ?? STATE_CONSUMED_EXTERNAL,
    DUMMY_BYTES,
    opts.consumedBlockHeight,
    opts.consumedTxOrder,
    opts.consumerAccountId
  );
}

/**
 * Iterate through all notes using `getInputNoteByOffset`, collecting noteIds
 * from the actual function output. The noteId is recovered from the `createdAt`
 * field of the processed result (where we stored it during insertion).
 */
async function collectAllNoteIds(
  dbId: string,
  states: Uint8Array,
  consumer?: string,
  blockStart?: number,
  blockEnd?: number
): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await getInputNoteByOffset(
      dbId,
      states,
      consumer,
      blockStart,
      blockEnd,
      offset
    );
    if (!result || result.length === 0) break;
    // createdAt holds the noteId (see insertNote)
    ids.push(result[0].createdAt);
    offset++;
  }

  return ids;
}

// ORDERING TESTS
// ================================================================================================

describe("getInputNoteByOffset ordering", () => {
  it("returns notes ordered by block height", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-b3", {
      consumedBlockHeight: 3,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-b1", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-b2", {
      consumedBlockHeight: 2,
      consumedTxOrder: 0,
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES);
    expect(ids).toEqual(["note-b1", "note-b2", "note-b3"]);
  });

  it("returns notes ordered by tx order within same block", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-tx2", {
      consumedBlockHeight: 5,
      consumedTxOrder: 2,
    });
    await insertNote(dbId, "note-tx0", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-tx1", {
      consumedBlockHeight: 5,
      consumedTxOrder: 1,
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES);
    expect(ids).toEqual(["note-tx0", "note-tx1", "note-tx2"]);
  });

  it("sorts null tx order last within same block (fallback path)", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-ordered", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-unordered", {
      consumedBlockHeight: 5,
      // no consumedTxOrder
    });

    // No consumer -> fallback path that includes null tx_order notes
    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES);
    expect(ids).toEqual(["note-ordered", "note-unordered"]);
  });

  it("uses noteId as tiebreaker for same block and tx order", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-c", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-a", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-b", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES);
    expect(ids).toEqual(["note-a", "note-b", "note-c"]);
  });
});

// CONSUMER FILTER TESTS
// ================================================================================================

describe("getInputNoteByOffset consumer filtering", () => {
  it("filters by consumer account", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-alice-1", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
      consumerAccountId: "0xalice",
    });
    await insertNote(dbId, "note-bob", {
      consumedBlockHeight: 1,
      consumedTxOrder: 1,
      consumerAccountId: "0xbob",
    });
    await insertNote(dbId, "note-alice-2", {
      consumedBlockHeight: 2,
      consumedTxOrder: 0,
      consumerAccountId: "0xalice",
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, "0xalice");
    expect(ids).toEqual(["note-alice-1", "note-alice-2"]);
  });

  it("excludes notes without tx order when consumer is set", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-with-order", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
      consumerAccountId: "0xalice",
    });
    await insertNote(dbId, "note-without-order", {
      consumedBlockHeight: 1,
      // no consumedTxOrder — won't appear in compound index
      consumerAccountId: "0xalice",
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, "0xalice");
    // Only the note with tx_order should be returned (cursor path uses compound index).
    expect(ids).toEqual(["note-with-order"]);
  });
});

// BLOCK RANGE FILTER TESTS
// ================================================================================================

describe("getInputNoteByOffset block range filtering", () => {
  it("filters by block range", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-b1", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-b3", {
      consumedBlockHeight: 3,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-b5", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-b7", {
      consumedBlockHeight: 7,
      consumedTxOrder: 0,
    });

    // Block range 3..=5
    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, undefined, 3, 5);
    expect(ids).toEqual(["note-b3", "note-b5"]);
  });

  it("filters by consumer and block range combined", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "alice-b1", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
      consumerAccountId: "0xalice",
    });
    await insertNote(dbId, "alice-b3", {
      consumedBlockHeight: 3,
      consumedTxOrder: 0,
      consumerAccountId: "0xalice",
    });
    await insertNote(dbId, "bob-b3", {
      consumedBlockHeight: 3,
      consumedTxOrder: 1,
      consumerAccountId: "0xbob",
    });
    await insertNote(dbId, "alice-b5", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
      consumerAccountId: "0xalice",
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, "0xalice", 3, 5);
    expect(ids).toEqual(["alice-b3", "alice-b5"]);
  });
});

describe("getInputNoteByOffset unordered-filter branches", () => {
  it("excludes unordered notes with null consumedBlockHeight when blockStart is set", async () => {
    // Exercises the `consumedBlockHeight == null` branch in the unordered filter
    // (line 218 of notes.ts: blockStart != null && (consumedBlockHeight == null || ...))
    const dbId = await openTestDb();

    await insertNote(dbId, "note-ordered-b5", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
    });
    // Unordered note with null consumedBlockHeight — should be excluded by blockStart filter
    await insertNote(dbId, "note-unordered-no-height", {
      // no consumedBlockHeight — null
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, undefined, 3, undefined);
    expect(ids).toContain("note-ordered-b5");
    expect(ids).not.toContain("note-unordered-no-height");
  });

  it("excludes unordered notes with null consumedBlockHeight when blockEnd is set", async () => {
    // Exercises the `consumedBlockHeight == null` branch in the unordered filter
    // (line 220 of notes.ts: blockEnd != null && (consumedBlockHeight == null || ...))
    const dbId = await openTestDb();

    await insertNote(dbId, "note-ordered-b5", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-unordered-no-height-2", {
      // no consumedBlockHeight — null
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, undefined, undefined, 10);
    expect(ids).toContain("note-ordered-b5");
    expect(ids).not.toContain("note-unordered-no-height-2");
  });

  it("excludes unordered notes with consumerAccountId != undefined (line 217 branch)", async () => {
    // In the unordered path, consumerAccountId filter is undefined. If a note has
    // a non-undefined consumerAccountId, it should be excluded via line 217.
    const dbId = await openTestDb();

    await insertNote(dbId, "note-no-tx-with-consumer", {
      consumerAccountId: "0xsomeconsumer",
      consumedBlockHeight: 5,
      // no consumedTxOrder — so not in compound index
    });

    // Query with no consumer (undefined) — the unordered filter line 217 excludes
    // notes with a different consumerAccountId
    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES);
    expect(ids).not.toContain("note-no-tx-with-consumer");
  });
});

// STATE FILTER TESTS
// ================================================================================================

describe("getInputNoteByOffset state filtering", () => {
  it("skips non-consumed notes", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "consumed", {
      stateDiscriminant: STATE_CONSUMED_EXTERNAL,
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "expected", {
      stateDiscriminant: STATE_EXPECTED,
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES);
    expect(ids).toEqual(["consumed"]);
  });

  it("returns empty when no notes match", async () => {
    const dbId = await openTestDb();

    const result = await getInputNoteByOffset(
      dbId,
      CONSUMED_STATES,
      undefined,
      undefined,
      undefined,
      0
    );
    expect(result).toEqual([]);
  });
});

// ================================================================================================
// getInputNotes
// ================================================================================================

describe("getInputNotes", () => {
  it("returns all notes when states is empty", async () => {
    const dbId = await openTestDb();
    await insertNote(dbId, "n1", { stateDiscriminant: STATE_CONSUMED_EXTERNAL, consumedBlockHeight: 1 });
    await insertNote(dbId, "n2", { stateDiscriminant: STATE_EXPECTED });
    const result = await getInputNotes(dbId, new Uint8Array([]));
    expect(result).toHaveLength(2);
  });

  it("filters by state discriminants when non-empty", async () => {
    const dbId = await openTestDb();
    await insertNote(dbId, "n-consumed", { stateDiscriminant: STATE_CONSUMED_EXTERNAL, consumedBlockHeight: 1 });
    await insertNote(dbId, "n-expected", { stateDiscriminant: STATE_EXPECTED });
    const result = await getInputNotes(dbId, new Uint8Array([STATE_CONSUMED_EXTERNAL]));
    expect(result).toHaveLength(1);
    // createdAt holds the noteId
    expect(result![0].createdAt).toBe("n-consumed");
  });

  it("returns empty array when no notes exist", async () => {
    const dbId = await openTestDb();
    const result = await getInputNotes(dbId, new Uint8Array([]));
    expect(result).toEqual([]);
  });

  it("includes note script in processed result when available", async () => {
    const dbId = await openTestDb();
    const SCRIPT_ROOT = "my-script-root";
    await insertNote(dbId, "note-with-script", {
      stateDiscriminant: STATE_CONSUMED_EXTERNAL,
      consumedBlockHeight: 1,
      scriptRoot: SCRIPT_ROOT,
    });
    const result = await getInputNotes(dbId, new Uint8Array([STATE_CONSUMED_EXTERNAL]));
    expect(result).toHaveLength(1);
    // Script was inserted via upsertInputNote → notesScripts table
    expect(result![0].serializedNoteScript).toBeDefined();
    expect(typeof result![0].serializedNoteScript).toBe("string");
  });

  it("returns undefined for serializedNoteScript when script root is empty", async () => {
    const dbId = await openTestDb();
    // Insert with empty scriptRoot
    await upsertInputNote(
      dbId,
      "note-no-script",
      DUMMY_BYTES, DUMMY_BYTES, DUMMY_BYTES,
      "", // empty script root
      DUMMY_BYTES,
      "null-nullifier",
      "note-no-script",
      STATE_CONSUMED_EXTERNAL,
      DUMMY_BYTES,
      1, 0, undefined
    );
    const result = await getInputNotes(dbId, new Uint8Array([STATE_CONSUMED_EXTERNAL]));
    expect(result).toHaveLength(1);
    expect(result![0].serializedNoteScript).toBeUndefined();
  });
});

// ================================================================================================
// getInputNotesFromIds
// ================================================================================================

describe("getInputNotesFromIds", () => {
  it("returns notes matching the given IDs", async () => {
    const dbId = await openTestDb();
    await insertNote(dbId, "id-note-1", { stateDiscriminant: STATE_CONSUMED_EXTERNAL, consumedBlockHeight: 1 });
    await insertNote(dbId, "id-note-2", { stateDiscriminant: STATE_CONSUMED_EXTERNAL, consumedBlockHeight: 2 });
    await insertNote(dbId, "id-note-3", { stateDiscriminant: STATE_EXPECTED });

    const result = await getInputNotesFromIds(dbId, ["id-note-1", "id-note-2"]);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for unmatched IDs", async () => {
    const dbId = await openTestDb();
    const result = await getInputNotesFromIds(dbId, ["nonexistent"]);
    expect(result).toEqual([]);
  });
});

// ================================================================================================
// getInputNotesFromNullifiers
// ================================================================================================

describe("getInputNotesFromNullifiers", () => {
  it("returns notes matching the given nullifiers", async () => {
    const dbId = await openTestDb();
    await insertNote(dbId, "null-note-1", {
      stateDiscriminant: STATE_CONSUMED_EXTERNAL,
      consumedBlockHeight: 1,
      nullifier: "0xnullifier1",
    });
    await insertNote(dbId, "null-note-2", {
      stateDiscriminant: STATE_CONSUMED_EXTERNAL,
      consumedBlockHeight: 2,
      nullifier: "0xnullifier2",
    });

    const result = await getInputNotesFromNullifiers(dbId, ["0xnullifier1"]);
    expect(result).toHaveLength(1);
    expect(result![0].createdAt).toBe("null-note-1");
  });

  it("returns empty array for unknown nullifiers", async () => {
    const dbId = await openTestDb();
    const result = await getInputNotesFromNullifiers(dbId, ["0xunknown"]);
    expect(result).toEqual([]);
  });
});

// ================================================================================================
// getUnspentInputNoteNullifiers
// ================================================================================================

describe("getUnspentInputNoteNullifiers", () => {
  it("returns nullifiers for notes with discriminant 2, 4, or 5", async () => {
    const dbId = await openTestDb();
    await insertNote(dbId, "note-committed", {
      stateDiscriminant: STATE_COMMITTED,
      nullifier: "0xnull-committed",
    });
    await insertNote(dbId, "note-proc-auth", {
      stateDiscriminant: STATE_PROCESSING_AUTHENTICATED,
      nullifier: "0xnull-proc-auth",
    });
    await insertNote(dbId, "note-proc-unauth", {
      stateDiscriminant: STATE_PROCESSING_UNAUTHENTICATED,
      nullifier: "0xnull-proc-unauth",
    });
    await insertNote(dbId, "note-expected", {
      stateDiscriminant: STATE_EXPECTED,
      nullifier: "0xnull-expected",
    });

    const nullifiers = await getUnspentInputNoteNullifiers(dbId);
    expect(nullifiers).toHaveLength(3);
    expect(nullifiers).toContain("0xnull-committed");
    expect(nullifiers).toContain("0xnull-proc-auth");
    expect(nullifiers).toContain("0xnull-proc-unauth");
    expect(nullifiers).not.toContain("0xnull-expected");
  });

  it("returns empty array when no unspent notes", async () => {
    const dbId = await openTestDb();
    const nullifiers = await getUnspentInputNoteNullifiers(dbId);
    expect(nullifiers).toEqual([]);
  });
});

// ================================================================================================
// getNoteScript
// ================================================================================================

describe("getNoteScript", () => {
  it("returns undefined when script not found", async () => {
    const dbId = await openTestDb();
    const result = await getNoteScript(dbId, "nonexistent-root");
    expect(result).toBeUndefined();
  });

  it("returns the script record when found", async () => {
    const dbId = await openTestDb();
    const scriptRoot = "my-script";
    const scriptBytes = new Uint8Array([7, 8, 9]);
    await upsertNoteScript(dbId, scriptRoot, scriptBytes);
    const result = await getNoteScript(dbId, scriptRoot);
    expect(result).toBeDefined();
    expect(result!.scriptRoot).toBe(scriptRoot);
    expect(result!.serializedNoteScript).toEqual(scriptBytes);
  });
});

// ================================================================================================
// upsertNoteScript
// ================================================================================================

describe("upsertNoteScript", () => {
  it("inserts and overwrites a note script", async () => {
    const dbId = await openTestDb();
    const scriptRoot = "root-1";
    await upsertNoteScript(dbId, scriptRoot, new Uint8Array([1, 2, 3]));
    await upsertNoteScript(dbId, scriptRoot, new Uint8Array([4, 5, 6]));
    const result = await getNoteScript(dbId, scriptRoot);
    expect(result!.serializedNoteScript).toEqual(new Uint8Array([4, 5, 6]));
  });
});

// ================================================================================================
// getOutputNotes
// ================================================================================================

describe("getOutputNotes", () => {
  it("returns all output notes when states is empty", async () => {
    const dbId = await openTestDb();
    await upsertOutputNote(dbId, "out-1", DUMMY_BYTES, "recipient1", DUMMY_BYTES, "0xnull1", 100, 3, DUMMY_BYTES);
    await upsertOutputNote(dbId, "out-2", DUMMY_BYTES, "recipient2", DUMMY_BYTES, undefined, 200, 4, DUMMY_BYTES);
    const result = await getOutputNotes(dbId, new Uint8Array([]));
    expect(result).toHaveLength(2);
  });

  it("filters output notes by state discriminant", async () => {
    const dbId = await openTestDb();
    await upsertOutputNote(dbId, "out-state3", DUMMY_BYTES, "r1", DUMMY_BYTES, "0xn1", 100, 3, DUMMY_BYTES);
    await upsertOutputNote(dbId, "out-state4", DUMMY_BYTES, "r2", DUMMY_BYTES, "0xn2", 200, 4, DUMMY_BYTES);

    const result = await getOutputNotes(dbId, new Uint8Array([3]));
    expect(result).toHaveLength(1);
  });

  it("returns processed output note with base64 fields", async () => {
    const dbId = await openTestDb();
    await upsertOutputNote(dbId, "out-processed", DUMMY_BYTES, "recipient-x", DUMMY_BYTES, "0xnull-x", 50, 3, DUMMY_BYTES);
    const result = await getOutputNotes(dbId, new Uint8Array([]));
    expect(result).toHaveLength(1);
    const note = result![0];
    expect(typeof note.assets).toBe("string"); // base64
    expect(typeof note.metadata).toBe("string"); // base64
    expect(note.recipientDigest).toBe("recipient-x");
    expect(note.expectedHeight).toBe(50);
  });

  it("returns empty array when no output notes", async () => {
    const dbId = await openTestDb();
    const result = await getOutputNotes(dbId, new Uint8Array([]));
    expect(result).toEqual([]);
  });
});

// ================================================================================================
// getOutputNotesFromIds
// ================================================================================================

describe("getOutputNotesFromIds", () => {
  it("returns output notes matching the given IDs", async () => {
    const dbId = await openTestDb();
    await upsertOutputNote(dbId, "out-id-1", DUMMY_BYTES, "r1", DUMMY_BYTES, "0xn1", 100, 3, DUMMY_BYTES);
    await upsertOutputNote(dbId, "out-id-2", DUMMY_BYTES, "r2", DUMMY_BYTES, "0xn2", 200, 4, DUMMY_BYTES);

    const result = await getOutputNotesFromIds(dbId, ["out-id-1"]);
    expect(result).toHaveLength(1);
    expect(result![0].recipientDigest).toBe("r1");
  });

  it("returns empty array for unmatched IDs", async () => {
    const dbId = await openTestDb();
    const result = await getOutputNotesFromIds(dbId, ["does-not-exist"]);
    expect(result).toEqual([]);
  });
});

// ================================================================================================
// getOutputNotesFromNullifiers
// ================================================================================================

describe("getOutputNotesFromNullifiers", () => {
  it("returns output notes matching the given nullifiers", async () => {
    const dbId = await openTestDb();
    await upsertOutputNote(dbId, "out-null-1", DUMMY_BYTES, "r1", DUMMY_BYTES, "0xoutnull1", 100, 3, DUMMY_BYTES);
    await upsertOutputNote(dbId, "out-null-2", DUMMY_BYTES, "r2", DUMMY_BYTES, "0xoutnull2", 200, 4, DUMMY_BYTES);

    const result = await getOutputNotesFromNullifiers(dbId, ["0xoutnull1"]);
    expect(result).toHaveLength(1);
    expect(result![0].recipientDigest).toBe("r1");
  });

  it("returns empty when nullifier not found", async () => {
    const dbId = await openTestDb();
    const result = await getOutputNotesFromNullifiers(dbId, ["0xunknown"]);
    expect(result).toEqual([]);
  });
});

// ================================================================================================
// upsertInputNote with provided transaction
// ================================================================================================

describe("upsertInputNote with external transaction", () => {
  it("uses an external transaction when provided", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    // Pass a transaction object to upsertInputNote (the `tx` code path)
    await db.dexie.transaction("rw", db.inputNotes, db.notesScripts, async (tx) => {
      await upsertInputNote(
        dbId,
        "tx-note-1",
        DUMMY_BYTES, DUMMY_BYTES, DUMMY_BYTES,
        "tx-script-root",
        DUMMY_BYTES,
        "tx-nullifier",
        "tx-note-1",
        STATE_CONSUMED_EXTERNAL,
        DUMMY_BYTES,
        10, 0, undefined,
        tx
      );
    });

    const result = await getInputNotesFromIds(dbId, ["tx-note-1"]);
    expect(result).toHaveLength(1);
  });
});

// ================================================================================================
// upsertOutputNote with external transaction
// ================================================================================================

describe("upsertOutputNote with external transaction", () => {
  it("uses an external transaction when provided", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    await db.dexie.transaction("rw", db.outputNotes, db.notesScripts, async (tx) => {
      await upsertOutputNote(
        dbId,
        "out-tx-1",
        DUMMY_BYTES, "recipient-tx", DUMMY_BYTES,
        "0xtxnull", 999, 3, DUMMY_BYTES,
        tx
      );
    });

    const result = await getOutputNotesFromIds(dbId, ["out-tx-1"]);
    expect(result).toHaveLength(1);
    expect(result![0].recipientDigest).toBe("recipient-tx");
  });
});

// ================================================================================================
// Error-path coverage: catch blocks call logWebStoreError (re-throws)
// Passing an unregistered dbId exercises the catch body in each function.
// ================================================================================================
const BAD_DB = "does-not-exist-notes";

describe("error paths: unregistered dbId re-throws", () => {
  it("getOutputNotes rejects on bad dbId", async () => {
    await expect(getOutputNotes(BAD_DB, new Uint8Array([]))).rejects.toThrow();
  });

  it("getInputNotes rejects on bad dbId", async () => {
    await expect(getInputNotes(BAD_DB, new Uint8Array([]))).rejects.toThrow();
  });

  it("getInputNotesFromIds rejects on bad dbId", async () => {
    await expect(getInputNotesFromIds(BAD_DB, ["id1"])).rejects.toThrow();
  });

  it("getInputNotesFromNullifiers rejects on bad dbId", async () => {
    await expect(getInputNotesFromNullifiers(BAD_DB, ["null1"])).rejects.toThrow();
  });

  it("getOutputNotesFromNullifiers rejects on bad dbId", async () => {
    await expect(getOutputNotesFromNullifiers(BAD_DB, ["null1"])).rejects.toThrow();
  });

  it("getOutputNotesFromIds rejects on bad dbId", async () => {
    await expect(getOutputNotesFromIds(BAD_DB, ["id1"])).rejects.toThrow();
  });

  it("getUnspentInputNoteNullifiers rejects on bad dbId", async () => {
    await expect(getUnspentInputNoteNullifiers(BAD_DB)).rejects.toThrow();
  });

  it("getNoteScript rejects on bad dbId", async () => {
    await expect(getNoteScript(BAD_DB, "root1")).rejects.toThrow();
  });

  it("getInputNoteByOffset rejects on bad dbId", async () => {
    await expect(
      getInputNoteByOffset(BAD_DB, new Uint8Array([]), undefined, undefined, undefined, 0)
    ).rejects.toThrow();
  });

  it("upsertInputNote rejects on bad dbId (no tx, bad db)", async () => {
    await expect(
      upsertInputNote(
        BAD_DB, "note-1",
        DUMMY_BYTES, DUMMY_BYTES, DUMMY_BYTES,
        "root", DUMMY_BYTES,
        "null-1", "note-1",
        0, DUMMY_BYTES,
        undefined, undefined, undefined
      )
    ).rejects.toThrow();
  });

  it("upsertNoteScript rejects on bad dbId", async () => {
    await expect(
      upsertNoteScript(BAD_DB, "root", new Uint8Array([1]))
    ).rejects.toThrow();
  });
});
