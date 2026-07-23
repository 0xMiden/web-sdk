import { getDatabase } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";
const FOREST_REVISION_ID = 0;
export class ForestConflictError extends Error {
    constructor(message) {
        super(`ForestConflictError: ${message}`);
        this.name = "ForestConflictError";
    }
}
function missingForestRevisionError() {
    return new Error("The forest revision record is missing. Reset the IndexedDB database before continuing.");
}
function base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}
export async function getForestSnapshot(dbId) {
    try {
        const db = getDatabase(dbId);
        return await db.dexie.transaction("r", [db.forestTrees, db.forestRevision], async (tx) => {
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
        });
    }
    catch (error) {
        logWebStoreError(error, "Error while fetching the forest snapshot");
        throw error;
    }
}
export async function getForestRows(dbId, request) {
    try {
        const db = getDatabase(dbId);
        return await db.dexie.transaction("r", [db.forestEntries, db.forestSubtrees, db.forestRevision], async (tx) => {
            const [revision, entries, buckets, subtrees, fullLineages] = await Promise.all([
                request.expectedRevision === undefined
                    ? Promise.resolve(undefined)
                    : tx.forestRevision.get(FOREST_REVISION_ID),
                Promise.all(request.entries.map(async ({ lineage, key }) => {
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
                })),
                Promise.all(request.buckets.map(async ({ lineage, leafPosition }) => {
                    const rows = await tx.forestEntries
                        .where("[lineage+leafPosition]")
                        .equals([lineage, leafPosition])
                        .toArray();
                    return {
                        lineage,
                        leafPosition,
                        entries: rows.map(({ key, value }) => ({ key, value })),
                    };
                })),
                Promise.all(request.subtrees.map(async ({ lineage, depth, position }) => {
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
                })),
                Promise.all(request.fullLineages.map(async (lineage) => {
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
                })),
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
        });
    }
    catch (error) {
        logWebStoreError(error, "Error while fetching forest rows");
        throw error;
    }
}
function expectedTreeIsAbsent(expected) {
    return (expected.version == null &&
        expected.root == null &&
        expected.entryCount == null);
}
function validateExpectedTree(expected, actual) {
    if (expectedTreeIsAbsent(expected)) {
        if (actual !== undefined) {
            throw new ForestConflictError(`Forest lineage ${expected.lineage} was expected to be absent`);
        }
        return;
    }
    if (expected.version == null ||
        expected.root == null ||
        expected.entryCount == null) {
        throw new Error(`Forest lineage ${expected.lineage} has an incomplete expected tree`);
    }
    if (actual === undefined) {
        throw new ForestConflictError(`Forest lineage ${expected.lineage} was expected to exist`);
    }
    if (actual.version !== expected.version) {
        throw new ForestConflictError(`Forest lineage ${expected.lineage} version does not match`);
    }
    if (actual.root !== expected.root) {
        throw new ForestConflictError(`Forest lineage ${expected.lineage} root does not match`);
    }
    if (actual.entryCount !== expected.entryCount) {
        throw new ForestConflictError(`Forest lineage ${expected.lineage} entry count does not match`);
    }
}
export async function applyForestUpdate(tx, update) {
    if (update == null) {
        return;
    }
    if (update.allocatedRevision == null &&
        update.expectedTrees.length === 0 &&
        update.entryUpserts.length === 0 &&
        update.entryDeletes.length === 0 &&
        update.subtreeUpserts.length === 0 &&
        update.subtreeDeletes.length === 0 &&
        update.treeUpserts.length === 0) {
        return;
    }
    const [expectedTrees, revision] = await Promise.all([
        Promise.all(update.expectedTrees.map(async (expected) => ({
            expected,
            actual: await tx.forestTrees.get(expected.lineage),
        }))),
        tx.forestRevision.get(FOREST_REVISION_ID),
    ]);
    if (revision === undefined) {
        throw missingForestRevisionError();
    }
    for (const { expected, actual } of expectedTrees) {
        validateExpectedTree(expected, actual);
    }
    if (update.allocatedRevision != null &&
        revision.nextVersion !== update.allocatedRevision) {
        throw new ForestConflictError("Forest revision does not match");
    }
    if (update.entryDeletes.length > 0) {
        await tx.forestEntries.bulkDelete(update.entryDeletes.map(({ lineage, key }) => [lineage, key]));
    }
    if (update.subtreeDeletes.length > 0) {
        await tx.forestSubtrees.bulkDelete(update.subtreeDeletes.map(({ lineage, depth, position }) => [
            lineage,
            depth,
            position,
        ]));
    }
    if (update.entryUpserts.length > 0) {
        await tx.forestEntries.bulkPut(update.entryUpserts.map(({ lineage, key, value, leafPosition }) => ({
            lineage,
            key,
            value,
            leafPosition,
        })));
    }
    if (update.subtreeUpserts.length > 0) {
        await tx.forestSubtrees.bulkPut(update.subtreeUpserts.map(({ lineage, depth, position, blob }) => ({
            lineage,
            depth,
            position,
            blob: base64ToUint8Array(blob),
        })));
    }
    if (update.treeUpserts.length > 0) {
        await tx.forestTrees.bulkPut(update.treeUpserts.map(({ lineage, version, root, entryCount }) => ({
            lineage,
            version,
            root,
            entryCount,
        })));
    }
    if (update.allocatedRevision != null) {
        const nextRevision = BigInt(`0x${update.allocatedRevision}`) + 1n;
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
