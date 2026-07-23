import { Transaction } from "dexie";
import { getDatabase } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";

const FOREST_REVISION_ID = 0;

export interface ForestEntryRequest {
  lineage: string;
  key: string;
}

export interface ForestBucketRequest {
  lineage: string;
  leafPosition: string;
}

export interface ForestSubtreeRequest {
  lineage: string;
  depth: number;
  position: string;
}

export interface ForestRowsRequest {
  entries: ForestEntryRequest[];
  buckets: ForestBucketRequest[];
  subtrees: ForestSubtreeRequest[];
  fullLineages: string[];
  expectedRevision?: string;
}

export interface ForestSnapshot {
  trees: {
    lineage: string;
    version: string;
    root: string;
    entryCount: number;
  }[];
  nextVersion: string;
}

export interface ForestRowsResponse {
  entries: {
    lineage: string;
    key: string;
    value?: string;
    leafPosition?: string;
  }[];
  buckets: {
    lineage: string;
    leafPosition: string;
    entries: { key: string; value: string }[];
  }[];
  subtrees: {
    lineage: string;
    depth: number;
    position: string;
    blob?: string;
  }[];
  fullLineages: {
    lineage: string;
    rows: { key: string; value: string; leafPosition: string }[];
  }[];
}

interface ForestExpectedTree {
  lineage: string;
  version?: string;
  root?: string;
  entryCount?: number;
}

interface ForestEntryWrite {
  lineage: string;
  key: string;
  value: string;
  leafPosition: string;
}

interface ForestEntryDelete {
  lineage: string;
  key: string;
}

interface ForestSubtreeWrite {
  lineage: string;
  depth: number;
  position: string;
  blob: Uint8Array;
}

interface ForestSubtreeDelete {
  lineage: string;
  depth: number;
  position: string;
}

interface ForestTreeWrite {
  lineage: string;
  version: string;
  root: string;
  entryCount: number;
}

export interface ForestUpdate {
  expectedTrees: ForestExpectedTree[];
  allocatedRevision?: string;
  entryUpserts: ForestEntryWrite[];
  entryDeletes: ForestEntryDelete[];
  subtreeUpserts: ForestSubtreeWrite[];
  subtreeDeletes: ForestSubtreeDelete[];
  treeUpserts: ForestTreeWrite[];
}

export class ForestConflictError extends Error {
  constructor(message: string) {
    super(`ForestConflictError: ${message}`);
    this.name = "ForestConflictError";
  }
}

function missingForestRevisionError(): Error {
  return new Error(
    "The forest revision record is missing. Reset the IndexedDB database before continuing."
  );
}

export async function getForestSnapshot(dbId: string): Promise<ForestSnapshot> {
  try {
    const db = getDatabase(dbId);
    return await db.dexie.transaction(
      "r",
      [db.forestTrees, db.forestRevision],
      async (tx) => {
        const [trees, revision] = await Promise.all([
          tx.forestTrees.toArray(),
          tx.forestRevision.get(FOREST_REVISION_ID),
        ]);

        if (revision === undefined) {
          throw missingForestRevisionError();
        }

        return {
          trees: trees.map(({ lineage, version, root, entryCount }) => ({
            lineage,
            version,
            root,
            entryCount,
          })),
          nextVersion: revision.nextVersion,
        };
      }
    );
  } catch (error) {
    logWebStoreError(error, "Error while fetching the forest snapshot");
    throw error;
  }
}

export async function getForestRows(
  dbId: string,
  request: ForestRowsRequest
): Promise<ForestRowsResponse> {
  try {
    const db = getDatabase(dbId);
    return await db.dexie.transaction(
      "r",
      [db.forestEntries, db.forestSubtrees, db.forestRevision],
      async (tx) => {
        const [revision, entries, buckets, subtrees, fullLineages] =
          await Promise.all([
            request.expectedRevision === undefined
              ? Promise.resolve(undefined)
              : tx.forestRevision.get(FOREST_REVISION_ID),
            Promise.all(
              request.entries.map(async ({ lineage, key }) => {
                const row = await tx.forestEntries.get([lineage, key]);
                if (row === undefined) {
                  return { lineage, key };
                }
                return {
                  lineage,
                  key,
                  value: row.value,
                  leafPosition: row.leafPosition,
                };
              })
            ),
            Promise.all(
              request.buckets.map(async ({ lineage, leafPosition }) => {
                const rows = await tx.forestEntries
                  .where("[lineage+leafPosition]")
                  .equals([lineage, leafPosition])
                  .toArray();
                return {
                  lineage,
                  leafPosition,
                  entries: rows.map(({ key, value }) => ({ key, value })),
                };
              })
            ),
            Promise.all(
              request.subtrees.map(async ({ lineage, depth, position }) => {
                const row = await tx.forestSubtrees.get([
                  lineage,
                  depth,
                  position,
                ]);
                if (row === undefined) {
                  return { lineage, depth, position };
                }
                return {
                  lineage,
                  depth,
                  position,
                  blob: uint8ArrayToBase64(row.blob),
                };
              })
            ),
            Promise.all(
              request.fullLineages.map(async (lineage) => {
                const rows = await tx.forestEntries
                  .where("lineage")
                  .equals(lineage)
                  .toArray();
                return {
                  lineage,
                  rows: rows.map(({ key, value, leafPosition }) => ({
                    key,
                    value,
                    leafPosition,
                  })),
                };
              })
            ),
          ]);

        if (request.expectedRevision !== undefined) {
          if (revision === undefined) {
            throw missingForestRevisionError();
          }
          if (revision.nextVersion !== request.expectedRevision) {
            throw new ForestConflictError("Forest revision does not match");
          }
        }

        return { entries, buckets, subtrees, fullLineages };
      }
    );
  } catch (error) {
    logWebStoreError(error, "Error while fetching forest rows");
    throw error;
  }
}

function expectedTreeIsAbsent(expected: ForestExpectedTree): boolean {
  return (
    expected.version == null &&
    expected.root == null &&
    expected.entryCount == null
  );
}

function validateExpectedTree(
  expected: ForestExpectedTree,
  actual:
    | {
        version: string;
        root: string;
        entryCount: number;
      }
    | undefined
): void {
  if (expectedTreeIsAbsent(expected)) {
    if (actual !== undefined) {
      throw new ForestConflictError(
        `Forest lineage ${expected.lineage} was expected to be absent`
      );
    }
    return;
  }

  if (
    expected.version == null ||
    expected.root == null ||
    expected.entryCount == null
  ) {
    throw new Error(
      `Forest lineage ${expected.lineage} has an incomplete expected tree`
    );
  }

  if (actual === undefined) {
    throw new ForestConflictError(
      `Forest lineage ${expected.lineage} was expected to exist`
    );
  }
  if (actual.version !== expected.version) {
    throw new ForestConflictError(
      `Forest lineage ${expected.lineage} version does not match`
    );
  }
  if (actual.root !== expected.root) {
    throw new ForestConflictError(
      `Forest lineage ${expected.lineage} root does not match`
    );
  }
  if (actual.entryCount !== expected.entryCount) {
    throw new ForestConflictError(
      `Forest lineage ${expected.lineage} entry count does not match`
    );
  }
}

export async function applyForestUpdate(
  tx: Transaction,
  update?: ForestUpdate | null
): Promise<void> {
  if (update == null) {
    return;
  }

  const {
    expectedTrees,
    allocatedRevision,
    entryUpserts,
    entryDeletes,
    subtreeUpserts,
    subtreeDeletes,
    treeUpserts,
  } = update;

  if (
    allocatedRevision === undefined &&
    expectedTrees.length === 0 &&
    entryUpserts.length === 0 &&
    entryDeletes.length === 0 &&
    subtreeUpserts.length === 0 &&
    subtreeDeletes.length === 0 &&
    treeUpserts.length === 0
  ) {
    return;
  }

  const [actualTrees, revision] = await Promise.all([
    tx.forestTrees.bulkGet(expectedTrees.map((expected) => expected.lineage)),
    tx.forestRevision.get(FOREST_REVISION_ID),
  ]);

  if (revision === undefined) {
    throw missingForestRevisionError();
  }

  for (let i = 0; i < expectedTrees.length; i++) {
    validateExpectedTree(expectedTrees[i], actualTrees[i]);
  }

  if (
    allocatedRevision !== undefined &&
    revision.nextVersion !== allocatedRevision
  ) {
    throw new ForestConflictError("Forest revision does not match");
  }

  if (entryDeletes.length > 0) {
    await tx.forestEntries.bulkDelete(
      entryDeletes.map(({ lineage, key }) => [lineage, key])
    );
  }
  if (subtreeDeletes.length > 0) {
    await tx.forestSubtrees.bulkDelete(
      subtreeDeletes.map(({ lineage, depth, position }) => [
        lineage,
        depth,
        position,
      ])
    );
  }
  if (entryUpserts.length > 0) {
    await tx.forestEntries.bulkPut(entryUpserts);
  }
  if (subtreeUpserts.length > 0) {
    await tx.forestSubtrees.bulkPut(subtreeUpserts);
  }
  if (treeUpserts.length > 0) {
    await tx.forestTrees.bulkPut(treeUpserts);
  }

  if (allocatedRevision !== undefined) {
    const nextRevision = BigInt(`0x${allocatedRevision}`) + 1n;
    if (nextRevision > 0xffffffffffffffffn) {
      throw new Error("Forest revision exceeds the maximum u64 value");
    }
    const nextVersion = nextRevision.toString(16).padStart(16, "0");
    await tx.forestRevision.put({
      id: FOREST_REVISION_ID,
      nextVersion,
    });
  }
}
