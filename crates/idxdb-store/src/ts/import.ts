// Disabling `any` checks since this file mostly deals
// with importing DB types and we're testing this which
// should be enough + the TS compiler.
/* eslint-disable */
import * as semver from "semver";
import {
  CLIENT_VERSION_SETTING_KEY,
  getDatabase,
  MIGRATION_BASELINE,
  SETTING_SCOPE_CLIENT,
  splitLegacySettings,
} from "./schema.js";
import { logWebStoreError } from "./utils.js";
type ImportableInput =
  | { type: "Blob"; value: { __type: "Blob"; data: string } }
  | { type: "Uint8Array"; value: { __type: "Uint8Array"; data: string } }
  | { type: "Array"; value: any[] }
  | { type: "Object"; value: Record<string, any> }
  | { type: "Primitive"; value: any };

async function recursivelyTransformForImport(
  obj: ImportableInput
): Promise<any> {
  switch (obj.type) {
    case "Blob":
      return new Blob([base64ToUint8Array(obj.value.data)]);
    case "Uint8Array":
      return base64ToUint8Array(obj.value.data);
    case "Array":
      return await Promise.all(
        obj.value.map((v) =>
          recursivelyTransformForImport({ type: getImportType(v), value: v })
        )
      );
    case "Object":
      return Object.fromEntries(
        await Promise.all(
          Object.entries(obj.value).map(async ([key, value]) => [
            key,
            await recursivelyTransformForImport({
              type: getImportType(value),
              value,
            }),
          ])
        )
      );
    case "Primitive":
      return obj.value;
  }
}

function getImportType(value: any): ImportableInput["type"] {
  if (value && typeof value === "object" && value.__type === "Blob") {
    return "Blob";
  }
  if (value && typeof value === "object" && value.__type === "Uint8Array") {
    return "Uint8Array";
  }
  if (Array.isArray(value)) return "Array";
  if (value && typeof value === "object") return "Object";
  return "Primitive";
}

export async function transformForImport(obj: any): Promise<any> {
  return recursivelyTransformForImport({
    type: getImportType(obj),
    value: obj,
  });
}

const CLIENT_CONFIG_TABLE = "clientConfig";
const USER_SETTINGS_TABLE = "userSettings";
// The table that schema version 11 removed.
const LEGACY_SETTINGS_TABLE = "settings";

// An import writes rows without the upgrade() callbacks an open runs, so it takes only a dump this
// store could have kept: one stamped by a client at or after MIGRATION_BASELINE and not newer than
// the client running in this realm (the version the store was opened with; with none recorded the
// newer check is skipped). Anything else is refused before the target is cleared.
async function refuseUnkeptDump(dbJson: any, runningVersion: string | null) {
  // The stamp is a `clientConfig` row. A dump taken before schema version 10 has it as a client
  // row of `settings`.
  const rowsOf = (table: string): any[] =>
    Array.isArray(dbJson[table]) ? dbJson[table] : [];
  const stampRow =
    rowsOf(CLIENT_CONFIG_TABLE).find(
      (row) => row?.key === CLIENT_VERSION_SETTING_KEY
    ) ??
    rowsOf(LEGACY_SETTINGS_TABLE).find(
      (row) =>
        row?.scope === SETTING_SCOPE_CLIENT &&
        row?.key === CLIENT_VERSION_SETTING_KEY
    );
  const refuse = (reason: string) => {
    throw new Error(
      `Refusing to import this store dump: ${reason}. The store was not changed.`
    );
  };
  if (!stampRow) {
    refuse(
      `it has no client version stamp, so it predates ${MIGRATION_BASELINE}`
    );
  }
  const stamp = new TextDecoder().decode(
    (await transformForImport(stampRow)).value
  );
  if (!semver.valid(stamp)) {
    refuse(`"${stamp}" is not a valid client version`);
  }
  if (semver.lt(stamp, MIGRATION_BASELINE)) {
    refuse(
      `it was exported by client ${stamp}, older than ${MIGRATION_BASELINE}, whose data cannot be migrated`
    );
  }
  if (
    runningVersion &&
    semver.valid(runningVersion) &&
    semver.gt(stamp, runningVersion)
  ) {
    refuse(
      `it was exported by a newer client (${stamp}; this client is ${runningVersion}); upgrade the Miden SDK to import it`
    );
  }
}

export async function forceImportStore(dbId: string, jsonStr: string) {
  try {
    const db = getDatabase(dbId);
    let dbJson = JSON.parse(jsonStr);
    if (typeof dbJson === "string") {
      dbJson = JSON.parse(dbJson);
    }

    const jsonTableNames = Object.keys(dbJson);
    const dbTableNames = db.dexie.tables.map((t) => t.name);

    if (jsonTableNames.length === 0) {
      throw new Error("No tables found in the provided JSON.");
    }
    await refuseUnkeptDump(dbJson, db.clientVersion || null);

    await db.dexie.transaction("rw", dbTableNames, async () => {
      await Promise.all(db.dexie.tables.map((t) => t.clear()));

      for (const tableName of jsonTableNames) {
        // A dump taken before schema version 10 keeps its settings in one table. Its rows are
        // split as the version 10 upgrade splits them, which also drops the rows that the
        // earlier upgrades delete.
        if (
          tableName === LEGACY_SETTINGS_TABLE &&
          !dbTableNames.includes(tableName)
        ) {
          const rows = await Promise.all(
            dbJson[tableName].map(transformForImport)
          );
          const { userSettings, clientConfig } = splitLegacySettings(rows);
          await db.dexie.table(USER_SETTINGS_TABLE).bulkPut(userSettings);
          await db.dexie.table(CLIENT_CONFIG_TABLE).bulkPut(clientConfig);
          continue;
        }

        const table = db.dexie.table(tableName);

        if (!dbTableNames.includes(tableName)) {
          console.warn(
            `Table "${tableName}" does not exist in the database schema. Skipping.`
          );
          continue;
        }

        const records = dbJson[tableName];

        const transformedRecords = await Promise.all(
          records.map(transformForImport)
        );

        await table.bulkPut(transformedRecords);
      }

      // The dump brought its own stamp; the store now belongs to the running client, as after an
      // open. With no recorded version the dump's stamp stays.
      if (db.clientVersion) {
        await db.persistClientVersion(db.clientVersion);
      }
    });

    console.log("Store imported successfully.");
  } catch (err) {
    logWebStoreError(err);
  }
}

function base64ToUint8Array(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
