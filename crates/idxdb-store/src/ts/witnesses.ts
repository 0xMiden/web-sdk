import type { Transaction } from "dexie";

import { getDatabase } from "./schema.js";
import { logWebStoreError } from "./utils.js";

// INSERT, not upsert: registering again must keep a witness the sync already cached.
export async function trackAccountWitness(
  dbId: string,
  accountId: string
): Promise<boolean> {
  try {
    const db = getDatabase(dbId);
    return await db.dexie.transaction("rw", db.accountWitnesses, async () => {
      const existing = await db.accountWitnesses.get(accountId);
      if (existing) {
        return false;
      }
      await db.accountWitnesses.add({ accountId, witness: null });
      return true;
    });
  } catch (error) {
    logWebStoreError(error, `Error tracking account witness ${accountId}`);
    throw error;
  }
}

export async function untrackAccountWitness(
  dbId: string,
  accountId: string
): Promise<boolean> {
  try {
    const db = getDatabase(dbId);
    return await db.dexie.transaction("rw", db.accountWitnesses, async () => {
      const existing = await db.accountWitnesses.get(accountId);
      if (!existing) {
        return false;
      }
      await db.accountWitnesses.delete(accountId);
      return true;
    });
  } catch (error) {
    logWebStoreError(error, `Error untracking account witness ${accountId}`);
    throw error;
  }
}

export async function trackedAccountWitnesses(dbId: string): Promise<string[]> {
  try {
    const db = getDatabase(dbId);
    const rows = await db.accountWitnesses.toArray();
    return rows.map((row) => row.accountId);
  } catch (error) {
    logWebStoreError(error, "Error listing tracked account witnesses");
    throw error;
  }
}

// Missing row and a registered row whose witness is still null are both "not cached".
export async function getAccountWitness(
  dbId: string,
  accountId: string
): Promise<Uint8Array | null> {
  try {
    const db = getDatabase(dbId);
    const row = await db.accountWitnesses.get(accountId);
    return row?.witness ?? null;
  } catch (error) {
    logWebStoreError(error, `Error fetching account witness ${accountId}`);
    throw error;
  }
}

// UPDATE, not upsert: only trackAccountWitness registers an account. A sync
// write for an account that is not registered is a no-op.
export async function updateAccountWitness(
  dbId: string,
  accountId: string,
  witness: Uint8Array,
  tx?: Transaction
): Promise<boolean> {
  try {
    const db = getDatabase(dbId);
    const write = async (transaction: Transaction) => {
      const updated = await transaction.accountWitnesses.update(accountId, {
        witness,
      });
      return updated > 0;
    };
    if (tx) {
      return await write(tx);
    }
    return await db.dexie.transaction("rw", db.accountWitnesses, write);
  } catch (error) {
    logWebStoreError(error, `Error updating account witness ${accountId}`);
    throw error;
  }
}
