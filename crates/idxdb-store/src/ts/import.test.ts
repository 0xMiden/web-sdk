import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import {
  openDatabase,
  getDatabase,
  CLIENT_VERSION_SETTING_KEY,
  SETTING_SCOPE_CLIENT,
  SETTING_SCOPE_USER,
} from "./schema.js";
import { exportStore } from "./export.js";
import { forceImportStore, transformForImport } from "./import.js";
import { uint8ArrayToBase64 } from "./utils.js";

let dbCounter = 0;
function uniqueDbName(): string {
  return `test-import-${++dbCounter}-${Date.now()}`;
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

// The running client's version in these tests; a dump is importable when its stamp is at or
// above the migration baseline and not newer than this.
const CLIENT_VERSION = "0.17.4";

async function openTestDb(version: string = CLIENT_VERSION): Promise<string> {
  const name = uniqueDbName();
  await openDatabase(name, version);
  openDbIds.push(name);
  return name;
}

// A client-scope stamp row as an export writes it.
function stampRow(version: string) {
  return {
    scope: SETTING_SCOPE_CLIENT,
    key: CLIENT_VERSION_SETTING_KEY,
    value: {
      __type: "Uint8Array",
      data: uint8ArrayToBase64(new TextEncoder().encode(version)),
    },
  };
}

// ================================================================================================
// transformForImport unit tests
// ================================================================================================

describe("transformForImport", () => {
  let logSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("converts a tagged Uint8Array object back to Uint8Array", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const encoded = {
      __type: "Uint8Array",
      data: uint8ArrayToBase64(original),
    };
    const result = await transformForImport(encoded);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(original);
  });

  it("converts a tagged Blob object back to Blob", async () => {
    const original = new Uint8Array([4, 5, 6]);
    const encoded = { __type: "Blob", data: uint8ArrayToBase64(original) };
    const result = await transformForImport(encoded);
    expect(result).toBeInstanceOf(Blob);
    const buf = await result.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(original);
  });

  it("transforms an array recursively", async () => {
    const original = new Uint8Array([7]);
    const encoded = [
      { __type: "Uint8Array", data: uint8ArrayToBase64(original) },
      42,
      "hello",
    ];
    const result = await transformForImport(encoded);
    expect(result[0]).toEqual(original);
    expect(result[1]).toBe(42);
    expect(result[2]).toBe("hello");
  });

  it("transforms a nested record recursively", async () => {
    const bytes = new Uint8Array([8, 9]);
    const encoded = {
      data: { __type: "Uint8Array", data: uint8ArrayToBase64(bytes) },
      count: 5,
    };
    const result = await transformForImport(encoded);
    expect(result.data).toEqual(bytes);
    expect(result.count).toBe(5);
  });

  it("returns primitives unchanged", async () => {
    expect(await transformForImport(42)).toBe(42);
    expect(await transformForImport("hello")).toBe("hello");
    expect(await transformForImport(null)).toBeNull();
    expect(await transformForImport(true)).toBe(true);
  });

  it("round-trips through export transformForExport", async () => {
    const original = new Uint8Array([10, 20, 30]);
    const { transformForExport } = await import("./export.js");
    const exported = await transformForExport(original);
    const reimported = await transformForImport(exported);
    expect(reimported).toEqual(original);
  });
});

// ================================================================================================
// forceImportStore tests
// ================================================================================================

describe("forceImportStore", () => {
  let logSpy: any;
  let errorSpy: any;
  let warnSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("round-trip: export DB-A, import into DB-B, rows match", async () => {
    const dbIdA = await openTestDb();
    const dbA = getDatabase(dbIdA);

    const assetBytes = new Uint8Array([11, 22, 33]);
    const serialBytes = new Uint8Array([44, 55, 66, 77]);
    const inputsBytes = new Uint8Array([1]);
    const stateBytes = new Uint8Array([2, 3]);

    // Insert a row into DB-A
    await dbA.inputNotes.put({
      detailsCommitment: "commitment-round-trip",
      noteId: "round-trip-note",
      stateDiscriminant: 0,
      assets: assetBytes,
      serialNumber: serialBytes,
      inputs: inputsBytes,
      scriptRoot: "sr-round-trip",
      nullifier: "nullifier-round-trip",
      serializedCreatedAt: "2024-06-01",
      state: stateBytes,
    });

    // Export DB-A
    const jsonStr = await exportStore(dbIdA);

    // Open DB-B and import
    const dbIdB = await openTestDb();
    await forceImportStore(dbIdB, jsonStr);

    // Verify DB-B has the same inputNotes row
    const dbB = getDatabase(dbIdB);
    const notesB = await dbB.inputNotes.toArray();
    const imported = notesB.find((n) => n.noteId === "round-trip-note");
    expect(imported).toBeDefined();
    expect(imported!.assets).toEqual(assetBytes);
    expect(imported!.serialNumber).toEqual(serialBytes);
    expect(imported!.inputs).toEqual(inputsBytes);
    expect(imported!.state).toEqual(stateBytes);
    expect(imported!.scriptRoot).toBe("sr-round-trip");
  });

  it("round-trip preserves all populated tables", async () => {
    const dbIdA = await openTestDb();
    const dbA = getDatabase(dbIdA);

    await dbA.accountCodes.put({
      root: "root-rt",
      code: new Uint8Array([1, 2, 3]),
    });

    await dbA.tags.put({ tag: "tag-rt" });

    const jsonStr = await exportStore(dbIdA);

    const dbIdB = await openTestDb();
    await forceImportStore(dbIdB, jsonStr);

    const dbB = getDatabase(dbIdB);
    const codesB = await dbB.accountCodes.toArray();
    expect(codesB).toHaveLength(1);
    expect(codesB[0].root).toBe("root-rt");
    expect(codesB[0].code).toEqual(new Uint8Array([1, 2, 3]));

    const tagsB = await dbB.tags.toArray();
    const tagFound = tagsB.find((t) => t.tag === "tag-rt");
    expect(tagFound).toBeDefined();
  });

  it("import clears existing rows in target DB before importing", async () => {
    const dbIdA = await openTestDb();
    const dbA = getDatabase(dbIdA);

    await dbA.accountCodes.put({ root: "root-a1", code: new Uint8Array([1]) });

    const jsonStr = await exportStore(dbIdA);

    const dbIdB = await openTestDb();
    const dbB = getDatabase(dbIdB);

    // Pre-populate DB-B with a row that should be wiped
    await dbB.accountCodes.put({
      root: "root-b-old",
      code: new Uint8Array([9]),
    });
    expect(await dbB.accountCodes.count()).toBe(1);

    await forceImportStore(dbIdB, jsonStr);

    const codesAfter = await dbB.accountCodes.toArray();
    // Only the row from DB-A should remain
    expect(codesAfter.map((c) => c.root)).toContain("root-a1");
    expect(codesAfter.map((c) => c.root)).not.toContain("root-b-old");
  });

  it("does not restore the client-scope note transport outbox from an older export", async () => {
    const dbIdA = await openTestDb();
    const dbA = getDatabase(dbIdA);
    await dbA.settings.bulkPut([
      {
        scope: SETTING_SCOPE_CLIENT,
        key: "note_transport_outbox",
        value: new Uint8Array([1]),
      },
      {
        scope: SETTING_SCOPE_USER,
        key: "note_transport_outbox",
        value: new Uint8Array([2]),
      },
    ]);
    const jsonStr = await exportStore(dbIdA);

    const dbIdB = await openTestDb();
    await forceImportStore(dbIdB, jsonStr);

    const dbB = getDatabase(dbIdB);
    expect(
      await dbB.settings.get([SETTING_SCOPE_CLIENT, "note_transport_outbox"])
    ).toBe(undefined);
    expect(
      (await dbB.settings.get([SETTING_SCOPE_USER, "note_transport_outbox"]))!
        .value
    ).toEqual(new Uint8Array([2]));
  });

  it("handles double-serialized JSON (string payload)", async () => {
    const dbIdA = await openTestDb();
    const jsonStr = await exportStore(dbIdA);
    // Double-encode: JSON.stringify the string again
    const doubleEncoded = JSON.stringify(jsonStr);

    const dbIdB = await openTestDb();
    // Should not throw — import.ts handles double-encoded payloads
    await forceImportStore(dbIdB, doubleEncoded);
  });

  it("throws when payload has no tables (empty JSON object {})", async () => {
    const dbId = await openTestDb();
    // {} parses to an object with zero keys — triggers "No tables found" error
    await expect(forceImportStore(dbId, "{}")).rejects.toThrow(
      "No tables found"
    );
  });

  it("throws when the payload contains only unknown table names", async () => {
    // Dexie.table() throws InvalidTableError before the warn+skip guard in import.ts
    // can fire, because the table name is not in the transaction scope. This verifies
    // the real (observed) behavior of the source rather than its intent comment.
    const dbId = await openTestDb();
    const payload = JSON.stringify({
      settings: [stampRow(CLIENT_VERSION)],
      unknownTable: [{ id: 1, value: "x" }],
    });
    await expect(forceImportStore(dbId, payload)).rejects.toThrow(
      /unknownTable/
    );
  });

  it("warn+skip guard: covers lines 86-90 by mocking dexie.table not to throw for unknown names", async () => {
    // The warn+skip guard in import.ts (lines 85-90) is normally dead code because
    // db.dexie.table() throws InvalidTableError for unknown tables before the guard is reached.
    // We mock the table accessor to make it return a fake table object for unknown names,
    // allowing execution to reach the guard and exercise the console.warn + continue path.
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    const origTable = db.dexie.table.bind(db.dexie);
    const fakeBulkPut = vi.fn().mockResolvedValue(undefined);
    const fakeTableStub = { bulkPut: fakeBulkPut };

    vi.spyOn(db.dexie, "table").mockImplementation((name: string) => {
      // For unknown table names, return a stub instead of throwing.
      // For known tables, delegate to the real implementation.
      try {
        return origTable(name);
      } catch {
        return fakeTableStub as any;
      }
    });

    const payload = JSON.stringify({
      settings: [stampRow(CLIENT_VERSION)],
      unknownTable: [{ id: 1 }],
    });

    // Should resolve without error (unknown table is warned and skipped)
    await forceImportStore(dbId, payload);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknownTable")
    );
    // The stub's bulkPut should NOT have been called (we skipped it)
    expect(fakeBulkPut).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("throws for a db that was never opened", async () => {
    await expect(
      forceImportStore("never-opened", JSON.stringify({ someTable: [] }))
    ).rejects.toThrow();
  });

  it("throws on malformed JSON payload", async () => {
    const dbId = await openTestDb();
    await expect(forceImportStore(dbId, "not-valid-json{{")).rejects.toThrow();
  });
});

describe("forceImportStore refuses a dump the store could not have kept", () => {
  let logSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // A real export whose client stamp is replaced by `stamp`, or removed when it is null.
  async function dumpStamped(stamp: string | null): Promise<string> {
    const source = await openTestDb();
    await getDatabase(source).inputNotes.put({
      detailsCommitment: "dumped",
      noteId: "dumped-note",
      stateDiscriminant: 0,
      assets: new Uint8Array([1]),
      serialNumber: new Uint8Array([2]),
      inputs: new Uint8Array([3]),
      scriptRoot: "sr",
      nullifier: "nf",
      serializedCreatedAt: "2026-10-09",
      state: new Uint8Array([4]),
    });
    const dump = JSON.parse(await exportStore(source));
    dump.settings = dump.settings.filter(
      (row: { scope: number; key: string }) =>
        !(
          row.scope === SETTING_SCOPE_CLIENT &&
          row.key === CLIENT_VERSION_SETTING_KEY
        )
    );
    if (stamp !== null) {
      dump.settings.push(stampRow(stamp));
    }
    return JSON.stringify(dump);
  }

  // The target keeps its own rows and does not gain the dump's.
  async function expectUntouched(dbId: string) {
    const db = getDatabase(dbId);
    expect(await db.settings.get([SETTING_SCOPE_USER, "kept"])).toBeDefined();
    expect(await db.inputNotes.get("dumped")).toBeUndefined();
  }

  async function targetWithRow(): Promise<string> {
    const dbId = await openTestDb();
    await getDatabase(dbId).settings.put({
      scope: SETTING_SCOPE_USER,
      key: "kept",
      value: new Uint8Array([9]),
    });
    return dbId;
  }

  it.each([
    ["0.16.2", /older than 0\.17\.0/],
    ["0.17.0-rc.5", /older than 0\.17\.0/],
    ["not-a-version", /not a valid client version/],
    ["0.17.5", /newer client/],
  ])("refuses a dump stamped %s", async (stamp, reason) => {
    const target = await targetWithRow();
    await expect(
      forceImportStore(target, await dumpStamped(stamp))
    ).rejects.toThrow(reason);
    await expectUntouched(target);
  });

  it("refuses a dump with no client version stamp", async () => {
    const target = await targetWithRow();
    await expect(
      forceImportStore(target, await dumpStamped(null))
    ).rejects.toThrow(/no client version stamp/);
    await expectUntouched(target);
  });

  async function stampOf(dbId: string): Promise<string | undefined> {
    const row = await getDatabase(dbId).settings.get([
      SETTING_SCOPE_CLIENT,
      CLIENT_VERSION_SETTING_KEY,
    ]);
    return row ? new TextDecoder().decode(row.value) : undefined;
  }

  it("keeps the running client's stamp across imports into one open store", async () => {
    const target = await targetWithRow();
    await forceImportStore(target, await dumpStamped("0.17.0"));
    expect(await stampOf(target)).toBe(CLIENT_VERSION);
    await forceImportStore(target, await dumpStamped(CLIENT_VERSION));
    expect(await stampOf(target)).toBe(CLIENT_VERSION);
  });

  it("compares with the running client when another client left its stamp", async () => {
    const target = await targetWithRow();
    await getDatabase(target).settings.put({
      scope: SETTING_SCOPE_CLIENT,
      key: CLIENT_VERSION_SETTING_KEY,
      value: new TextEncoder().encode("0.17.1"),
    });
    await forceImportStore(target, await dumpStamped(CLIENT_VERSION));
    expect(await getDatabase(target).inputNotes.get("dumped")).toBeDefined();
  });

  it("leaves the dump's stamp when the store was opened without a version", async () => {
    const target = await openTestDb("");
    await forceImportStore(target, await dumpStamped("0.17.5"));
    expect(await stampOf(target)).toBe("0.17.5");
  });

  it("imports a dump stamped with the running client's version or an older 0.17 one", async () => {
    for (const stamp of [CLIENT_VERSION, "0.17.0"]) {
      const target = await targetWithRow();
      await forceImportStore(target, await dumpStamped(stamp));
      expect(await getDatabase(target).inputNotes.get("dumped")).toBeDefined();
    }
  });
});
