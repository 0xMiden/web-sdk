import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import { exportStore, STORE_DUMP_FORMAT_VERSION } from "./export.js";
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

async function openTestDb(): Promise<string> {
  const name = uniqueDbName();
  await openDatabase(name, "0.1.0");
  openDbIds.push(name);
  return name;
}

function minimalDump(extraTables: Record<string, unknown[]> = {}): string {
  return JSON.stringify({
    formatVersion: STORE_DUMP_FORMAT_VERSION,
    tables: {
      forestRevision: [{ id: 0, nextVersion: "0000000000000001" }],
      forestTrees: [],
      forestEntries: [],
      forestSubtrees: [],
      ...extraTables,
    },
  });
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
    const subtreeBlob = new Uint8Array([8, 9, 10]);
    await dbA.forestTrees.put({
      lineage: "lineage-rt",
      version: "0000000000000001",
      root: "0xroot-rt",
      entryCount: 1,
    });
    await dbA.forestEntries.put({
      lineage: "lineage-rt",
      key: "0xkey-rt",
      value: "0xvalue-rt",
      leafPosition: "ffffffffffffffff",
    });
    await dbA.forestSubtrees.put({
      lineage: "lineage-rt",
      depth: 8,
      position: "ffffffffffffffff",
      blob: subtreeBlob,
    });

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
    await expect(dbB.forestTrees.get("lineage-rt")).resolves.toBeDefined();
    await expect(
      dbB.forestEntries.get(["lineage-rt", "0xkey-rt"])
    ).resolves.toBeDefined();
    expect(
      await dbB.forestSubtrees.get(["lineage-rt", 8, "ffffffffffffffff"])
    ).toEqual({
      lineage: "lineage-rt",
      depth: 8,
      position: "ffffffffffffffff",
      blob: subtreeBlob,
    });
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
    await dbB.forestTrees.put({
      lineage: "target-only",
      version: "0000000000000001",
      root: "0xtarget",
      entryCount: 0,
    });
    const transactionSpy = vi.spyOn(dbB.dexie, "transaction");

    await forceImportStore(dbIdB, jsonStr);

    const codesAfter = await dbB.accountCodes.toArray();
    // Only the row from DB-A should remain
    expect(codesAfter.map((c) => c.root)).toContain("root-a1");
    expect(codesAfter.map((c) => c.root)).not.toContain("root-b-old");
    await expect(dbB.forestTrees.get("target-only")).resolves.toBeUndefined();
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(transactionSpy.mock.calls[0][0]).toBe("rw");
    expect(transactionSpy.mock.calls[0][1]).toHaveLength(
      dbB.dexie.tables.length
    );
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

  it("rejects a legacy dump without a format marker before clearing", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.accountCodes.put({
      root: "sentinel",
      code: new Uint8Array([1]),
    });

    await expect(forceImportStore(dbId, "{}")).rejects.toThrow(
      "missing its format marker"
    );
    await expect(db.accountCodes.get("sentinel")).resolves.toBeDefined();
  });

  it("rejects unsupported versions and missing forest tables", async () => {
    const dbId = await openTestDb();
    await expect(
      forceImportStore(dbId, JSON.stringify({ formatVersion: 2, tables: {} }))
    ).rejects.toThrow("Unsupported store dump format version");
    await expect(
      forceImportStore(
        dbId,
        JSON.stringify({
          formatVersion: STORE_DUMP_FORMAT_VERSION,
          tables: {
            forestRevision: [],
            forestTrees: [],
            forestEntries: [],
          },
        })
      )
    ).rejects.toThrow('missing required forest table "forestSubtrees"');
  });

  it("rejects an invalid tables object and non-array table rows", async () => {
    const dbId = await openTestDb();
    await expect(
      forceImportStore(
        dbId,
        JSON.stringify({
          formatVersion: STORE_DUMP_FORMAT_VERSION,
          tables: null,
        })
      )
    ).rejects.toThrow("valid tables object");
    const invalidTableDump = JSON.parse(minimalDump());
    invalidTableDump.tables.settings = {};
    await expect(
      forceImportStore(dbId, JSON.stringify(invalidTableDump))
    ).rejects.toThrow('Table "settings" is not an array');
  });

  it("warns and skips unknown tables", async () => {
    const dbId = await openTestDb();
    await forceImportStore(dbId, minimalDump({ unknownTable: [{ id: 1 }] }));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknownTable")
    );
  });

  it("throws for a db that was never opened", async () => {
    await expect(
      forceImportStore("never-opened", minimalDump())
    ).rejects.toThrow();
  });

  it("throws on malformed JSON payload", async () => {
    const dbId = await openTestDb();
    await expect(forceImportStore(dbId, "not-valid-json{{")).rejects.toThrow();
  });
});
