import { getDatabase } from "./schema.js";
import {
  logWebStoreError,
  putPartialBlockchainNodesNoOverwrite,
  uint8ArrayToBase64,
} from "./utils.js";

export async function insertBlockHeader(
  dbId: string,
  blockNum: number,
  header: Uint8Array,
  hasClientNotes: boolean,
  nodeIds: string[],
  nodes: string[]
) {
  try {
    const db = getDatabase(dbId);
    if (nodeIds.length !== nodes.length) {
      throw new Error("nodeIds and nodes arrays must be of the same length");
    }

    const headerData = {
      blockNum: blockNum,
      header,
      hasClientNotes: hasClientNotes.toString(),
    };
    const nodeData = nodes.map((node, index) => ({
      id: Number(nodeIds[index]),
      node: node,
    }));

    // Persist the header and its MMR nodes in one transaction so a header is never stored
    // without the nodes that rebuild its `PartialMmr` (mirrors miden-client's atomic insert).
    await db.dexie.transaction(
      "rw",
      db.blockHeaders,
      db.partialBlockchainNodes,
      async () => {
        // Header: INSERT OR IGNORE, then one-way upgrade `has_client_notes` to true
        // (`get_tracked_block_header_numbers` filters on it to seed forest-node tracking).
        await db.blockHeaders.add(headerData).catch(async (err: unknown) => {
          if (!isConstraintError(err)) throw err;
          if (hasClientNotes) {
            await db.blockHeaders.update(blockNum, { hasClientNotes: "true" });
          }
        });

        // Nodes: insert-if-missing with overwrite protection; a conflicting value throws and
        // aborts the transaction, rolling back the header write too.
        await putPartialBlockchainNodesNoOverwrite(
          db.partialBlockchainNodes,
          nodeData
        );
      }
    );
  } catch (err) {
    logWebStoreError(err);
  }
}

/** Detect Dexie's primary-key collision error across sync + bulk wrappings. */
function isConstraintError(err: unknown): boolean {
  const e = err as
    | { name?: string; inner?: { name?: string } }
    | null
    | undefined;
  return e?.name === "ConstraintError" || e?.inner?.name === "ConstraintError";
}

export async function insertPartialBlockchainNodes(
  dbId: string,
  ids: string[],
  nodes: string[]
) {
  try {
    const db = getDatabase(dbId);
    if (ids.length !== nodes.length) {
      throw new Error("ids and nodes arrays must be of the same length");
    }

    if (ids.length === 0) {
      return;
    }

    const data = nodes.map((node, index) => ({
      id: Number(ids[index]),
      node: node,
    }));

    // Wrap the read/check/add in a single transaction so the conflict check
    // and the insert are atomic: a concurrent writer cannot slip a row in
    // between the `bulkGet` and the `bulkAdd`.
    await db.dexie.transaction("rw", db.partialBlockchainNodes, async () => {
      await putPartialBlockchainNodesNoOverwrite(
        db.partialBlockchainNodes,
        data
      );
    });
  } catch (err) {
    logWebStoreError(err, "Failed to insert partial blockchain nodes");
  }
}

export async function getBlockHeaders(dbId: string, blockNumbers: number[]) {
  try {
    const db = getDatabase(dbId);
    const results = await db.blockHeaders.bulkGet(blockNumbers);

    const processedResults = await Promise.all(
      results.map((result) => {
        if (result === undefined) {
          return null;
        } else {
          const headerBase64 = uint8ArrayToBase64(result.header);

          return {
            blockNum: result.blockNum,
            header: headerBase64,
            hasClientNotes: result.hasClientNotes === "true",
          };
        }
      })
    );

    return processedResults;
  } catch (err) {
    logWebStoreError(err, "Failed to get block headers");
  }
}

export async function getTrackedBlockHeaders(dbId: string) {
  try {
    const db = getDatabase(dbId);
    const allMatchingRecords = await db.blockHeaders
      .where("hasClientNotes")
      .equals("true")
      .toArray();

    const processedRecords = await Promise.all(
      allMatchingRecords.map((record) => {
        const headerBase64 = uint8ArrayToBase64(record.header);

        return {
          blockNum: record.blockNum,
          header: headerBase64,
          hasClientNotes: record.hasClientNotes === "true",
        };
      })
    );

    return processedRecords;
  } catch (err) {
    logWebStoreError(err, "Failed to get tracked block headers");
  }
}

export async function getTrackedBlockHeaderNumbers(dbId: string) {
  try {
    const db = getDatabase(dbId);
    const blockNums = await db.blockHeaders
      .where("hasClientNotes")
      .equals("true")
      .primaryKeys();
    return blockNums;
  } catch (err) {
    logWebStoreError(err, "Failed to get tracked block header numbers");
  }
}

export async function getPartialBlockchainNodesAll(dbId: string) {
  try {
    const db = getDatabase(dbId);
    const partialBlockchainNodesAll = await db.partialBlockchainNodes.toArray();
    return partialBlockchainNodesAll;
  } catch (err) {
    logWebStoreError(err, "Failed to get partial blockchain nodes");
  }
}

export async function getPartialBlockchainNodes(dbId: string, ids: string[]) {
  try {
    const db = getDatabase(dbId);
    const numericIds = ids.map((id) => Number(id));
    const results = await db.partialBlockchainNodes.bulkGet(numericIds);

    // bulkGet returns undefined for missing keys — filter them out so the
    // Rust deserializer does not choke on undefined values.
    return results.filter((r) => r !== undefined);
  } catch (err) {
    logWebStoreError(err, "Failed to get partial blockchain nodes");
  }
}

export async function getPartialBlockchainNodesUpToInOrderIndex(
  dbId: string,
  maxInOrderIndex: string
) {
  try {
    const db = getDatabase(dbId);
    const maxNumericId = Number(maxInOrderIndex);
    const results = await db.partialBlockchainNodes
      .where("id")
      .belowOrEqual(maxNumericId)
      .toArray();
    return results;
  } catch (err) {
    logWebStoreError(err, "Failed to get partial blockchain nodes up to index");
  }
}

export async function pruneIrrelevantBlocks(
  dbId: string,
  blocksToUntrack: number[],
  nodeIdsToRemove: string[]
) {
  try {
    const db = getDatabase(dbId);
    const numericNodeIds = nodeIdsToRemove.map(Number);

    const syncHeight = await db.blockchainCheckpoint.get(1);
    if (syncHeight == undefined) {
      throw Error(
        "SyncHeight is undefined -- is the blockchain_checkpoint table empty?"
      );
    }

    await db.dexie.transaction(
      "rw",
      db.blockHeaders,
      db.partialBlockchainNodes,
      async () => {
        // 1. Delete stale MMR authentication nodes.
        if (numericNodeIds.length > 0) {
          await db.partialBlockchainNodes.bulkDelete(numericNodeIds);
        }

        // 2. Mark untracked blocks as irrelevant.
        if (blocksToUntrack.length > 0) {
          await db.blockHeaders
            .where("blockNum")
            .anyOf(blocksToUntrack)
            .modify({ hasClientNotes: "false" });
        }

        // 3. Delete irrelevant block headers.
        const allMatchingRecords = await db.blockHeaders
          .where("hasClientNotes")
          .equals("false")
          .and(
            (record) =>
              record.blockNum !== 0 && record.blockNum !== syncHeight.blockNum
          )
          .toArray();

        await db.blockHeaders.bulkDelete(
          allMatchingRecords.map((r) => r.blockNum)
        );
      }
    );
  } catch (err) {
    logWebStoreError(err, "Failed to prune irrelevant blocks");
  }
}
