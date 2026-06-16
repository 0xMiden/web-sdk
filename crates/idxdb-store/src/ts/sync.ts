import {
  getDatabase,
  JsVaultAsset,
  JsStorageSlot,
  JsStorageMapEntry,
  IBlockHeader,
  IStateSync,
} from "./schema.js";

import {
  upsertTransactionRecord,
  insertTransactionScript,
} from "./transactions.js";

import { upsertInputNote, upsertOutputNote } from "./notes.js";

import { applyFullAccountState } from "./accounts.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";
import { Transaction } from "dexie";
import Dexie from "dexie";

export async function getNoteTags(dbId: string) {
  try {
    const db = getDatabase(dbId);
    let records = await db.tags.toArray();

    let processedRecords = records.map((record) => {
      record.sourceNoteId =
        record.sourceNoteId == "" ? undefined : record.sourceNoteId;
      record.sourceAccountId =
        record.sourceAccountId == "" ? undefined : record.sourceAccountId;
      record.sourceSubscriptionKey =
        record.sourceSubscriptionKey == ""
          ? undefined
          : record.sourceSubscriptionKey;
      return record;
    });

    return processedRecords;
  } catch (error) {
    logWebStoreError(error, "Error fetch tag record");
  }
}

export async function getSyncHeight(dbId: string) {
  try {
    const db = getDatabase(dbId);
    const record = await db.stateSync.get(1);
    if (record) {
      let data = {
        blockNum: record.blockNum,
      };
      return data;
    } else {
      return null;
    }
  } catch (error) {
    logWebStoreError(error, "Error fetching sync height");
  }
}

export async function addNoteTag(
  dbId: string,
  tag: Uint8Array,
  sourceNoteId: string,
  sourceAccountId: string,
  sourceSubscriptionKey?: string
) {
  try {
    const db = getDatabase(dbId);
    let tagArray = new Uint8Array(tag);
    let tagBase64 = uint8ArrayToBase64(tagArray);
    await db.tags.add({
      tag: tagBase64,
      sourceNoteId: sourceNoteId ? sourceNoteId : "",
      sourceAccountId: sourceAccountId ? sourceAccountId : "",
      sourceSubscriptionKey: sourceSubscriptionKey ? sourceSubscriptionKey : "",
    });
  } catch (error) {
    logWebStoreError(error, "Failed to add note tag");
  }
}

export async function removeNoteTag(
  dbId: string,
  tag: Uint8Array,
  sourceNoteId?: string,
  sourceAccountId?: string,
  sourceSubscriptionKey?: string
) {
  try {
    const db = getDatabase(dbId);
    let tagArray = new Uint8Array(tag);
    let tagBase64 = uint8ArrayToBase64(tagArray);
    const subscriptionKey = sourceSubscriptionKey ? sourceSubscriptionKey : "";

    return await db.tags
      .where({
        tag: tagBase64,
        sourceNoteId: sourceNoteId ? sourceNoteId : "",
        sourceAccountId: sourceAccountId ? sourceAccountId : "",
      })
      // Filtered in JS rather than via the `where` clause: rows written
      // before the column existed lack the property entirely, and a
      // `where` equality on `""` would never match them.
      .and((record) => (record.sourceSubscriptionKey ?? "") == subscriptionKey)
      .delete();
  } catch (error) {
    logWebStoreError(error, "Failed to remove note tag");
  }
}

interface FlattenedU8Vec {
  data(): Uint8Array;
  lengths(): number[];
}

interface SerializedInputNoteData {
  detailsCommitment: string;
  noteId?: string;
  noteAssets: Uint8Array;
  attachments: Uint8Array;
  serialNumber: Uint8Array;
  inputs: Uint8Array;
  noteScriptRoot: string;
  noteScript: Uint8Array;
  nullifier?: string;
  createdAt: string;
  stateDiscriminant: number;
  state: Uint8Array;
  consumedBlockHeight?: number;
  consumedTxOrder?: number;
  consumerAccountId?: string;
}

interface SerializedOutputNoteData {
  detailsCommitment: string;
  noteId: string;
  noteAssets: Uint8Array;
  attachments: Uint8Array;
  recipientDigest: string;
  metadata: Uint8Array;
  nullifier?: string;
  expectedHeight: number;
  stateDiscriminant: number;
  state: Uint8Array;
}

interface SerializedTransactionData {
  id: string;
  details: Uint8Array;
  blockNum: number;
  scriptRoot?: Uint8Array;
  statusVariant: number;
  status: Uint8Array;
  txScript?: Uint8Array;
}

interface JsAccountUpdate {
  storageRoot: string;
  storageSlots: JsStorageSlot[];
  storageMapEntries: JsStorageMapEntry[];
  vaultRoot: string;
  assets: JsVaultAsset[];
  accountId: string;
  codeRoot: string;
  committed: boolean;
  nonce: string;
  accountCommitment: string;
  accountSeed?: Uint8Array;
}

interface JsStateSyncUpdate {
  blockNum: number;
  flattenedNewBlockHeaders: FlattenedU8Vec;
  /** Serialized MMR peaks at the new sync height. A single set per sync update,
   *  written onto the chain-tip block's blockHeaders row. */
  partialBlockchainPeaks: Uint8Array;
  newBlockNums: number[];
  blockHasRelevantNotes: Uint8Array;
  serializedNodeIds: string[];
  serializedNodes: string[];
  committedNoteTagSources: string[];
  serializedInputNotes: SerializedInputNoteData[];
  serializedOutputNotes: SerializedOutputNoteData[];
  accountUpdates: JsAccountUpdate[];
  transactionUpdates: SerializedTransactionData[];
}

export async function applyStateSync(
  dbId: string,
  stateUpdate: JsStateSyncUpdate
) {
  const db = getDatabase(dbId);
  const {
    blockNum,
    flattenedNewBlockHeaders,
    partialBlockchainPeaks,
    newBlockNums,
    blockHasRelevantNotes,
    serializedNodeIds,
    serializedNodes,
    committedNoteTagSources,
    serializedInputNotes,
    serializedOutputNotes,
    accountUpdates,
    transactionUpdates,
  } = stateUpdate;

  const newBlockHeaders = reconstructFlattenedVec(flattenedNewBlockHeaders);

  const tablesToAccess = [
    db.stateSync,
    db.inputNotes,
    db.outputNotes,
    db.notesScripts,
    db.transactions,
    db.transactionScripts,
    db.blockHeaders,
    db.partialBlockchainNodes,
    db.tags,
    db.latestAccountHeaders,
    db.historicalAccountHeaders,
    db.latestAccountStorages,
    db.historicalAccountStorages,
    db.latestStorageMapEntries,
    db.historicalStorageMapEntries,
    db.latestAccountAssets,
    db.historicalAccountAssets,
  ];

  return await db.dexie.transaction("rw", tablesToAccess, async (tx) => {
    await Promise.all([
      Promise.all(
        serializedInputNotes.map((note) => {
          return upsertInputNote(
            dbId,
            note.detailsCommitment,
            note.noteId,
            note.noteAssets,
            note.attachments,
            note.serialNumber,
            note.inputs,
            note.noteScriptRoot,
            note.noteScript,
            note.nullifier,
            note.createdAt,
            note.stateDiscriminant,
            note.state,
            note.consumedBlockHeight,
            note.consumedTxOrder,
            note.consumerAccountId
          );
        })
      ),
      Promise.all(
        serializedOutputNotes.map((note) => {
          return upsertOutputNote(
            dbId,
            note.detailsCommitment,
            note.noteId,
            note.noteAssets,
            note.attachments,
            note.recipientDigest,
            note.metadata,
            note.nullifier,
            note.expectedHeight,
            note.stateDiscriminant,
            note.state
          );
        })
      ),
      Promise.all(
        transactionUpdates.map((transactionRecord) => {
          let promises = [
            upsertTransactionRecord(
              dbId,
              transactionRecord.id,
              transactionRecord.details,
              transactionRecord.blockNum,
              transactionRecord.statusVariant,
              transactionRecord.status,
              transactionRecord.scriptRoot
            ),
          ];

          if (transactionRecord.scriptRoot && transactionRecord.txScript) {
            promises.push(
              insertTransactionScript(
                dbId,
                transactionRecord.scriptRoot,
                transactionRecord.txScript
              )
            );
          }

          return Promise.all(promises);
        })
      ),
      Promise.all(
        accountUpdates.map((accountUpdate) =>
          applyFullAccountState(dbId, {
            accountId: accountUpdate.accountId,
            nonce: accountUpdate.nonce,
            storageSlots: accountUpdate.storageSlots,
            storageMapEntries: accountUpdate.storageMapEntries,
            assets: accountUpdate.assets,
            codeRoot: accountUpdate.codeRoot,
            storageRoot: accountUpdate.storageRoot,
            vaultRoot: accountUpdate.vaultRoot,
            committed: accountUpdate.committed,
            accountCommitment: accountUpdate.accountCommitment,
            accountSeed: accountUpdate.accountSeed,
          })
        )
      ),
      updateSyncHeight(tx, blockNum),
      updatePartialBlockchainNodes(tx, serializedNodeIds, serializedNodes),
      updateCommittedNoteTags(tx, committedNoteTagSources),
      Promise.all(
        newBlockHeaders.map((newBlockHeader, i) => {
          // Peaks are attached only to the chain-tip block (the one whose
          // blockNum matches the new sync height). That row is always
          // present in this iteration because `partial_blockchain_updates`
          // includes the chain tip header by construction.
          // TODO: potentially move this to be under the sync state info table
          // as currently done in SQLite
          const peaks =
            newBlockNums[i] === blockNum ? partialBlockchainPeaks : undefined;
          return updateBlockHeader(
            tx,
            newBlockNums[i],
            newBlockHeader,
            blockHasRelevantNotes[i] == 1,
            peaks
          );
        })
      ),
    ]);
  });
}

/**
 * Advances `stateSync.blockNum` only when moving forward. Mirrors SQLite's
 * `UPDATE blockchain_checkpoint ... WHERE block_num < ?`.
 */
async function updateSyncHeight(tx: Transaction, blockNum: number) {
  try {
    const current = await (
      tx as Transaction & { stateSync: Dexie.Table<IStateSync, number> }
    ).stateSync.get(1);
    if (!current || current.blockNum < blockNum) {
      await (
        tx as Transaction & { stateSync: Dexie.Table<IStateSync, number> }
      ).stateSync.update(1, {
        blockNum: blockNum,
      });
    }
  } catch (error) {
    logWebStoreError(error, "Failed to update sync height");
  }
}

async function updateBlockHeader(
  tx: Transaction,
  blockNum: number,
  blockHeader: Uint8Array,
  hasClientNotes: boolean,
  partialBlockchainPeaks: Uint8Array | undefined
) {
  try {
    const data: IBlockHeader = {
      blockNum: blockNum,
      header: blockHeader,
      hasClientNotes: hasClientNotes.toString(),
      ...(partialBlockchainPeaks !== undefined && { partialBlockchainPeaks }),
    };

    const existingBlockHeader = await (
      tx as Transaction & { blockHeaders: Dexie.Table<IBlockHeader, number> }
    ).blockHeaders.get(blockNum);

    if (!existingBlockHeader) {
      await (
        tx as Transaction & { blockHeaders: Dexie.Table }
      ).blockHeaders.add(data);
    }
  } catch (err) {
    /* v8 ignore next 2 -- IDB errors inside a Dexie tx abort the whole tx; this catch is unreachable */
    logWebStoreError(err, "Failed to insert block header");
  }
}

async function updatePartialBlockchainNodes(
  tx: Transaction,
  nodeIndexes: string[],
  nodes: string[]
) {
  try {
    if (nodeIndexes.length !== nodes.length) {
      throw new Error(
        "nodeIndexes and nodes arrays must be of the same length"
      );
    }

    if (nodeIndexes.length === 0) {
      return;
    }

    const data = nodes.map((node, index) => ({
      id: Number(nodeIndexes[index]),
      node: node,
    }));
    // Use bulkPut to add/overwrite the entries
    await (
      tx as Transaction & { partialBlockchainNodes: Dexie.Table }
    ).partialBlockchainNodes.bulkPut(data);
  } catch (err) {
    logWebStoreError(err, "Failed to update partial blockchain nodes");
  }
}

async function updateCommittedNoteTags(
  tx: Transaction,
  committedNoteTagSources: string[]
) {
  try {
    for (let i = 0; i < committedNoteTagSources.length; i++) {
      const tagSource = committedNoteTagSources[i];
      await (tx as Transaction & { tags: Dexie.Table }).tags
        .where("sourceNoteId")
        .equals(tagSource)
        .delete();
    }
  } catch (error) {
    /* v8 ignore next 2 -- IDB errors inside a Dexie tx abort the whole tx; this catch is unreachable */
    logWebStoreError(error, "Failed to update committed note tags");
  }
}

function reconstructFlattenedVec(flattenedVec: FlattenedU8Vec) {
  const data = flattenedVec.data();
  const lengths = flattenedVec.lengths();

  let index = 0;
  const result: Uint8Array[] = [];
  lengths.forEach((length: number) => {
    result.push(data.slice(index, index + length));
    index += length;
  });
  return result;
}

export async function discardTransactions(
  dbId: string,
  transactions: string[]
) {
  try {
    const db = getDatabase(dbId);
    await db.transactions.where("id").anyOf(transactions).delete();
  } catch (err) {
    logWebStoreError(err, "Failed to discard transactions");
  }
}
