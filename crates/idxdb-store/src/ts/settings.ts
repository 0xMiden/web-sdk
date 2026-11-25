import type { Table } from "dexie";
import { getDatabase, type IKeyValue } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";

// The user settings live in `userSettings` and the data of the client lives in `clientConfig`.
// Both are key-value stores with the same operations.

async function getValue(table: Table<IKeyValue, string>, key: string) {
  const matchingRecord = await table.get(key);
  if (!matchingRecord) {
    return null;
  }
  return {
    key: matchingRecord.key,
    value: uint8ArrayToBase64(matchingRecord.value),
  };
}

// Reports whether the key was present, which the `Store` trait requires of `remove_setting`.
// `Table.delete()` resolves to nothing whether or not a row matched, so the answer comes from a
// read inside the same transaction.
async function removeValue(
  dbId: string,
  table: Table<IKeyValue, string>,
  key: string
): Promise<boolean> {
  return await getDatabase(dbId).dexie.transaction("rw", table, async () => {
    const present = (await table.get(key)) !== undefined;
    if (present) {
      await table.delete(key);
    }
    return present;
  });
}

// USER SETTINGS
// ================================================================================================

export async function getSetting(dbId: string, key: string) {
  try {
    return await getValue(getDatabase(dbId).userSettings, key);
  } catch (error) {
    logWebStoreError(error, `Error while fetching setting key: ${key}`);
  }
}

export async function insertSetting(
  dbId: string,
  key: string,
  value: Uint8Array
): Promise<void> {
  try {
    await getDatabase(dbId).userSettings.put({ key, value });
  } catch (error) {
    logWebStoreError(error, `Error inserting setting with key: ${key}`);
  }
}

export async function removeSetting(
  dbId: string,
  key: string
): Promise<boolean> {
  try {
    return await removeValue(dbId, getDatabase(dbId).userSettings, key);
  } catch (error) {
    logWebStoreError(error, `Error deleting setting with key: ${key}`);
    // Unreachable: logWebStoreError rethrows. Present so the compiler can see
    // that no path returns undefined.
    throw error;
  }
}

export async function listSettingKeys(dbId: string) {
  try {
    return await getDatabase(dbId).userSettings.toCollection().primaryKeys();
  } catch (error) {
    logWebStoreError(error, `Error listing setting keys`);
  }
}

// CLIENT CONFIG
// ================================================================================================

export async function getClientConfig(dbId: string, key: string) {
  try {
    return await getValue(getDatabase(dbId).clientConfig, key);
  } catch (error) {
    logWebStoreError(error, `Error while fetching client config key: ${key}`);
  }
}

export async function insertClientConfig(
  dbId: string,
  key: string,
  value: Uint8Array
): Promise<void> {
  try {
    await getDatabase(dbId).clientConfig.put({ key, value });
  } catch (error) {
    logWebStoreError(error, `Error inserting client config with key: ${key}`);
  }
}

export async function removeClientConfig(
  dbId: string,
  key: string
): Promise<boolean> {
  try {
    return await removeValue(dbId, getDatabase(dbId).clientConfig, key);
  } catch (error) {
    logWebStoreError(error, `Error deleting client config with key: ${key}`);
    // Unreachable: logWebStoreError rethrows. Present so the compiler can see
    // that no path returns undefined.
    throw error;
  }
}
