import { getDatabase } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";
/** Returns the commitments, among the given ones, of the forests that have debug info. */
export async function getForestsWithDebugInfo(dbId, commitments) {
    try {
        const forests = await getDatabase(dbId).codeMastForests.bulkGet(commitments);
        return commitments.filter((_, i) => forests[i]?.debugInfo !== undefined);
    }
    catch (error) {
        logWebStoreError(error, "Error while fetching code registry forests");
    }
}
/** Returns the number of procedure roots in the code registry. */
export async function getProcedureCount(dbId) {
    try {
        return await getDatabase(dbId).codeProcedures.count();
    }
    catch (error) {
        logWebStoreError(error, "Error while counting code registry procedures");
    }
}
/** Returns the procedure roots of the code registry, which are the leaves of the code tree. */
export async function getProcedureRoots(dbId) {
    try {
        return await getDatabase(dbId).codeProcedures.toCollection().primaryKeys();
    }
    catch (error) {
        logWebStoreError(error, "Error while fetching code registry procedure roots");
    }
}
/**
 * Adds the forests, their debug info and their procedure roots to the code registry, in one
 * transaction.
 *
 * A forest that already has debug info is skipped, and a forest without debug info is added
 * without it. A procedure root that is already registered keeps the forest that it was first
 * registered with.
 */
export async function insertProceduresWithDebugInfo(dbId, forests) {
    try {
        const db = getDatabase(dbId);
        await db.dexie.transaction("rw", db.codeMastForests, db.codeProcedures, async () => {
            for (const forest of forests) {
                const stored = await db.codeMastForests.get(forest.commitment);
                if (stored?.debugInfo !== undefined) {
                    continue;
                }
                await db.codeMastForests.put({
                    commitment: forest.commitment,
                    mast: forest.mast,
                    debugInfo: forest.debugInfo,
                });
                await registerProcedureRoots(db, forest);
            }
        });
    }
    catch (error) {
        logWebStoreError(error, "Error while inserting code registry procedures");
    }
}
/**
 * Adds the forests and their procedure roots to the code registry, without debug info, in one
 * transaction.
 *
 * A forest that is already stored is kept as it is, with its debug info if it has one. A procedure
 * root that is already registered keeps the forest that it was first registered with.
 */
export async function insertProcedures(dbId, forests) {
    try {
        const db = getDatabase(dbId);
        await db.dexie.transaction("rw", db.codeMastForests, db.codeProcedures, async () => {
            for (const forest of forests) {
                const stored = await db.codeMastForests.get(forest.commitment);
                if (stored === undefined) {
                    await db.codeMastForests.add({
                        commitment: forest.commitment,
                        mast: forest.mast,
                    });
                }
                await registerProcedureRoots(db, forest);
            }
        });
    }
    catch (error) {
        logWebStoreError(error, "Error while inserting code registry procedures");
    }
}
/**
 * Registers the procedure roots of the forest that are not registered yet, inside the caller's
 * transaction.
 */
async function registerProcedureRoots(db, forest) {
    // A forest can list the same procedure root more than once.
    const procedureRoots = [...new Set(forest.procedureRoots)];
    const registered = await db.codeProcedures.bulkGet(procedureRoots);
    await db.codeProcedures.bulkAdd(procedureRoots
        .filter((_, i) => registered[i] === undefined)
        .map((procedureRoot) => ({
        procedureRoot,
        commitment: forest.commitment,
    })));
}
/**
 * Returns the forest that holds the procedure, with the debug info of the forest if the registry
 * has it, or `null` if the procedure is not registered.
 */
export async function getProcedure(dbId, procedureRoot) {
    try {
        const db = getDatabase(dbId);
        return await db.dexie.transaction("r", db.codeMastForests, db.codeProcedures, async () => {
            const procedure = await db.codeProcedures.get(procedureRoot);
            if (procedure === undefined) {
                return null;
            }
            const forest = await db.codeMastForests.get(procedure.commitment);
            /* v8 ignore next 3 - a procedure row is written together with its forest */
            if (forest === undefined) {
                return null;
            }
            return {
                mast: uint8ArrayToBase64(forest.mast),
                debugInfo: forest.debugInfo === undefined
                    ? undefined
                    : uint8ArrayToBase64(forest.debugInfo),
            };
        });
    }
    catch (error) {
        logWebStoreError(error, `Error while fetching procedure: ${procedureRoot}`);
    }
}
