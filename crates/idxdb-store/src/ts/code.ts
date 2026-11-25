import { getDatabase } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";

/** A MAST forest to add to the code registry, with its debug info and procedure roots. */
export interface CodeForestInput {
  commitment: string;
  mast: Uint8Array;
  debugInfo: Uint8Array;
  procedureRoots: string[];
}

/** Returns the commitments, among the given ones, of the forests that have debug info. */
export async function getForestsWithDebugInfo(
  dbId: string,
  commitments: string[]
) {
  try {
    const forests =
      await getDatabase(dbId).codeMastForests.bulkGet(commitments);
    return commitments.filter((_, i) => forests[i]?.debugInfo !== undefined);
  } catch (error) {
    logWebStoreError(error, "Error while fetching code registry forests");
  }
}

/** Returns the procedure roots of the code registry, which are the leaves of the code tree. */
export async function getProcedureRoots(dbId: string) {
  try {
    return await getDatabase(dbId).codeProcedures.toCollection().primaryKeys();
  } catch (error) {
    logWebStoreError(
      error,
      "Error while fetching code registry procedure roots"
    );
  }
}

/**
 * Adds the forests, their debug info and their procedure roots to the code registry, in one
 * transaction.
 *
 * A forest that already has debug info is skipped. A procedure root that is already registered
 * keeps the forest that it was first registered with.
 */
export async function insertProceduresWithDebugInfo(
  dbId: string,
  forests: CodeForestInput[]
): Promise<void> {
  try {
    const db = getDatabase(dbId);
    await db.dexie.transaction(
      "rw",
      db.codeMastForests,
      db.codeProcedures,
      async () => {
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

          // A forest can list the same procedure root more than once.
          const procedureRoots = [...new Set(forest.procedureRoots)];
          const registered = await db.codeProcedures.bulkGet(procedureRoots);
          await db.codeProcedures.bulkAdd(
            procedureRoots
              .filter((_, i) => registered[i] === undefined)
              .map((procedureRoot) => ({
                procedureRoot,
                commitment: forest.commitment,
              }))
          );
        }
      }
    );
  } catch (error) {
    logWebStoreError(error, "Error while inserting code registry procedures");
  }
}

/**
 * Returns the forest that holds the procedure, with the debug info of the forest if the registry
 * has it, or `null` if the procedure is not registered.
 */
export async function getProcedure(dbId: string, procedureRoot: string) {
  try {
    const db = getDatabase(dbId);
    return await db.dexie.transaction(
      "r",
      db.codeMastForests,
      db.codeProcedures,
      async () => {
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
          debugInfo:
            forest.debugInfo === undefined
              ? undefined
              : uint8ArrayToBase64(forest.debugInfo),
        };
      }
    );
  } catch (error) {
    logWebStoreError(error, `Error while fetching procedure: ${procedureRoot}`);
  }
}
