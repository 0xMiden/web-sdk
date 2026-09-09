import { getDatabase } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";

export async function getSetting(dbId: string, scope: number, key: string) {
  try {
    const db = getDatabase(dbId);
    const matchingRecord = await db.settings.get([scope, key]);

    if (!matchingRecord) {
      console.log("No setting record found for given key.");
      return null;
    }

    const valueBase64 = uint8ArrayToBase64(matchingRecord.value);

    return {
      key: matchingRecord.key,
      value: valueBase64,
    };
  } catch (error) {
    logWebStoreError(error, `Error while fetching setting key: ${key}`);
  }
}

export async function insertSetting(
  dbId: string,
  scope: number,
  key: string,
  value: Uint8Array
): Promise<void> {
  try {
    const db = getDatabase(dbId);
    await db.settings.put({ scope, key, value });
  } catch (error) {
    logWebStoreError(
      error,
      `Error inserting setting with key: ${key} and value(base64): ${uint8ArrayToBase64(value)}`
    );
  }
}

// Reports whether the key was present, which the `Store` trait requires of
// `remove_setting`. `Table.delete()` resolves to nothing whether or not a row
// matched, so the answer comes from a read inside the same transaction.
export async function removeSetting(
  dbId: string,
  scope: number,
  key: string
): Promise<boolean> {
  try {
    const db = getDatabase(dbId);
    return await db.dexie.transaction("rw", db.settings, async () => {
      const present = (await db.settings.get([scope, key])) !== undefined;
      if (present) {
        await db.settings.delete([scope, key]);
      }
      return present;
    });
  } catch (error) {
    logWebStoreError(error, `Error deleting setting with key: ${key}`);
    // Unreachable: logWebStoreError rethrows. Present so the compiler can see
    // that no path returns undefined.
    throw error;
  }
}

export async function listSettingKeys(dbId: string, scope: number) {
  try {
    const db = getDatabase(dbId);
    const keys = await db.settings.where("scope").equals(scope).primaryKeys();
    return keys.map(([, key]) => key);
  } catch (error) {
    logWebStoreError(error, `Error listing setting keys`);
  }
}

interface SettingMutation {
  kind: string;
  key: string;
  value?: Uint8Array;
}

export async function applySettingsMutations(
  dbId: string,
  scope: number,
  mutations: SettingMutation[]
): Promise<void> {
  try {
    const db = getDatabase(dbId);
    await db.dexie.transaction("rw", db.settings, async () => {
      for (const mutation of mutations) {
        if (mutation.kind === "set") {
          if (mutation.value === undefined) {
            throw new Error(
              `Setting mutation "set" for key ${mutation.key} is missing a value`
            );
          }
          await db.settings.put({
            scope,
            key: mutation.key,
            value: mutation.value,
          });
        } else if (mutation.kind === "remove") {
          await db.settings.delete([scope, mutation.key]);
        } else {
          throw new Error(`Unknown setting mutation kind: ${mutation.kind}`);
        }
      }
    });
  } catch (error) {
    logWebStoreError(error, "Error applying settings mutations");
  }
}
