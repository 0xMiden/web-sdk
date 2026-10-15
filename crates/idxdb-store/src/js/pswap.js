import { getDatabase, PSWAP_STATE_ACTIVE, } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";
/** Returns the record of the lineage of `orderId`, or null if the store does not track it. */
export async function getPswapLineage(dbId, orderId) {
    try {
        const lineage = await getDatabase(dbId).pswapLineages.get(orderId);
        return lineage ? uint8ArrayToBase64(lineage.record) : null;
    }
    catch (error) {
        logWebStoreError(error, `Error while fetching PSWAP lineage: ${orderId}`);
    }
}
/** Returns the order id of the active lineage whose current tip is `tip`, or null. */
export async function getPswapOrderIdByTip(dbId, tip) {
    try {
        const lineage = await getDatabase(dbId)
            .pswapLineages.where("[state+currentTipNoteId]")
            .equals([PSWAP_STATE_ACTIVE, tip])
            .first();
        return lineage ? lineage.orderId : null;
    }
    catch (error) {
        logWebStoreError(error, `Error while fetching PSWAP lineage by tip: ${tip}`);
    }
}
/**
 * Returns the records of the lineages that match the filter: the active lineages if `activeOnly`
 * is true, else the lineages of `creatorAccountId` if it is set, else every lineage.
 */
export async function getPswapLineages(dbId, activeOnly, creatorAccountId) {
    try {
        const table = getDatabase(dbId).pswapLineages;
        let lineages;
        if (activeOnly) {
            lineages = await table
                .filter((l) => l.state === PSWAP_STATE_ACTIVE)
                .toArray();
        }
        else if (creatorAccountId !== undefined) {
            lineages = await table
                .where("creatorAccountId")
                .equals(creatorAccountId)
                .toArray();
        }
        else {
            lineages = await table.toArray();
        }
        return lineages.map((lineage) => uint8ArrayToBase64(lineage.record));
    }
    catch (error) {
        logWebStoreError(error, "Error while fetching PSWAP lineages");
    }
}
/**
 * Inserts the lineage, or replaces the stored lineage of the same order. Rejects an active lineage
 * whose tip is the tip of another active lineage, as the unique index of the SQLite store does.
 */
export async function upsertPswapLineage(dbId, orderId, creatorAccountId, currentTipNoteId, state, record) {
    const lineage = {
        orderId,
        creatorAccountId,
        currentTipNoteId,
        state,
        record,
    };
    try {
        const db = getDatabase(dbId);
        await db.dexie.transaction("rw", db.pswapLineages, async () => {
            if (lineage.state === PSWAP_STATE_ACTIVE) {
                const holder = await db.pswapLineages
                    .where("[state+currentTipNoteId]")
                    .equals([PSWAP_STATE_ACTIVE, lineage.currentTipNoteId])
                    .first();
                if (holder && holder.orderId !== lineage.orderId) {
                    throw new Error(`active PSWAP lineage ${holder.orderId} already has tip ${lineage.currentTipNoteId}`);
                }
            }
            await db.pswapLineages.put(lineage);
        });
    }
    catch (error) {
        logWebStoreError(error, `Error upserting PSWAP lineage: ${lineage.orderId}`);
    }
}
