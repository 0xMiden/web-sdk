// Disabling `any` checks since this file mostly deals
// with importing DB types and we're testing this which
// should be enough + the TS compiler.
/* eslint-disable */
import { getDatabase } from "./schema.js";
import { STORE_DUMP_FORMAT_VERSION } from "./export.js";
import { logWebStoreError } from "./utils.js";

const REQUIRED_FOREST_TABLES = [
  "forestRevision",
  "forestTrees",
  "forestEntries",
  "forestSubtrees",
];

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

export async function forceImportStore(dbId: string, jsonStr: string) {
  try {
    const db = getDatabase(dbId);
    let dbJson = JSON.parse(jsonStr);
    if (typeof dbJson === "string") {
      dbJson = JSON.parse(dbJson);
    }

    if (
      dbJson === null ||
      typeof dbJson !== "object" ||
      Array.isArray(dbJson) ||
      dbJson.formatVersion === undefined
    ) {
      throw new Error(
        "The store dump is missing its format marker and cannot be imported."
      );
    }
    if (dbJson.formatVersion !== STORE_DUMP_FORMAT_VERSION) {
      throw new Error(
        `Unsupported store dump format version: ${dbJson.formatVersion}`
      );
    }
    if (
      dbJson.tables === null ||
      typeof dbJson.tables !== "object" ||
      Array.isArray(dbJson.tables)
    ) {
      throw new Error("The store dump does not contain a valid tables object.");
    }

    for (const tableName of REQUIRED_FOREST_TABLES) {
      if (!Array.isArray(dbJson.tables[tableName])) {
        throw new Error(
          `The store dump is missing required forest table "${tableName}".`
        );
      }
    }

    const jsonTableNames = Object.keys(dbJson.tables);
    const dbTableNames = db.dexie.tables.map((t) => t.name);

    const transformedTables: Record<string, any[]> = {};
    for (const tableName of jsonTableNames) {
      if (!dbTableNames.includes(tableName)) {
        console.warn(
          `Table "${tableName}" does not exist in the database schema. Skipping.`
        );
        continue;
      }

      const records = dbJson.tables[tableName];
      if (!Array.isArray(records)) {
        throw new Error(`Table "${tableName}" is not an array.`);
      }
      transformedTables[tableName] = await Promise.all(
        records.map(transformForImport)
      );
    }

    await db.dexie.transaction("rw", db.dexie.tables, async () => {
      await Promise.all(db.dexie.tables.map((t) => t.clear()));

      for (const [tableName, records] of Object.entries(transformedTables)) {
        const table = db.dexie.table(tableName);
        await table.bulkPut(records);
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
