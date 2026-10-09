// Disabling `any` checks since this file mostly deals
// with importing DB types and we're testing this which
// should be enough + the TS compiler.
/* eslint-disable */
import * as semver from "semver";
import { CLIENT_VERSION_SETTING_KEY, getDatabase, MIGRATION_BASELINE, NOTE_TRANSPORT_OUTBOX_SETTING_KEY, readClientVersion, SETTING_SCOPE_CLIENT, } from "./schema.js";
import { logWebStoreError } from "./utils.js";
async function recursivelyTransformForImport(obj) {
    switch (obj.type) {
        case "Blob":
            return new Blob([base64ToUint8Array(obj.value.data)]);
        case "Uint8Array":
            return base64ToUint8Array(obj.value.data);
        case "Array":
            return await Promise.all(obj.value.map((v) => recursivelyTransformForImport({ type: getImportType(v), value: v })));
        case "Object":
            return Object.fromEntries(await Promise.all(Object.entries(obj.value).map(async ([key, value]) => [
                key,
                await recursivelyTransformForImport({
                    type: getImportType(value),
                    value,
                }),
            ])));
        case "Primitive":
            return obj.value;
    }
}
function getImportType(value) {
    if (value && typeof value === "object" && value.__type === "Blob") {
        return "Blob";
    }
    if (value && typeof value === "object" && value.__type === "Uint8Array") {
        return "Uint8Array";
    }
    if (Array.isArray(value))
        return "Array";
    if (value && typeof value === "object")
        return "Object";
    return "Primitive";
}
export async function transformForImport(obj) {
    return recursivelyTransformForImport({
        type: getImportType(obj),
        value: obj,
    });
}
// An import writes rows without the upgrade() callbacks an open runs, so it takes only a dump this
// store could have kept: one stamped by a client at or after MIGRATION_BASELINE and not newer than
// the running one, whose stamp `open` wrote into the target. Anything else is refused before the
// target is cleared.
async function refuseUnkeptDump(dbJson, runningVersion) {
    const rows = Array.isArray(dbJson.settings) ? dbJson.settings : [];
    const stampRow = rows.find((row) => row?.scope === SETTING_SCOPE_CLIENT &&
        row?.key === CLIENT_VERSION_SETTING_KEY);
    const refuse = (reason) => {
        throw new Error(`Refusing to import this store dump: ${reason}. The store was not changed.`);
    };
    if (!stampRow) {
        refuse(`it has no client version stamp, so it predates ${MIGRATION_BASELINE}`);
    }
    const stamp = new TextDecoder().decode((await transformForImport(stampRow)).value);
    if (!semver.valid(stamp)) {
        refuse(`"${stamp}" is not a valid client version`);
    }
    if (semver.lt(stamp, MIGRATION_BASELINE)) {
        refuse(`it was exported by client ${stamp}, older than ${MIGRATION_BASELINE}, whose data cannot be migrated`);
    }
    if (runningVersion &&
        semver.valid(runningVersion) &&
        semver.gt(stamp, runningVersion)) {
        refuse(`it was exported by a newer client (${stamp}; this client is ${runningVersion}); upgrade the Miden SDK to import it`);
    }
}
export async function forceImportStore(dbId, jsonStr) {
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
        await refuseUnkeptDump(dbJson, await readClientVersion(db.settings));
        await db.dexie.transaction("rw", dbTableNames, async () => {
            await Promise.all(db.dexie.tables.map((t) => t.clear()));
            for (const tableName of jsonTableNames) {
                const table = db.dexie.table(tableName);
                if (!dbTableNames.includes(tableName)) {
                    console.warn(`Table "${tableName}" does not exist in the database schema. Skipping.`);
                    continue;
                }
                const records = dbJson[tableName];
                const transformedRecords = await Promise.all(records.map(transformForImport));
                await table.bulkPut(transformedRecords);
            }
            // An export taken from a 0.17.1 store can carry the relay queue the v7 upgrade drops.
            await db.settings.delete([
                SETTING_SCOPE_CLIENT,
                NOTE_TRANSPORT_OUTBOX_SETTING_KEY,
            ]);
        });
        console.log("Store imported successfully.");
    }
    catch (err) {
        logWebStoreError(err);
    }
}
function base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}
