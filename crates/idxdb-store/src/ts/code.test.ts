import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  getForestsWithDebugInfo,
  getProcedure,
  getProcedureCount,
  getProcedureRoots,
  insertProcedures,
  insertProceduresWithDebugInfo,
  type CodeForestInput,
} from "./code.js";
import { uint8ArrayToBase64 } from "./utils.js";

let dbCounter = 0;
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
  const name = `test-code-${++dbCounter}-${Date.now()}`;
  await openDatabase(name, "0.1.0");
  openDbIds.push(name);
  return name;
}

function forest(
  commitment: string,
  procedureRoots: string[],
  byte: number
): CodeForestInput {
  return {
    commitment,
    mast: new Uint8Array([byte]),
    debugInfo: new Uint8Array([byte, byte]),
    procedureRoots,
  };
}

describe("code registry", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the forest and debug info of a registered procedure", async () => {
    const dbId = await openTestDb();
    await insertProceduresWithDebugInfo(dbId, [
      forest("0xf1", ["0xa", "0xb"], 1),
    ]);

    const expected = {
      mast: uint8ArrayToBase64(new Uint8Array([1])),
      debugInfo: uint8ArrayToBase64(new Uint8Array([1, 1])),
    };
    expect(await getProcedure(dbId, "0xa")).toEqual(expected);
    expect(await getProcedure(dbId, "0xb")).toEqual(expected);
    expect(await getProcedure(dbId, "0xc")).toBeNull();
  });

  it("returns a forest without debug info", async () => {
    const dbId = await openTestDb();
    await insertProcedures(dbId, [
      {
        commitment: "0xf1",
        mast: new Uint8Array([1]),
        procedureRoots: ["0xa"],
      },
    ]);

    expect(await getProcedure(dbId, "0xa")).toEqual({
      mast: uint8ArrayToBase64(new Uint8Array([1])),
      debugInfo: undefined,
    });
    expect(await getForestsWithDebugInfo(dbId, ["0xf1"])).toEqual([]);
  });

  it("keeps the first forest of a procedure that two forests share", async () => {
    const dbId = await openTestDb();
    await insertProceduresWithDebugInfo(dbId, [
      forest("0xf1", ["0xa", "0xshared"], 1),
      forest("0xf2", ["0xb", "0xshared"], 2),
    ]);

    const first = uint8ArrayToBase64(new Uint8Array([1]));
    const second = uint8ArrayToBase64(new Uint8Array([2]));
    expect((await getProcedure(dbId, "0xshared"))?.mast).toBe(first);
    expect((await getProcedure(dbId, "0xb"))?.mast).toBe(second);
  });

  it("skips a forest that already has debug info", async () => {
    const dbId = await openTestDb();
    await insertProceduresWithDebugInfo(dbId, [forest("0xf1", ["0xa"], 1)]);
    await insertProceduresWithDebugInfo(dbId, [
      { ...forest("0xf1", ["0xa"], 1), debugInfo: new Uint8Array([9]) },
    ]);

    const db = getDatabase(dbId);
    expect(await db.codeMastForests.count()).toBe(1);
    expect(await db.codeProcedures.count()).toBe(1);
    expect((await getProcedure(dbId, "0xa"))?.debugInfo).toBe(
      uint8ArrayToBase64(new Uint8Array([1, 1]))
    );
  });

  it("adds a forest without debug info", async () => {
    const dbId = await openTestDb();

    await insertProceduresWithDebugInfo(dbId, [
      {
        commitment: "0xf1",
        mast: new Uint8Array([1]),
        procedureRoots: ["0xa"],
      },
    ]);

    expect(await getProcedure(dbId, "0xa")).toEqual({
      mast: uint8ArrayToBase64(new Uint8Array([1])),
    });
    expect(await getForestsWithDebugInfo(dbId, ["0xf1"])).toEqual([]);
    expect(await getProcedureRoots(dbId)).toEqual(["0xa"]);
  });

  it("adds debug info to a forest stored without it", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.codeMastForests.put({
      commitment: "0xf1",
      mast: new Uint8Array([1]),
    });

    await insertProceduresWithDebugInfo(dbId, [forest("0xf1", ["0xa"], 1)]);

    expect(await getForestsWithDebugInfo(dbId, ["0xf1", "0xf2"])).toEqual([
      "0xf1",
    ]);
    expect((await getProcedure(dbId, "0xa"))?.debugInfo).toBe(
      uint8ArrayToBase64(new Uint8Array([1, 1]))
    );
  });

  it("changes nothing when the same forests are added twice", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    const forests = [
      {
        commitment: "0xf1",
        mast: new Uint8Array([1]),
        procedureRoots: ["0xa"],
      },
      {
        commitment: "0xf2",
        mast: new Uint8Array([2]),
        procedureRoots: ["0xa", "0xb"],
      },
    ];
    const rows = async () => ({
      forests: await db.codeMastForests.toArray(),
      procedures: await db.codeProcedures.toArray(),
    });

    await insertProcedures(dbId, forests);
    const afterFirst = await rows();
    await insertProcedures(dbId, forests);

    expect(await rows()).toEqual(afterFirst);
    expect(afterFirst.forests).toHaveLength(2);
    expect(afterFirst.procedures).toHaveLength(2);
  });

  it("adds no forest when one of them fails", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    const bulkAdd = db.codeProcedures.bulkAdd.bind(db.codeProcedures);
    let calls = 0;
    vi.spyOn(db.codeProcedures, "bulkAdd").mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("write failed");
      }
      return bulkAdd(...args);
    });

    await expect(
      insertProcedures(dbId, [
        {
          commitment: "0xf1",
          mast: new Uint8Array([1]),
          procedureRoots: ["0xa"],
        },
        {
          commitment: "0xf2",
          mast: new Uint8Array([2]),
          procedureRoots: ["0xb"],
        },
      ])
    ).rejects.toThrow("write failed");

    vi.mocked(db.codeProcedures.bulkAdd).mockRestore();
    expect(await db.codeMastForests.count()).toBe(0);
    expect(await getProcedureRoots(dbId)).toEqual([]);
  });

  it("handles empty input and unknown commitments", async () => {
    const dbId = await openTestDb();

    await insertProcedures(dbId, []);
    await insertProceduresWithDebugInfo(dbId, []);

    expect(await getProcedureRoots(dbId)).toEqual([]);
    expect(await getForestsWithDebugInfo(dbId, [])).toEqual([]);
    expect(await getForestsWithDebugInfo(dbId, ["0xf1", "0xf2"])).toEqual([]);
  });

  it("rethrows errors of an unknown database", async () => {
    await expect(getForestsWithDebugInfo("missing-db", [])).rejects.toThrow();
    await expect(
      insertProceduresWithDebugInfo("missing-db", [])
    ).rejects.toThrow();
    await expect(getProcedure("missing-db", "0xa")).rejects.toThrow();
    await expect(getProcedureRoots("missing-db")).rejects.toThrow();
    await expect(getProcedureCount("missing-db")).rejects.toThrow();
    await expect(insertProcedures("missing-db", [])).rejects.toThrow();
  });
});
