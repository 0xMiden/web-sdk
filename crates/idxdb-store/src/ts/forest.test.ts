import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyForestUpdate,
  ForestUpdate,
  getForestRows,
  getForestSnapshot,
} from "./forest.js";
import { FOREST_REVISION_FIRST, getDatabase, openDatabase } from "./schema.js";
import { uniqueDbName } from "./test-utils.js";
import { uint8ArrayToBase64 } from "./utils.js";

const openDbIds: string[] = [];

afterEach(async () => {
  for (const dbId of openDbIds) {
    const db = getDatabase(dbId);
    db.dexie.close();
    await db.dexie.delete();
  }
  openDbIds.length = 0;
  vi.restoreAllMocks();
});

async function openTestDb(): Promise<string> {
  const dbId = uniqueDbName();
  await openDatabase(dbId, "0.1.0");
  openDbIds.push(dbId);
  return dbId;
}

function makeUpdate(overrides: Partial<ForestUpdate> = {}): ForestUpdate {
  return {
    expectedTrees: [],
    entryUpserts: [],
    entryDeletes: [],
    subtreeUpserts: [],
    subtreeDeletes: [],
    treeUpserts: [],
    ...overrides,
  };
}

async function applyUpdate(
  dbId: string,
  update?: ForestUpdate | null
): Promise<void> {
  const db = getDatabase(dbId);
  await db.dexie.transaction(
    "rw",
    [db.forestRevision, db.forestTrees, db.forestEntries, db.forestSubtrees],
    async (tx) => applyForestUpdate(tx, update)
  );
}

describe("getForestSnapshot", () => {
  it("returns the seeded revision and no trees for a fresh database", async () => {
    const dbId = await openTestDb();

    await expect(getForestSnapshot(dbId)).resolves.toEqual({
      trees: [],
      nextVersion: FOREST_REVISION_FIRST,
    });
  });

  it("returns every tree and the current revision", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.forestTrees.bulkPut([
      {
        lineage: "lineage-a",
        version: "0000000000000002",
        root: "0xroot-a",
        entryCount: 3,
      },
      {
        lineage: "lineage-b",
        version: "0000000000000003",
        root: "0xroot-b",
        entryCount: 0,
      },
    ]);
    await db.forestRevision.put({
      id: 0,
      nextVersion: "0000000000000004",
    });

    const snapshot = await getForestSnapshot(dbId);
    expect(snapshot).toEqual({
      trees: [
        {
          lineage: "lineage-a",
          version: "0000000000000002",
          root: "0xroot-a",
          entryCount: 3,
        },
        {
          lineage: "lineage-b",
          version: "0000000000000003",
          root: "0xroot-b",
          entryCount: 0,
        },
      ],
      nextVersion: "0000000000000004",
    });
  });

  it("rejects when the revision singleton is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dbId = await openTestDb();
    await getDatabase(dbId).forestRevision.clear();

    await expect(getForestSnapshot(dbId)).rejects.toThrow(
      "Reset the IndexedDB database"
    );
  });
});

describe("getForestRows", () => {
  it("loads exact rows, buckets, subtrees, and complete lineages", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    const maxPosition = "ffffffffffffffff";
    const subtreeBlob = new Uint8Array([1, 2, 3, 255]);
    await db.forestEntries.bulkPut([
      {
        lineage: "lineage-a",
        key: "0xkey-a",
        value: "0xvalue-a",
        leafPosition: maxPosition,
      },
      {
        lineage: "lineage-a",
        key: "0xkey-b",
        value: "0xvalue-b",
        leafPosition: maxPosition,
      },
      {
        lineage: "lineage-a",
        key: "0xkey-c",
        value: "0xvalue-c",
        leafPosition: "0000000000000001",
      },
    ]);
    await db.forestSubtrees.put({
      lineage: "lineage-a",
      depth: 8,
      position: maxPosition,
      blob: subtreeBlob,
    });

    const rows = await getForestRows(dbId, {
      entries: [
        { lineage: "lineage-a", key: "0xkey-a" },
        { lineage: "lineage-a", key: "0xmissing" },
      ],
      buckets: [
        { lineage: "lineage-a", leafPosition: maxPosition },
        {
          lineage: "lineage-a",
          leafPosition: "0000000000000002",
        },
      ],
      subtrees: [
        { lineage: "lineage-a", depth: 8, position: maxPosition },
        {
          lineage: "lineage-a",
          depth: 16,
          position: "0000000000000000",
        },
      ],
      fullLineages: ["lineage-a", "lineage-missing"],
      expectedRevision: FOREST_REVISION_FIRST,
    });

    expect(rows).toEqual({
      entries: [
        {
          lineage: "lineage-a",
          key: "0xkey-a",
          value: "0xvalue-a",
          leafPosition: maxPosition,
        },
        { lineage: "lineage-a", key: "0xmissing" },
      ],
      buckets: [
        {
          lineage: "lineage-a",
          leafPosition: maxPosition,
          entries: [
            { key: "0xkey-a", value: "0xvalue-a" },
            { key: "0xkey-b", value: "0xvalue-b" },
          ],
        },
        {
          lineage: "lineage-a",
          leafPosition: "0000000000000002",
          entries: [],
        },
      ],
      subtrees: [
        {
          lineage: "lineage-a",
          depth: 8,
          position: maxPosition,
          blob: uint8ArrayToBase64(subtreeBlob),
        },
        {
          lineage: "lineage-a",
          depth: 16,
          position: "0000000000000000",
        },
      ],
      fullLineages: [
        {
          lineage: "lineage-a",
          rows: [
            {
              key: "0xkey-a",
              value: "0xvalue-a",
              leafPosition: maxPosition,
            },
            {
              key: "0xkey-b",
              value: "0xvalue-b",
              leafPosition: maxPosition,
            },
            {
              key: "0xkey-c",
              value: "0xvalue-c",
              leafPosition: "0000000000000001",
            },
          ],
        },
        { lineage: "lineage-missing", rows: [] },
      ],
    });
  });

  it("rejects rows read from a different forest revision", async () => {
    const dbId = await openTestDb();

    await expect(
      getForestRows(dbId, {
        entries: [],
        buckets: [],
        subtrees: [],
        fullLineages: [],
        expectedRevision: "0000000000000002",
      })
    ).rejects.toMatchObject({
      name: "ForestConflictError",
      message: expect.stringMatching(/^ForestConflictError:/),
    });
  });
});

describe("applyForestUpdate", () => {
  it("validates expectations and applies deletes and upserts", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.forestTrees.put({
      lineage: "existing",
      version: FOREST_REVISION_FIRST,
      root: "0xold-root",
      entryCount: 1,
    });
    await db.forestEntries.put({
      lineage: "existing",
      key: "0xold-key",
      value: "0xold-value",
      leafPosition: "0000000000000001",
    });
    await db.forestSubtrees.put({
      lineage: "existing",
      depth: 8,
      position: "0000000000000001",
      blob: new Uint8Array([9]),
    });

    await applyUpdate(
      dbId,
      makeUpdate({
        expectedTrees: [
          {
            lineage: "existing",
            version: FOREST_REVISION_FIRST,
            root: "0xold-root",
            entryCount: 1,
          },
          { lineage: "new" },
        ],
        allocatedRevision: FOREST_REVISION_FIRST,
        entryDeletes: [{ lineage: "existing", key: "0xold-key" }],
        entryUpserts: [
          {
            lineage: "existing",
            key: "0xnew-key",
            value: "0xnew-value",
            leafPosition: "0000000000000002",
          },
        ],
        subtreeDeletes: [
          {
            lineage: "existing",
            depth: 8,
            position: "0000000000000001",
          },
        ],
        subtreeUpserts: [
          {
            lineage: "existing",
            depth: 16,
            position: "0000000000000002",
            blob: new Uint8Array([4, 5, 6]),
          },
        ],
        treeUpserts: [
          {
            lineage: "existing",
            version: "0000000000000002",
            root: "0xnew-root",
            entryCount: 1,
          },
        ],
      })
    );

    await expect(
      db.forestEntries.get(["existing", "0xold-key"])
    ).resolves.toBeUndefined();
    await expect(
      db.forestEntries.get(["existing", "0xnew-key"])
    ).resolves.toEqual({
      lineage: "existing",
      key: "0xnew-key",
      value: "0xnew-value",
      leafPosition: "0000000000000002",
    });
    await expect(
      db.forestSubtrees.get(["existing", 8, "0000000000000001"])
    ).resolves.toBeUndefined();
    expect(
      await db.forestSubtrees.get(["existing", 16, "0000000000000002"])
    ).toEqual({
      lineage: "existing",
      depth: 16,
      position: "0000000000000002",
      blob: new Uint8Array([4, 5, 6]),
    });
    await expect(db.forestTrees.get("existing")).resolves.toEqual({
      lineage: "existing",
      version: "0000000000000002",
      root: "0xnew-root",
      entryCount: 1,
    });
    await expect(db.forestRevision.get(0)).resolves.toEqual({
      id: 0,
      nextVersion: "0000000000000002",
    });
  });

  it.each([
    ["version", { version: "0000000000000000" }],
    ["root", { root: "0xwrong-root" }],
    ["entry count", { entryCount: 2 }],
  ])("rejects a mismatched tree %s before writing", async (_, mismatch) => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.forestTrees.put({
      lineage: "existing",
      version: FOREST_REVISION_FIRST,
      root: "0xroot",
      entryCount: 1,
    });

    const expected = {
      lineage: "existing",
      version: FOREST_REVISION_FIRST,
      root: "0xroot",
      entryCount: 1,
      ...mismatch,
    };
    const update = makeUpdate({
      expectedTrees: [expected],
      entryUpserts: [
        {
          lineage: "existing",
          key: "0xkey",
          value: "0xvalue",
          leafPosition: "0000000000000001",
        },
      ],
    });

    await expect(applyUpdate(dbId, update)).rejects.toMatchObject({
      name: "ForestConflictError",
    });
    await expect(db.forestEntries.count()).resolves.toBe(0);
  });

  it("rejects an expected-absent lineage that exists", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.forestTrees.put({
      lineage: "existing",
      version: FOREST_REVISION_FIRST,
      root: "0xroot",
      entryCount: 0,
    });

    await expect(
      applyUpdate(
        dbId,
        makeUpdate({
          expectedTrees: [{ lineage: "existing" }],
        })
      )
    ).rejects.toMatchObject({ name: "ForestConflictError" });
  });

  it("rejects a revision mismatch before writing", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    await expect(
      applyUpdate(
        dbId,
        makeUpdate({
          allocatedRevision: "0000000000000002",
          treeUpserts: [
            {
              lineage: "new",
              version: "0000000000000002",
              root: "0xroot",
              entryCount: 0,
            },
          ],
        })
      )
    ).rejects.toMatchObject({ name: "ForestConflictError" });
    await expect(db.forestTrees.count()).resolves.toBe(0);
  });

  it("does nothing when the update is undefined or null", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    await applyUpdate(dbId, undefined);
    await applyUpdate(dbId, null);

    await expect(db.forestRevision.get(0)).resolves.toEqual({
      id: 0,
      nextVersion: FOREST_REVISION_FIRST,
    });
  });

  it("does not read the revision for an empty update", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.forestRevision.clear();

    await expect(applyUpdate(dbId, makeUpdate())).resolves.toBeUndefined();
    await expect(db.forestRevision.count()).resolves.toBe(0);
  });

  it("stores Uint8Array subtree blobs without base64 conversion", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    const blob = new Uint8Array([1, 2, 3]);

    await applyUpdate(
      dbId,
      makeUpdate({
        allocatedRevision: FOREST_REVISION_FIRST,
        subtreeUpserts: [
          {
            lineage: "lineage",
            depth: 8,
            position: "0000000000000001",
            blob,
          },
        ],
      })
    );

    await expect(
      db.forestSubtrees.get(["lineage", 8, "0000000000000001"])
    ).resolves.toEqual({
      lineage: "lineage",
      depth: 8,
      position: "0000000000000001",
      blob,
    });
  });

  it("formats the maximum u64 revision without losing precision", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.forestRevision.put({
      id: 0,
      nextVersion: "fffffffffffffffe",
    });

    await applyUpdate(
      dbId,
      makeUpdate({ allocatedRevision: "fffffffffffffffe" })
    );

    await expect(db.forestRevision.get(0)).resolves.toEqual({
      id: 0,
      nextVersion: "ffffffffffffffff",
    });
  });

  it("rejects revision overflow without modifying the singleton", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await db.forestRevision.put({
      id: 0,
      nextVersion: "ffffffffffffffff",
    });

    await expect(
      applyUpdate(dbId, makeUpdate({ allocatedRevision: "ffffffffffffffff" }))
    ).rejects.toThrow("Forest revision exceeds the maximum u64 value");
    await expect(db.forestRevision.get(0)).resolves.toEqual({
      id: 0,
      nextVersion: "ffffffffffffffff",
    });
  });
});
