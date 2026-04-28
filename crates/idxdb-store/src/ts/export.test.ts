import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import { exportStore, transformForExport } from "./export.js";
import { uint8ArrayToBase64 } from "./utils.js";

let dbCounter = 0;
function uniqueDbName(): string {
  return `test-export-${++dbCounter}-${Date.now()}`;
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

// ================================================================================================
// transformForExport unit tests
// ================================================================================================

describe("transformForExport", () => {
  let logSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("converts a Uint8Array to a tagged base64 object", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await transformForExport(bytes);
    expect(result).toEqual({
      __type: "Uint8Array",
      data: uint8ArrayToBase64(bytes),
    });
  });

  it("converts a Blob to a tagged base64 object", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const blob = new Blob([bytes]);
    const result = await transformForExport(blob);
    expect(result).toEqual({
      __type: "Blob",
      data: uint8ArrayToBase64(bytes),
    });
  });

  it("transforms an array recursively", async () => {
    const input = [new Uint8Array([1]), "hello", 42];
    const result = await transformForExport(input);
    expect(result).toEqual([
      { __type: "Uint8Array", data: uint8ArrayToBase64(new Uint8Array([1])) },
      "hello",
      42,
    ]);
  });

  it("transforms a nested record recursively", async () => {
    const bytes = new Uint8Array([7, 8]);
    const input = { key: bytes, count: 5, label: "abc" };
    const result = await transformForExport(input);
    expect(result).toEqual({
      key: { __type: "Uint8Array", data: uint8ArrayToBase64(bytes) },
      count: 5,
      label: "abc",
    });
  });

  it("returns primitives unchanged", async () => {
    expect(await transformForExport(42)).toBe(42);
    expect(await transformForExport("hello")).toBe("hello");
    expect(await transformForExport(null)).toBeNull();
    expect(await transformForExport(true)).toBe(true);
  });

  it("handles deeply nested structures", async () => {
    const bytes = new Uint8Array([99]);
    const input = { outer: { inner: [bytes] } };
    const result = await transformForExport(input);
    expect(result).toEqual({
      outer: {
        inner: [
          { __type: "Uint8Array", data: uint8ArrayToBase64(bytes) },
        ],
      },
    });
  });
});

// ================================================================================================
// exportStore tests
// ================================================================================================

describe("exportStore", () => {
  let logSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("exports an empty DB as a JSON object with all table keys present", async () => {
    const dbId = await openTestDb();
    const jsonStr = await exportStore(dbId);
    const parsed = JSON.parse(jsonStr);

    // All tables in the schema should be present as keys
    const db = getDatabase(dbId);
    const tableNames = db.dexie.tables.map((t) => t.name);
    for (const name of tableNames) {
      expect(parsed).toHaveProperty(name);
      expect(Array.isArray(parsed[name])).toBe(true);
    }
  });

  it("empty DB tables are empty arrays", async () => {
    const dbId = await openTestDb();
    const jsonStr = await exportStore(dbId);
    const parsed = JSON.parse(jsonStr);

    // stateSync gets one row on populate and settings gets the clientVersion row.
    // Everything else should be empty.
    const db = getDatabase(dbId);
    const tableNames = db.dexie.tables.map((t) => t.name);
    const nonEmptyTables = tableNames.filter(
      (name) => parsed[name].length > 0
    );
    expect(nonEmptyTables).toEqual(expect.arrayContaining(["stateSync", "settings"]));
    // tables other than these two must be empty
    const otherNonEmpty = nonEmptyTables.filter(
      (n) => n !== "stateSync" && n !== "settings"
    );
    expect(otherNonEmpty).toHaveLength(0);
  });

  it("exports inputNotes rows and serializes Uint8Array fields as tagged base64", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    const assetBytes = new Uint8Array([10, 20, 30]);
    const serialBytes = new Uint8Array([1, 2, 3, 4]);
    const inputsBytes = new Uint8Array([5, 6]);
    const stateBytes = new Uint8Array([7, 8, 9]);

    await db.inputNotes.put({
      noteId: "note-abc",
      stateDiscriminant: 0,
      assets: assetBytes,
      serialNumber: serialBytes,
      inputs: inputsBytes,
      scriptRoot: "script-root-x",
      nullifier: "nullifier-abc",
      serializedCreatedAt: "2024-01-01",
      state: stateBytes,
    });

    const jsonStr = await exportStore(dbId);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.inputNotes).toHaveLength(1);
    const note = parsed.inputNotes[0];

    // Uint8Array fields should be serialized as tagged base64
    expect(note.assets).toEqual({
      __type: "Uint8Array",
      data: uint8ArrayToBase64(assetBytes),
    });
    expect(note.serialNumber).toEqual({
      __type: "Uint8Array",
      data: uint8ArrayToBase64(serialBytes),
    });
    expect(note.state).toEqual({
      __type: "Uint8Array",
      data: uint8ArrayToBase64(stateBytes),
    });

    // Primitive fields stay as-is
    expect(note.noteId).toBe("note-abc");
    expect(note.scriptRoot).toBe("script-root-x");
    expect(note.nullifier).toBe("nullifier-abc");
  });

  it("exports multiple tables with data", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    await db.accountCodes.put({
      root: "root-1",
      code: new Uint8Array([1, 2]),
    });

    await db.settings.put({
      key: "test-key",
      value: new Uint8Array([3, 4]),
    });

    const jsonStr = await exportStore(dbId);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.accountCode).toHaveLength(1);
    expect(parsed.accountCode[0].root).toBe("root-1");
    expect(parsed.accountCode[0].code).toEqual({
      __type: "Uint8Array",
      data: uint8ArrayToBase64(new Uint8Array([1, 2])),
    });

    // settings has the initial clientVersion row + our test-key
    const settingsKeys = parsed.settings.map((s: any) => s.key);
    expect(settingsKeys).toContain("test-key");
  });

  it("throws for a db that was never opened", async () => {
    await expect(exportStore("never-opened")).rejects.toThrow();
  });
});
