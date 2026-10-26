import { afterEach, describe, expect, it, vi } from "vitest";
import * as notes from "./notes.js";
import { closeDatabase, getDatabase, openDatabase } from "./schema.js";
import type { IInputNote } from "./schema.js";
import { uniqueDbName } from "./test-utils.js";

const databases: string[] = [];
const bytes = new Uint8Array([1, 2, 3]);
const key = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;

type Page = {
  notes: { createdAt: string; serializedNoteScript?: string }[];
  nextCursor: string | null;
  exhausted: boolean;
};

async function page(
  dbId: string,
  states = new Uint8Array(),
  afterDetailsCommitment?: string | null,
  limit?: number
): Promise<Page> {
  const query = Reflect.get(notes, "getInputNotesPage");
  expect(query, "bounded input-note paging must be exposed").toBeTypeOf(
    "function"
  );
  return query(dbId, states, afterDetailsCommitment, limit);
}

function row(index: number, stateDiscriminant = 2): IInputNote {
  return {
    detailsCommitment: key(index),
    stateDiscriminant,
    assets: bytes,
    attachments: bytes,
    serialNumber: bytes,
    inputs: bytes,
    scriptRoot: key(900),
    serializedCreatedAt: String(index),
    state: bytes,
  };
}

async function fixture(rows: IInputNote[]) {
  const dbId = uniqueDbName();
  await openDatabase(dbId, "0.1.0");
  databases.push(dbId);
  const db = getDatabase(dbId);
  await db.notesScripts.put({
    scriptRoot: key(900),
    serializedNoteScript: bytes,
  });
  await db.inputNotes.bulkPut(rows);
  return { dbId, db };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dbId of databases.splice(0)) {
    const db = getDatabase(dbId);
    closeDatabase(dbId);
    await db.dexie.delete();
  }
});

function observeRawReads() {
  const reads = { values: 0, keys: 0 };
  const getAll = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = getAll.apply(this, args);
    if (this.name === "inputNotes") {
      request.addEventListener("success", () => {
        reads.values += request.result.length;
      });
    }
    return request;
  });
  const getAllKeys = IDBObjectStore.prototype.getAllKeys;
  vi.spyOn(IDBObjectStore.prototype, "getAllKeys").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = getAllKeys.apply(this, args);
    if (this.name === "inputNotes") {
      request.addEventListener("success", () => {
        reads.keys += request.result.length;
      });
    }
    return request;
  });
  const openCursor = IDBObjectStore.prototype.openCursor;
  vi.spyOn(IDBObjectStore.prototype, "openCursor").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = openCursor.apply(this, args);
    if (this.name === "inputNotes") {
      request.addEventListener("success", () => {
        if (request.result) reads.values++;
      });
    }
    return request;
  });
  const openKeyCursor = IDBObjectStore.prototype.openKeyCursor;
  vi.spyOn(IDBObjectStore.prototype, "openKeyCursor").mockImplementation(
    function (this: IDBObjectStore, ...args) {
      const request = openKeyCursor.apply(this, args);
      if (this.name === "inputNotes") {
        request.addEventListener("success", () => {
          if (request.result) reads.keys++;
        });
      }
      return request;
    }
  );
  return reads;
}

describe("bounded input-note pages", () => {
  it("control: existing details lookup finds metadata-less consumed and expected rows", async () => {
    const { dbId } = await fixture([row(1, 0), row(2, 8), row(3, 2)]);
    const result = await notes.getInputNotesFromDetailsCommitments(dbId, [
      key(2),
      key(1),
    ]);
    expect(result.map((note) => note.createdAt)).toEqual(["1", "2"]);
    expect(result.every((note) => note.serializedNoteScript === "AQID")).toBe(
      true
    );
    expect(await notes.getInputNotesFromDetailsCommitments(dbId, [])).toEqual(
      []
    );
  });

  it("control: native read accounting observes the existing unbounded query", async () => {
    const { dbId } = await fixture(
      Array.from({ length: 300 }, (_, i) => row(i + 1))
    );
    const reads = observeRawReads();
    expect(await notes.getInputNotes(dbId, new Uint8Array())).toHaveLength(300);
    expect(reads.values).toBe(300);
  });

  it("bounds raw scans before filtering and advances empty pages beyond 256 rows", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i + 1));
    rows.push(row(301, 0));
    const { dbId, db } = await fixture(rows);
    const reads = observeRawReads();
    const scripts = vi.spyOn(db.notesScripts, "get");
    const first = await page(dbId, new Uint8Array([0]), null, 128);
    expect(first).toEqual({
      notes: [],
      nextCursor: key(128),
      exhausted: false,
    });
    expect(reads.values).toBe(128);
    expect(reads.values + reads.keys).toBeLessThanOrEqual(129);
    expect(scripts).not.toHaveBeenCalled();
    const second = await page(dbId, new Uint8Array([0]), first.nextCursor, 128);
    expect(second).toEqual({
      notes: [],
      nextCursor: key(256),
      exhausted: false,
    });
    const third = await page(dbId, new Uint8Array([0]), second.nextCursor, 128);
    expect(third.notes.map((note) => note.createdAt)).toEqual(["301"]);
    expect(third.notes[0].serializedNoteScript).toBe("AQID");
    expect(third.nextCursor).toBe(key(301));
    expect(third.exhausted).toBe(true);
    expect(scripts).toHaveBeenCalledOnce();
    expect(reads.values + reads.keys).toBeLessThanOrEqual(303);
  });

  it("defaults to 128 scanned rows including every stored state", async () => {
    const { dbId } = await fixture(
      Array.from({ length: 129 }, (_, i) => row(i + 1, i % 9))
    );
    const result = await page(dbId);
    expect(result.notes).toHaveLength(128);
    expect(result.notes.map((note) => note.createdAt)).toEqual(
      Array.from({ length: 128 }, (_, i) => String(i + 1))
    );
    expect(result.nextCursor).toBe(key(128));
    expect(result.exhausted).toBe(false);
  });

  it("resumes strictly after a deleted cursor and identifies an exact final page", async () => {
    const { dbId, db } = await fixture([row(1), row(2), row(3), row(4)]);
    const first = await page(dbId, undefined, null, 2);
    await db.inputNotes.delete(key(2));
    const second = await page(dbId, undefined, first.nextCursor, 2);
    expect(second.notes.map((note) => note.createdAt)).toEqual(["3", "4"]);
    expect(second.nextCursor).toBe(key(4));
    expect(second.exhausted).toBe(true);
    expect(await page(dbId, undefined, second.nextCursor, 2)).toEqual({
      notes: [],
      nextCursor: key(4),
      exhausted: true,
    });
  });

  it("accepts the 256-row maximum and starts an empty store with a null cursor", async () => {
    const { dbId, db } = await fixture([]);
    expect(await page(dbId)).toEqual({
      notes: [],
      nextCursor: null,
      exhausted: true,
    });
    await db.inputNotes.bulkPut(
      Array.from({ length: 256 }, (_, i) => row(i + 1))
    );
    const result = await page(dbId, undefined, undefined, 256);
    expect(result.notes).toHaveLength(256);
    expect(result.exhausted).toBe(true);
  });

  it.each([0, -1, 257, 1.5, NaN, Infinity])(
    "rejects invalid scan limit %s before reading",
    async (limit) => {
      const { dbId } = await fixture([row(1)]);
      const query = Reflect.get(notes, "getInputNotesPage");
      expect(query).toBeTypeOf("function");
      const reads = observeRawReads();
      await expect(query(dbId, new Uint8Array(), null, limit)).rejects.toThrow(
        /limit/i
      );
      expect(reads).toEqual({ values: 0, keys: 0 });
    }
  );

  it("rejects a malformed cursor and unknown state before reading", async () => {
    const { dbId } = await fixture([row(1)]);
    const query = Reflect.get(notes, "getInputNotesPage");
    expect(query).toBeTypeOf("function");
    const reads = observeRawReads();
    await expect(
      query(dbId, new Uint8Array(), "not-a-commitment", 1)
    ).rejects.toThrow(/cursor|commitment/i);
    await expect(query(dbId, new Uint8Array(), 1, 1)).rejects.toThrow(
      /cursor|commitment/i
    );
    await expect(query(dbId, new Uint8Array([9]), null, 1)).rejects.toThrow(
      /state/i
    );
    expect(reads).toEqual({ values: 0, keys: 0 });
  });

  it("rejects raw state values that are not a byte array", async () => {
    const { dbId } = await fixture([row(1)]);
    const query = Reflect.get(notes, "getInputNotesPage");
    for (const states of [undefined, null, [0], "expected"]) {
      await expect(query(dbId, states)).rejects.toThrow(/state/i);
    }
  });

  it("selects mixed states without duplicating rows and keeps missing scripts undecoded", async () => {
    const missing = row(2, 8);
    missing.scriptRoot = key(901);
    const { dbId } = await fixture([row(1, 0), missing, row(3, 2)]);
    const result = await page(dbId, new Uint8Array([0, 8, 0]));
    expect(result.notes.map((note) => note.createdAt)).toEqual(["1", "2"]);
    expect(result.notes[1].serializedNoteScript).toBeUndefined();
    expect(result.exhausted).toBe(true);
  });

  it("propagates storage read failures instead of returning an empty exhausted page", async () => {
    const { dbId } = await fixture([row(1)]);
    const failure = new DOMException("read failed", "UnknownError");
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(() => {
      throw failure;
    });
    await expect(page(dbId)).rejects.toMatchObject({ name: "UnknownError" });
  });
});
