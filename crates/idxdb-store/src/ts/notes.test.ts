import { describe, it, expect, afterEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  upsertInputNote,
  upsertOutputNote,
  upsertNoteScript,
  getInputNoteAfter,
  getInputNotes,
  getInputNotesFromIds,
  getInputNotesFromNullifiers,
  getInputNotesFromScriptRoots,
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

const CONSUMER = "0xconsumer";

/**
 * Insert a minimal input note with consumption metadata.
 * The noteId is stored in the `createdAt` field so we can recover it from the
 * processed (base64-encoded) output of `getInputNoteAfter`.
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
    detailsCommitment?: string;
    // `InputNoteRecord::id()` is an Option, so pass `undefined` to model a note whose id is
    // not yet known. The label is carried by `serializedCreatedAt` either way.
    noteId?: string;
  } = {}
) {
  await upsertInputNote(
    dbId,
    // The details commitment is the primary key. Default it to the noteId so
    // each distinct note in these tests lands in its own row.
    opts.detailsCommitment ?? noteId,
    "noteId" in opts ? opts.noteId : noteId,
    DUMMY_BYTES,
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
    opts.consumerAccountId ?? CONSUMER
  );
}

interface Cursor {
  blockHeight: number;
  txOrder: number;
  detailsCommitment: string;
}

/**
 * Reads the cursor pointing at `noteId` out of the store. Mirrors what the client does with
 * `InputNoteCursor::from_record`, which reads the same three fields off the record it was
 * handed rather than off the wire.
 */
async function cursorFor(dbId: string, noteId: string): Promise<Cursor> {
  // Found by the label rather than by `noteId`, which is optional and may be unset, and
  // rather than by either ordering key, so a fixture is free to make noteId and
  // detailsCommitment disagree.
  const row = await getDatabase(dbId)
    .inputNotes.filter((n) => n.serializedCreatedAt === noteId)
    .first();
  if (!row) throw new Error(`no note ${noteId} in the store`);
  // Every returned row must carry a consumption position, so it can always seed the next
  // cursor. If one cannot, the query returned a note the SQLite store excludes and the
  // client's InputNoteReader would reject — fail loudly rather than page from a null key.
  if (row.consumedBlockHeight == null || row.consumedTxOrder == null) {
    throw new Error(
      `note ${noteId} was returned without a consumption position`
    );
  }
  return {
    blockHeight: row.consumedBlockHeight,
    txOrder: row.consumedTxOrder,
    detailsCommitment: row.detailsCommitment,
  };
}

/**
 * Pages through the whole sequence with `getInputNoteAfter`, collecting noteIds from the
 * function's own output. The noteId is recovered from the `createdAt` field of the processed
 * result (where we stored it during insertion).
 */
async function collectAllNoteIds(
  dbId: string,
  states: Uint8Array,
  consumer: string,
  blockStart?: number,
  blockEnd?: number
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: Cursor | undefined = undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await getInputNoteAfter(
      dbId,
      states,
      consumer,
      blockStart,
      blockEnd,
      cursor?.blockHeight,
      cursor?.txOrder,
      cursor?.detailsCommitment
    );
    if (!result || result.length === 0) break;
    // Exactly one row per call — the store's contract is "the note after the cursor".
    expect(result).toHaveLength(1);
    // createdAt holds the noteId (see insertNote)
    const noteId = result[0].createdAt;
    ids.push(noteId);
    cursor = await cursorFor(dbId, noteId);

    if (ids.length > 100) throw new Error("paging did not terminate");
  }

  return ids;
}

// ORDERING TESTS
// ================================================================================================

describe("getInputNoteAfter ordering", () => {
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

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, CONSUMER);
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

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, CONSUMER);
    expect(ids).toEqual(["note-tx0", "note-tx1", "note-tx2"]);
  });

  it("breaks ties on detailsCommitment, not noteId", async () => {
    const dbId = await openTestDb();

    // noteId order and detailsCommitment order disagree here, so this only holds if the seek
    // is keyed by the commitment the cursor actually carries.
    await insertNote(dbId, "note-z", {
      detailsCommitment: "commitment-a",
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-a", {
      detailsCommitment: "commitment-z",
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, CONSUMER);
    expect(ids).toEqual(["note-z", "note-a"]);
  });

  it("returns consumed notes that have no noteId", async () => {
    const dbId = await openTestDb();

    // `noteId` is unset whenever the record carries no metadata, which is the normal shape of
    // an externally-consumed note. It is not part of the ordering key, so it must not affect
    // whether a row is paged — and both notes here are otherwise identical in state. Keying
    // the consumption index on `detailsCommitment`, which is required, is what admits them:
    // IndexedDB omits a record missing any component of a compound index, so an index keyed
    // on the optional `noteId` dropped exactly these rows.
    await insertNote(dbId, "note-with-id", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
      detailsCommitment: "0xaa",
    });
    await insertNote(dbId, "note-without-id", {
      consumedBlockHeight: 1,
      consumedTxOrder: 1,
      detailsCommitment: "0xbb",
      noteId: undefined,
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, CONSUMER);
    expect(ids).toEqual(["note-with-id", "note-without-id"]);
  });

  it("leaves out notes that carry no tx order", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-consumed", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
    });
    // Missing a key path, so absent from the compound index. The client cannot build a cursor
    // for such a note either, which is why it has no place in the sequence.
    await insertNote(dbId, "note-no-order", {
      consumedBlockHeight: 5,
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, CONSUMER);
    expect(ids).toEqual(["note-consumed"]);
  });

  it("never pages a row that has a tx order but no block height", async () => {
    const dbId = await openTestDb();

    // The mirror of the case above: a tx order present but the height absent. It is still a
    // missing component of the compound index, so the row is absent from the index entirely.
    // Hence the low detailsCommitment — were the row reachable at all it would sort first and
    // be returned ahead of the positioned note.
    await insertNote(dbId, "note-tx-order-no-height", {
      consumedTxOrder: 0,
      detailsCommitment: "0x0000",
    });
    await insertNote(dbId, "note-positioned", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
      detailsCommitment: "0xffff",
    });

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, CONSUMER);
    expect(ids).toEqual(["note-positioned"]);
  });
});

// CURSOR SEMANTICS TESTS
// ================================================================================================

describe("getInputNoteAfter cursor semantics", () => {
  it("returns the first note when no cursor is given", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-1", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-2", {
      consumedBlockHeight: 2,
      consumedTxOrder: 0,
    });

    const result = await getInputNoteAfter(
      dbId,
      CONSUMED_STATES,
      CONSUMER,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(result).toHaveLength(1);
    expect(result![0].createdAt).toBe("note-1");
  });

  it("resolves the next note after a cursor whose own note was deleted", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-1", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });
    await insertNote(dbId, "note-2", {
      consumedBlockHeight: 2,
      consumedTxOrder: 0,
    });

    const cursor = await cursorFor(dbId, "note-1");
    await getDatabase(dbId).inputNotes.delete(cursor.detailsCommitment);

    const result = await getInputNoteAfter(
      dbId,
      CONSUMED_STATES,
      CONSUMER,
      undefined,
      undefined,
      cursor.blockHeight,
      cursor.txOrder,
      cursor.detailsCommitment
    );
    expect(result).toHaveLength(1);
    expect(result![0].createdAt).toBe("note-2");
  });

  it("returns empty once the cursor passes the last note", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-1", {
      consumedBlockHeight: 1,
      consumedTxOrder: 0,
    });

    const cursor = await cursorFor(dbId, "note-1");
    const result = await getInputNoteAfter(
      dbId,
      CONSUMED_STATES,
      CONSUMER,
      undefined,
      undefined,
      cursor.blockHeight,
      cursor.txOrder,
      cursor.detailsCommitment
    );
    expect(result).toEqual([]);
  });
});

// CONSUMER FILTER TESTS
// ================================================================================================

describe("getInputNoteAfter consumer filtering", () => {
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
    // Only the note with a tx order is in the compound index the seek walks.
    expect(ids).toEqual(["note-with-order"]);
  });
});

// BLOCK RANGE FILTER TESTS
// ================================================================================================

describe("getInputNoteAfter block range filtering", () => {
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
    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, CONSUMER, 3, 5);
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

  it("keeps blockStart when the cursor is below it", async () => {
    const dbId = await openTestDb();

    await insertNote(dbId, "note-b5", {
      consumedBlockHeight: 5,
      consumedTxOrder: 0,
      consumerAccountId: "0xalice",
    });
    await insertNote(dbId, "note-b20", {
      consumedBlockHeight: 20,
      consumedTxOrder: 0,
      consumerAccountId: "0xalice",
    });

    // A cursor below blockStart is the looser of the two lower bounds. The seek starts from
    // the cursor, so blockStart has to keep applying as a predicate — dropping it here would
    // return the block-5 note, below the requested range.
    const result = await getInputNoteAfter(
      dbId,
      CONSUMED_STATES,
      "0xalice",
      10,
      undefined,
      1,
      0,
      "0x00"
    );
    expect(result?.map((n) => n.createdAt)).toEqual(["note-b20"]);
  });
});

// STATE FILTER TESTS
// ================================================================================================

describe("getInputNoteAfter state filtering", () => {
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

    const ids = await collectAllNoteIds(dbId, CONSUMED_STATES, CONSUMER);
    expect(ids).toEqual(["consumed"]);
  });

  it("returns empty when no notes match", async () => {
    const dbId = await openTestDb();

    const result = await getInputNoteAfter(
      dbId,
      CONSUMED_STATES,
      CONSUMER,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
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
    await insertNote(dbId, "n1", {
      stateDiscriminant: STATE_CONSUMED_EXTERNAL,
      consumedBlockHeight: 1,
    });
    await insertNote(dbId, "n2", { stateDiscriminant: STATE_EXPECTED });
    const result = await getInputNotes(dbId, new Uint8Array([]));
    expect(result).toHaveLength(2);
  });

  it("filters by state discriminants when non-empty", async () => {
    const dbId = await openTestDb();
    await insertNote(dbId, "n-consumed", {
      stateDiscriminant: STATE_CONSUMED_EXTERNAL,
      consumedBlockHeight: 1,
    });
    await insertNote(dbId, "n-expected", { stateDiscriminant: STATE_EXPECTED });
    const result = await getInputNotes(
      dbId,
      new Uint8Array([STATE_CONSUMED_EXTERNAL])
    );
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
    const result = await getInputNotes(
      dbId,
      new Uint8Array([STATE_CONSUMED_EXTERNAL])
    );
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
      "note-no-script",
      DUMMY_BYTES,
      DUMMY_BYTES,
      DUMMY_BYTES,
      DUMMY_BYTES,
      "", // empty script root
      DUMMY_BYTES,
      "null-nullifier",
      "note-no-script",
      STATE_CONSUMED_EXTERNAL,
      DUMMY_BYTES,
      1,
      0,
      undefined
    );
    const result = await getInputNotes(
      dbId,
      new Uint8Array([STATE_CONSUMED_EXTERNAL])
    );
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
    await insertNote(dbId, "id-note-1", {
      stateDiscriminant: STATE_CONSUMED_EXTERNAL,
      consumedBlockHeight: 1,
    });
    await insertNote(dbId, "id-note-2", {
      stateDiscriminant: STATE_CONSUMED_EXTERNAL,
      consumedBlockHeight: 2,
    });
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
// getInputNotesFromScriptRoots
// ================================================================================================

describe("getInputNotesFromScriptRoots", () => {
  it("returns notes matching the given script roots", async () => {
    const dbId = await openTestDb();
    await insertNote(dbId, "root-note-1", { scriptRoot: "0xroot1" });
    await insertNote(dbId, "root-note-2", { scriptRoot: "0xroot1" });
    await insertNote(dbId, "root-note-3", { scriptRoot: "0xroot2" });

    const result = await getInputNotesFromScriptRoots(dbId, ["0xroot1"]);
    expect(result).toHaveLength(2);
    // createdAt holds the noteId (see insertNote)
    expect(result?.map((note) => note.createdAt).sort()).toEqual([
      "root-note-1",
      "root-note-2",
    ]);

    const combined = await getInputNotesFromScriptRoots(dbId, [
      "0xroot1",
      "0xroot2",
    ]);
    expect(combined).toHaveLength(3);
  });

  it("returns empty array for unmatched script roots", async () => {
    const dbId = await openTestDb();
    await insertNote(dbId, "root-note-1", { scriptRoot: "0xroot1" });

    const result = await getInputNotesFromScriptRoots(dbId, ["0xother"]);
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
    await upsertOutputNote(
      dbId,
      "dc-out-1",
      "out-1",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "recipient1",
      DUMMY_BYTES,
      "0xnull1",
      100,
      3,
      DUMMY_BYTES
    );
    await upsertOutputNote(
      dbId,
      "dc-out-2",
      "out-2",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "recipient2",
      DUMMY_BYTES,
      undefined,
      200,
      4,
      DUMMY_BYTES
    );
    const result = await getOutputNotes(dbId, new Uint8Array([]));
    expect(result).toHaveLength(2);
  });

  it("filters output notes by state discriminant", async () => {
    const dbId = await openTestDb();
    await upsertOutputNote(
      dbId,
      "dc-out-state3",
      "out-state3",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "r1",
      DUMMY_BYTES,
      "0xn1",
      100,
      3,
      DUMMY_BYTES
    );
    await upsertOutputNote(
      dbId,
      "dc-out-state4",
      "out-state4",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "r2",
      DUMMY_BYTES,
      "0xn2",
      200,
      4,
      DUMMY_BYTES
    );

    const result = await getOutputNotes(dbId, new Uint8Array([3]));
    expect(result).toHaveLength(1);
  });

  it("returns processed output note with base64 fields", async () => {
    const dbId = await openTestDb();
    await upsertOutputNote(
      dbId,
      "dc-out-processed",
      "out-processed",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "recipient-x",
      DUMMY_BYTES,
      "0xnull-x",
      50,
      3,
      DUMMY_BYTES
    );
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
    await upsertOutputNote(
      dbId,
      "dc-out-id-1",
      "out-id-1",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "r1",
      DUMMY_BYTES,
      "0xn1",
      100,
      3,
      DUMMY_BYTES
    );
    await upsertOutputNote(
      dbId,
      "dc-out-id-2",
      "out-id-2",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "r2",
      DUMMY_BYTES,
      "0xn2",
      200,
      4,
      DUMMY_BYTES
    );

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
    await upsertOutputNote(
      dbId,
      "dc-out-null-1",
      "out-null-1",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "r1",
      DUMMY_BYTES,
      "0xoutnull1",
      100,
      3,
      DUMMY_BYTES
    );
    await upsertOutputNote(
      dbId,
      "dc-out-null-2",
      "out-null-2",
      DUMMY_BYTES,
      DUMMY_BYTES,
      "r2",
      DUMMY_BYTES,
      "0xoutnull2",
      200,
      4,
      DUMMY_BYTES
    );

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
// input note keying by details commitment
// ================================================================================================

describe("input note keying", () => {
  it("keeps a single row when a partial note later gains its noteId", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    const commitment = "details-commitment-1";

    // First upsert: a partial note with no noteId yet (e.g. imported by details).
    await upsertInputNote(
      dbId,
      commitment,
      undefined,
      DUMMY_BYTES,
      DUMMY_BYTES,
      DUMMY_BYTES,
      DUMMY_BYTES,
      DUMMY_SCRIPT_ROOT,
      DUMMY_BYTES,
      "nullifier-1",
      "created-at-1",
      STATE_EXPECTED,
      DUMMY_BYTES,
      undefined,
      undefined,
      undefined
    );

    // Second upsert: the same note (same details commitment) now carries its
    // noteId. It must update the existing row rather than insert a duplicate.
    await upsertInputNote(
      dbId,
      commitment,
      "note-id-1",
      DUMMY_BYTES,
      DUMMY_BYTES,
      DUMMY_BYTES,
      DUMMY_BYTES,
      DUMMY_SCRIPT_ROOT,
      DUMMY_BYTES,
      "nullifier-1",
      "created-at-1",
      STATE_COMMITTED,
      DUMMY_BYTES,
      undefined,
      undefined,
      undefined
    );

    expect(await db.inputNotes.count()).toBe(1);
    const row = await db.inputNotes.get(commitment);
    expect(row).toBeDefined();
    expect(row!.noteId).toBe("note-id-1");

    // The note is now reachable by its noteId via the secondary index.
    const byId = await getInputNotesFromIds(dbId, ["note-id-1"]);
    expect(byId).toHaveLength(1);
  });

  it("stores distinct rows for notes with distinct details commitments", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    await insertNote(dbId, "note-a", { detailsCommitment: "commitment-a" });
    await insertNote(dbId, "note-b", { detailsCommitment: "commitment-b" });

    expect(await db.inputNotes.count()).toBe(2);
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
    await db.dexie.transaction(
      "rw",
      db.inputNotes,
      db.notesScripts,
      async (tx) => {
        await upsertInputNote(
          dbId,
          "tx-note-1",
          "tx-note-1",
          DUMMY_BYTES,
          DUMMY_BYTES,
          DUMMY_BYTES,
          DUMMY_BYTES,
          "tx-script-root",
          DUMMY_BYTES,
          "tx-nullifier",
          "tx-note-1",
          STATE_CONSUMED_EXTERNAL,
          DUMMY_BYTES,
          10,
          0,
          undefined,
          tx
        );
      }
    );

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

    await db.dexie.transaction(
      "rw",
      db.outputNotes,
      db.notesScripts,
      async (tx) => {
        await upsertOutputNote(
          dbId,
          "dc-out-tx-1",
          "out-tx-1",
          DUMMY_BYTES,
          DUMMY_BYTES,
          "recipient-tx",
          DUMMY_BYTES,
          "0xtxnull",
          999,
          3,
          DUMMY_BYTES,
          tx
        );
      }
    );

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
    await expect(
      getInputNotesFromNullifiers(BAD_DB, ["null1"])
    ).rejects.toThrow();
  });

  it("getOutputNotesFromNullifiers rejects on bad dbId", async () => {
    await expect(
      getOutputNotesFromNullifiers(BAD_DB, ["null1"])
    ).rejects.toThrow();
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

  it("getInputNoteAfter rejects on bad dbId", async () => {
    await expect(
      getInputNoteAfter(
        BAD_DB,
        new Uint8Array([]),
        CONSUMER,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow();
  });

  it("upsertInputNote rejects on bad dbId (no tx, bad db)", async () => {
    await expect(
      upsertInputNote(
        BAD_DB,
        "note-1",
        "note-1",
        DUMMY_BYTES,
        DUMMY_BYTES,
        DUMMY_BYTES,
        DUMMY_BYTES,
        "root",
        DUMMY_BYTES,
        "null-1",
        "note-1",
        0,
        DUMMY_BYTES,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow();
  });

  it("upsertNoteScript rejects on bad dbId", async () => {
    await expect(
      upsertNoteScript(BAD_DB, "root", new Uint8Array([1]))
    ).rejects.toThrow();
  });
});
