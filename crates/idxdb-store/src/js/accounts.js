import { applyForestUpdate, ForestConflictError, } from "./forest.js";
import { getDatabase, } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";
export class StaleAccountBaseError extends Error {
    constructor(message) {
        super(`StaleAccountBaseError: ${message}`);
        this.name = "StaleAccountBaseError";
    }
}
function seedToBase64(seed) {
    return seed ? uint8ArrayToBase64(seed) : undefined;
}
export async function getAccountIds(dbId) {
    try {
        const db = getDatabase(dbId);
        const records = await db.latestAccountHeaders.toArray();
        return records.map((entry) => entry.id);
    }
    catch (error) {
        logWebStoreError(error, "Error while fetching account IDs");
    }
    /* v8 ignore next 2 — logWebStoreError always re-throws, making this return unreachable */
    return [];
}
export async function getAllAccountHeaders(dbId) {
    try {
        const db = getDatabase(dbId);
        const records = await db.latestAccountHeaders.toArray();
        const resultObject = records.map((record) => ({
            id: record.id,
            nonce: record.nonce,
            vaultRoot: record.vaultRoot,
            storageRoot: record.storageRoot || "",
            codeRoot: record.codeRoot || "",
            accountSeed: seedToBase64(record.accountSeed),
            locked: record.locked,
            committed: record.committed,
            accountCommitment: record.accountCommitment || "",
            watched: record.watched ?? false,
        }));
        return resultObject;
    }
    catch (error) {
        logWebStoreError(error, "Error while fetching account headers");
    }
}
export async function getAccountHeader(dbId, accountId) {
    try {
        const db = getDatabase(dbId);
        const record = await db.latestAccountHeaders
            .where("id")
            .equals(accountId)
            .first();
        if (!record) {
            console.log("No account header record found for given ID.");
            return null;
        }
        return {
            id: record.id,
            nonce: record.nonce,
            vaultRoot: record.vaultRoot,
            storageRoot: record.storageRoot,
            codeRoot: record.codeRoot,
            accountSeed: seedToBase64(record.accountSeed),
            locked: record.locked,
            watched: record.watched ?? false,
        };
    }
    catch (error) {
        logWebStoreError(error, `Error while fetching account header for id: ${accountId}`);
    }
}
export async function getAccountHeaderByCommitment(dbId, accountCommitment) {
    try {
        const db = getDatabase(dbId);
        const record = await db.historicalAccountHeaders
            .where("accountCommitment")
            .equals(accountCommitment)
            .first();
        if (!record) {
            return undefined;
        }
        return {
            id: record.id,
            nonce: record.nonce,
            vaultRoot: record.vaultRoot,
            storageRoot: record.storageRoot,
            codeRoot: record.codeRoot,
            accountSeed: seedToBase64(record.accountSeed),
            locked: record.locked,
            watched: record.watched ?? false,
        };
    }
    catch (error) {
        logWebStoreError(error, `Error fetching account header for commitment ${accountCommitment}`);
    }
}
export async function getAccountCode(dbId, codeRoot) {
    try {
        const db = getDatabase(dbId);
        const allMatchingRecords = await db.accountCodes
            .where("root")
            .equals(codeRoot)
            .toArray();
        const codeRecord = allMatchingRecords[0];
        if (codeRecord === undefined) {
            console.log("No records found for given code root.");
            return null;
        }
        const codeBase64 = uint8ArrayToBase64(codeRecord.code);
        return {
            root: codeRecord.root,
            code: codeBase64,
        };
    }
    catch (error) {
        logWebStoreError(error, `Error fetching account code for root ${codeRoot}`);
    }
}
export async function getAccountStorage(dbId, accountId, slotNames) {
    try {
        const db = getDatabase(dbId);
        let query = db.latestAccountStorages.where("accountId").equals(accountId);
        let allMatchingRecords;
        if (slotNames.length) {
            const nameSet = new Set(slotNames);
            allMatchingRecords = await query
                .and((record) => nameSet.has(record.slotName))
                .toArray();
        }
        else {
            allMatchingRecords = await query.toArray();
        }
        return allMatchingRecords.map((record) => ({
            slotName: record.slotName,
            slotValue: record.slotValue,
            slotType: record.slotType,
        }));
    }
    catch (error) {
        logWebStoreError(error, `Error fetching account storage for account ${accountId}`);
    }
}
export async function getAccountStorageMaps(dbId, accountId) {
    try {
        const db = getDatabase(dbId);
        const allMatchingRecords = await db.latestStorageMapEntries
            .where("accountId")
            .equals(accountId)
            .toArray();
        return allMatchingRecords;
    }
    catch (error) {
        logWebStoreError(error, `Error fetching account storage maps for account ${accountId}`);
    }
}
export async function getAccountVaultAssets(dbId, accountId, vaultKeys) {
    try {
        const db = getDatabase(dbId);
        let query = db.latestAccountAssets.where("accountId").equals(accountId);
        let records;
        if (vaultKeys.length) {
            const keySet = new Set(vaultKeys);
            records = await query
                .and((record) => keySet.has(record.vaultKey))
                .toArray();
        }
        else {
            records = await query.toArray();
        }
        return records.map((record) => ({
            vaultKey: record.vaultKey,
            asset: record.asset,
        }));
    }
    catch (error) {
        logWebStoreError(error, `Error fetching account vault for account ${accountId}`);
    }
}
export async function getAccountAddresses(dbId, accountId) {
    try {
        const db = getDatabase(dbId);
        const allMatchingRecords = await db.addresses
            .where("id")
            .equals(accountId)
            .toArray();
        if (allMatchingRecords.length === 0) {
            console.log("No address records found for given account ID.");
            return [];
        }
        return allMatchingRecords;
    }
    catch (error) {
        logWebStoreError(error, `Error while fetching account addresses for id: ${accountId}`);
    }
}
export async function upsertAccountCode(dbId, codeRoot, code) {
    try {
        const db = getDatabase(dbId);
        const data = {
            root: codeRoot,
            code,
        };
        await db.accountCodes.put(data);
    }
    catch (error) {
        logWebStoreError(error, `Error inserting code with root: ${codeRoot}`);
    }
}
export async function upsertAccountStorage(dbId, accountId, storageSlots) {
    try {
        const db = getDatabase(dbId);
        await db.latestAccountStorages
            .where("accountId")
            .equals(accountId)
            .delete();
        if (storageSlots.length === 0)
            return;
        const latestEntries = storageSlots.map((slot) => ({
            accountId,
            slotName: slot.slotName,
            slotValue: slot.slotValue,
            slotType: slot.slotType,
        }));
        await db.latestAccountStorages.bulkPut(latestEntries);
    }
    catch (error) {
        logWebStoreError(error, `Error inserting storage slots`);
    }
}
export async function upsertStorageMapEntries(dbId, accountId, entries) {
    try {
        const db = getDatabase(dbId);
        await db.latestStorageMapEntries
            .where("accountId")
            .equals(accountId)
            .delete();
        if (entries.length === 0)
            return;
        const latestEntries = entries.map((entry) => ({
            accountId,
            slotName: entry.slotName,
            key: entry.key,
            value: entry.value,
        }));
        await db.latestStorageMapEntries.bulkPut(latestEntries);
    }
    catch (error) {
        logWebStoreError(error, `Error inserting storage map entries`);
    }
}
export async function upsertVaultAssets(dbId, accountId, assets) {
    try {
        const db = getDatabase(dbId);
        await db.latestAccountAssets.where("accountId").equals(accountId).delete();
        if (assets.length === 0)
            return;
        const latestEntries = assets.map((asset) => ({
            accountId,
            vaultKey: asset.vaultKey,
            asset: asset.asset,
        }));
        await db.latestAccountAssets.bulkPut(latestEntries);
    }
    catch (error) {
        logWebStoreError(error, `Error inserting assets`);
    }
}
export async function applyAccountPatch(dbId, accountId, nonce, updatedSlots, changedMapEntries, changedAssets, codeRoot, storageRoot, vaultRoot, committed, commitment, expectedInitialCommitment, forestUpdate) {
    try {
        const db = getDatabase(dbId);
        await db.dexie.transaction("rw", [
            db.latestAccountStorages,
            db.historicalAccountStorages,
            db.latestStorageMapEntries,
            db.historicalStorageMapEntries,
            db.latestAccountAssets,
            db.historicalAccountAssets,
            db.latestAccountHeaders,
            db.historicalAccountHeaders,
            db.forestRevision,
            db.forestTrees,
            db.forestEntries,
            db.forestSubtrees,
        ], async (tx) => {
            await applyAccountPatchInTransaction(tx, {
                accountId,
                nonce,
                updatedSlots,
                changedMapEntries,
                changedAssets,
                codeRoot,
                storageRoot,
                vaultRoot,
                committed,
                commitment,
            }, expectedInitialCommitment);
            await applyForestUpdate(tx, forestUpdate);
        });
    }
    catch (error) {
        logWebStoreError(error, `Error applying transaction delta`);
    }
}
export async function applyAccountPatchInTransaction(tx, patch, expectedInitialCommitment) {
    const { accountId, nonce, updatedSlots, changedMapEntries, changedAssets, codeRoot, storageRoot, vaultRoot, committed, commitment, } = patch;
    const oldHeader = await tx.latestAccountHeaders.get(accountId);
    if (oldHeader === undefined) {
        throw new StaleAccountBaseError(`Account ${accountId} does not exist`);
    }
    if (expectedInitialCommitment !== undefined &&
        oldHeader.accountCommitment !== expectedInitialCommitment) {
        throw new StaleAccountBaseError(`Account ${accountId} commitment does not match the expected base`);
    }
    if (BigInt(nonce) <= BigInt(oldHeader.nonce)) {
        throw new StaleAccountBaseError(`Account ${accountId} nonce ${nonce} must be greater than stored nonce ${oldHeader.nonce}`);
    }
    const resetMapSlots = new Set();
    for (const slot of updatedSlots) {
        const oldSlot = await tx.latestAccountStorage
            .where("[accountId+slotName]")
            .equals([accountId, slot.slotName])
            .first();
        await tx.historicalAccountStorage.put({
            accountId,
            replacedAtNonce: nonce,
            slotName: slot.slotName,
            oldSlotValue: oldSlot?.slotValue ?? null,
            slotType: slot.slotType,
        });
        if (slot.slotType === 1 &&
            (slot.patchOperation === 0 || slot.patchOperation === 2)) {
            resetMapSlots.add(slot.slotName);
            const oldMapEntries = await tx.latestStorageMapEntries
                .where("[accountId+slotName]")
                .equals([accountId, slot.slotName])
                .toArray();
            for (const entry of oldMapEntries) {
                await tx.historicalStorageMapEntries.put({
                    accountId,
                    replacedAtNonce: nonce,
                    slotName: entry.slotName,
                    key: entry.key,
                    oldValue: entry.value,
                });
            }
            await tx.latestStorageMapEntries
                .where("[accountId+slotName]")
                .equals([accountId, slot.slotName])
                .delete();
        }
        if (slot.patchOperation === 2) {
            await tx.latestAccountStorage
                .where("[accountId+slotName]")
                .equals([accountId, slot.slotName])
                .delete();
        }
        else {
            await tx.latestAccountStorage.put({
                accountId,
                slotName: slot.slotName,
                slotValue: slot.slotValue,
                slotType: slot.slotType,
            });
        }
    }
    for (const entry of changedMapEntries) {
        const oldEntry = await tx.latestStorageMapEntries
            .where("[accountId+slotName+key]")
            .equals([accountId, entry.slotName, entry.key])
            .first();
        if (resetMapSlots.has(entry.slotName)) {
            const archivedEntry = await tx.historicalStorageMapEntries
                .where("[accountId+replacedAtNonce+slotName+key]")
                .equals([accountId, nonce, entry.slotName, entry.key])
                .first();
            if (archivedEntry === undefined) {
                await tx.historicalStorageMapEntries.put({
                    accountId,
                    replacedAtNonce: nonce,
                    slotName: entry.slotName,
                    key: entry.key,
                    oldValue: null,
                });
            }
        }
        else {
            await tx.historicalStorageMapEntries.put({
                accountId,
                replacedAtNonce: nonce,
                slotName: entry.slotName,
                key: entry.key,
                oldValue: oldEntry?.value ?? null,
            });
        }
        if (entry.value === "") {
            await tx.latestStorageMapEntries
                .where("[accountId+slotName+key]")
                .equals([accountId, entry.slotName, entry.key])
                .delete();
        }
        else {
            await tx.latestStorageMapEntries.put({
                accountId,
                slotName: entry.slotName,
                key: entry.key,
                value: entry.value,
            });
        }
    }
    for (const entry of changedAssets) {
        const oldAsset = await tx.latestAccountAssets
            .where("[accountId+vaultKey]")
            .equals([accountId, entry.vaultKey])
            .first();
        await tx.historicalAccountAssets.put({
            accountId,
            replacedAtNonce: nonce,
            vaultKey: entry.vaultKey,
            oldAsset: oldAsset?.asset ?? null,
        });
        if (entry.asset === "") {
            await tx.latestAccountAssets
                .where("[accountId+vaultKey]")
                .equals([accountId, entry.vaultKey])
                .delete();
        }
        else {
            await tx.latestAccountAssets.put({
                accountId,
                vaultKey: entry.vaultKey,
                asset: entry.asset,
            });
        }
    }
    await tx.historicalAccountHeaders.put({
        id: accountId,
        replacedAtNonce: nonce,
        codeRoot: oldHeader.codeRoot,
        storageRoot: oldHeader.storageRoot,
        vaultRoot: oldHeader.vaultRoot,
        nonce: oldHeader.nonce,
        committed: oldHeader.committed,
        accountSeed: oldHeader.accountSeed,
        accountCommitment: oldHeader.accountCommitment,
        locked: oldHeader.locked,
        watched: oldHeader.watched ?? false,
    });
    await tx.latestAccountHeaders.put({
        id: accountId,
        codeRoot,
        storageRoot,
        vaultRoot,
        nonce,
        committed,
        accountSeed: undefined,
        accountCommitment: commitment,
        locked: false,
        watched: oldHeader?.watched ?? false,
    });
}
async function archiveAndReplaceStorageSlots(tx, accountId, nonce, newSlots) {
    const oldSlots = await tx.latestAccountStorage
        .where("accountId")
        .equals(accountId)
        .toArray();
    // Archive every old slot
    for (const slot of oldSlots) {
        await tx.historicalAccountStorage.put({
            accountId,
            replacedAtNonce: nonce,
            slotName: slot.slotName,
            oldSlotValue: slot.slotValue,
            slotType: slot.slotType,
        });
    }
    // Write NULL markers for genuinely new slots (no old value to archive)
    const oldSlotNames = new Set(oldSlots.map((s) => s.slotName));
    for (const slot of newSlots) {
        if (!oldSlotNames.has(slot.slotName)) {
            await tx.historicalAccountStorage.put({
                accountId,
                replacedAtNonce: nonce,
                slotName: slot.slotName,
                oldSlotValue: null,
                slotType: slot.slotType,
            });
        }
    }
    // Replace latest
    await tx.latestAccountStorage.where("accountId").equals(accountId).delete();
    if (newSlots.length > 0) {
        await tx.latestAccountStorage.bulkPut(newSlots.map((slot) => ({
            accountId,
            slotName: slot.slotName,
            slotValue: slot.slotValue,
            slotType: slot.slotType,
        })));
    }
}
async function archiveAndReplaceMapEntries(tx, accountId, nonce, newEntries) {
    const oldEntries = await tx.latestStorageMapEntries
        .where("accountId")
        .equals(accountId)
        .toArray();
    for (const entry of oldEntries) {
        await tx.historicalStorageMapEntries.put({
            accountId,
            replacedAtNonce: nonce,
            slotName: entry.slotName,
            key: entry.key,
            oldValue: entry.value,
        });
    }
    const oldKeys = new Set(oldEntries.map((e) => `${e.slotName}\0${e.key}`));
    for (const entry of newEntries) {
        if (!oldKeys.has(`${entry.slotName}\0${entry.key}`)) {
            await tx.historicalStorageMapEntries.put({
                accountId,
                replacedAtNonce: nonce,
                slotName: entry.slotName,
                key: entry.key,
                oldValue: null,
            });
        }
    }
    await tx.latestStorageMapEntries
        .where("accountId")
        .equals(accountId)
        .delete();
    if (newEntries.length > 0) {
        await tx.latestStorageMapEntries.bulkPut(newEntries.map((entry) => ({
            accountId,
            slotName: entry.slotName,
            key: entry.key,
            value: entry.value,
        })));
    }
}
async function archiveAndReplaceVaultAssets(tx, accountId, nonce, newAssets) {
    const oldAssets = await tx.latestAccountAssets
        .where("accountId")
        .equals(accountId)
        .toArray();
    for (const asset of oldAssets) {
        await tx.historicalAccountAssets.put({
            accountId,
            replacedAtNonce: nonce,
            vaultKey: asset.vaultKey,
            oldAsset: asset.asset,
        });
    }
    const oldKeys = new Set(oldAssets.map((a) => a.vaultKey));
    for (const asset of newAssets) {
        if (!oldKeys.has(asset.vaultKey)) {
            await tx.historicalAccountAssets.put({
                accountId,
                replacedAtNonce: nonce,
                vaultKey: asset.vaultKey,
                oldAsset: null,
            });
        }
    }
    await tx.latestAccountAssets.where("accountId").equals(accountId).delete();
    if (newAssets.length > 0) {
        await tx.latestAccountAssets.bulkPut(newAssets.map((asset) => ({
            accountId,
            vaultKey: asset.vaultKey,
            asset: asset.asset,
        })));
    }
}
async function restoreSlotsFromHistorical(tx, accountId, nonce) {
    const oldSlots = await tx.historicalAccountStorage
        .where("[accountId+replacedAtNonce]")
        .equals([accountId, nonce])
        .toArray();
    for (const slot of oldSlots) {
        if (slot.oldSlotValue !== null) {
            await tx.latestAccountStorage.put({
                accountId: slot.accountId,
                slotName: slot.slotName,
                slotValue: slot.oldSlotValue,
                slotType: slot.slotType,
            });
        }
        else {
            await tx.latestAccountStorage
                .where("[accountId+slotName]")
                .equals([accountId, slot.slotName])
                .delete();
        }
    }
}
async function restoreMapEntriesFromHistorical(tx, accountId, nonce) {
    const oldEntries = await tx.historicalStorageMapEntries
        .where("[accountId+replacedAtNonce]")
        .equals([accountId, nonce])
        .toArray();
    for (const entry of oldEntries) {
        if (entry.oldValue !== null) {
            await tx.latestStorageMapEntries.put({
                accountId: entry.accountId,
                slotName: entry.slotName,
                key: entry.key,
                value: entry.oldValue,
            });
        }
        else {
            await tx.latestStorageMapEntries
                .where("[accountId+slotName+key]")
                .equals([accountId, entry.slotName, entry.key])
                .delete();
        }
    }
}
async function restoreAssetsFromHistorical(tx, accountId, nonce) {
    const oldAssets = await tx.historicalAccountAssets
        .where("[accountId+replacedAtNonce]")
        .equals([accountId, nonce])
        .toArray();
    for (const asset of oldAssets) {
        if (asset.oldAsset !== null) {
            await tx.latestAccountAssets.put({
                accountId: asset.accountId,
                vaultKey: asset.vaultKey,
                asset: asset.oldAsset,
            });
        }
        else {
            await tx.latestAccountAssets
                .where("[accountId+vaultKey]")
                .equals([accountId, asset.vaultKey])
                .delete();
        }
    }
}
/**
 * Replaces an account's full state (storage, map entries, vault assets, header)
 * with a new snapshot. Before overwriting, all current latest values are archived
 * to historical.
 */
export async function applyFullAccountState(dbId, accountState, forestUpdate) {
    try {
        const db = getDatabase(dbId);
        await db.dexie.transaction("rw", [
            db.latestAccountStorages,
            db.historicalAccountStorages,
            db.latestStorageMapEntries,
            db.historicalStorageMapEntries,
            db.latestAccountAssets,
            db.historicalAccountAssets,
            db.latestAccountHeaders,
            db.historicalAccountHeaders,
            db.forestRevision,
            db.forestTrees,
            db.forestEntries,
            db.forestSubtrees,
        ], async (tx) => {
            await applyFullAccountStateInTransaction(tx, accountState);
            await applyForestUpdate(tx, forestUpdate);
        });
    }
    catch (error) {
        logWebStoreError(error, `Error applying full account state`);
    }
}
export async function applyFullAccountStateInTransaction(tx, accountState) {
    const { accountId, nonce, storageSlots, storageMapEntries, assets, codeRoot, storageRoot, vaultRoot, committed, accountCommitment, accountSeed, } = accountState;
    const oldHeader = await tx.latestAccountHeaders.get(accountId);
    if (oldHeader === undefined) {
        throw new StaleAccountBaseError(`Account ${accountId} does not exist`);
    }
    if (BigInt(nonce) < BigInt(oldHeader.nonce)) {
        throw new StaleAccountBaseError(`Account ${accountId} nonce ${nonce} is lower than stored nonce ${oldHeader.nonce}`);
    }
    await archiveAndReplaceStorageSlots(tx, accountId, nonce, storageSlots);
    await archiveAndReplaceMapEntries(tx, accountId, nonce, storageMapEntries);
    await archiveAndReplaceVaultAssets(tx, accountId, nonce, assets);
    await tx.historicalAccountHeaders.put({
        id: accountId,
        replacedAtNonce: nonce,
        codeRoot: oldHeader.codeRoot,
        storageRoot: oldHeader.storageRoot,
        vaultRoot: oldHeader.vaultRoot,
        nonce: oldHeader.nonce,
        committed: oldHeader.committed,
        accountSeed: oldHeader.accountSeed,
        accountCommitment: oldHeader.accountCommitment,
        locked: oldHeader.locked,
        watched: oldHeader.watched ?? false,
    });
    await tx.latestAccountHeaders.put({
        id: accountId,
        codeRoot,
        storageRoot,
        vaultRoot,
        nonce,
        committed,
        accountSeed,
        accountCommitment,
        locked: false,
        watched: oldHeader?.watched ?? false,
    });
}
export async function insertAccount(dbId, accountUpdate, code, codeRoot, address, watched, forestUpdate) {
    try {
        const db = getDatabase(dbId);
        await db.dexie.transaction("rw", [
            db.accountCodes,
            db.latestAccountStorages,
            db.latestStorageMapEntries,
            db.latestAccountAssets,
            db.latestAccountHeaders,
            db.addresses,
            db.forestRevision,
            db.forestTrees,
            db.forestEntries,
            db.forestSubtrees,
        ], async (tx) => {
            const existingAccount = await tx.latestAccountHeaders.get(accountUpdate.accountId);
            if (existingAccount !== undefined) {
                throw new ForestConflictError(`Account ${accountUpdate.accountId} already exists`);
            }
            await tx.accountCode.put({ root: codeRoot, code });
            if (accountUpdate.storageSlots.length > 0) {
                await tx.latestAccountStorage.bulkPut(accountUpdate.storageSlots.map((slot) => ({
                    accountId: accountUpdate.accountId,
                    slotName: slot.slotName,
                    slotValue: slot.slotValue,
                    slotType: slot.slotType,
                })));
            }
            if (accountUpdate.storageMapEntries.length > 0) {
                await tx.latestStorageMapEntries.bulkPut(accountUpdate.storageMapEntries.map((entry) => ({
                    accountId: accountUpdate.accountId,
                    slotName: entry.slotName,
                    key: entry.key,
                    value: entry.value,
                })));
            }
            if (accountUpdate.assets.length > 0) {
                await tx.latestAccountAssets.bulkPut(accountUpdate.assets.map((asset) => ({
                    accountId: accountUpdate.accountId,
                    vaultKey: asset.vaultKey,
                    asset: asset.asset,
                })));
            }
            await tx.latestAccountHeaders.put({
                id: accountUpdate.accountId,
                codeRoot: accountUpdate.codeRoot,
                storageRoot: accountUpdate.storageRoot,
                vaultRoot: accountUpdate.vaultRoot,
                nonce: accountUpdate.nonce,
                committed: accountUpdate.committed,
                accountSeed: accountUpdate.accountSeed,
                accountCommitment: accountUpdate.accountCommitment,
                locked: false,
                watched,
            });
            await tx.addresses.put({
                id: accountUpdate.accountId,
                address,
            });
            await applyForestUpdate(tx, forestUpdate);
        });
    }
    catch (error) {
        logWebStoreError(error, `Error inserting account: ${accountUpdate.accountId}`);
    }
}
export async function upsertAccountRecord(dbId, accountId, codeRoot, storageRoot, vaultRoot, nonce, committed, commitment, accountSeed, watched) {
    try {
        const db = getDatabase(dbId);
        const data = {
            id: accountId,
            codeRoot,
            storageRoot,
            vaultRoot,
            nonce,
            committed,
            accountSeed,
            accountCommitment: commitment,
            locked: false,
            watched,
        };
        await db.latestAccountHeaders.put(data);
    }
    catch (error) {
        logWebStoreError(error, `Error inserting account: ${accountId}`);
    }
}
export async function insertAccountAddress(dbId, accountId, address) {
    try {
        const db = getDatabase(dbId);
        const data = {
            id: accountId,
            address,
        };
        await db.addresses.put(data);
    }
    catch (error) {
        logWebStoreError(error, `Error inserting address with value: ${String(address)} for the account ID ${accountId}`);
    }
}
export async function removeAccountAddress(dbId, address) {
    try {
        const db = getDatabase(dbId);
        await db.addresses.where("address").equals(address).delete();
    }
    catch (error) {
        logWebStoreError(error, `Error removing address with value: ${String(address)}`);
    }
}
export async function upsertForeignAccountCode(dbId, accountId, code, codeRoot) {
    try {
        const db = getDatabase(dbId);
        await upsertAccountCode(dbId, codeRoot, code);
        const data = {
            accountId,
            codeRoot,
        };
        await db.foreignAccountCode.put(data);
    }
    catch (error) {
        logWebStoreError(error, `Error upserting foreign account code for account: ${accountId}`);
    }
}
export async function getForeignAccountCode(dbId, accountIds) {
    try {
        const db = getDatabase(dbId);
        const foreignAccounts = await db.foreignAccountCode
            .where("accountId")
            .anyOf(accountIds)
            .toArray();
        if (foreignAccounts.length === 0) {
            console.log("No records found for the given account IDs.");
            return null;
        }
        const codeRoots = foreignAccounts.map((account) => account.codeRoot);
        const accountCode = await db.accountCodes
            .where("root")
            .anyOf(codeRoots)
            .toArray();
        const processedCode = foreignAccounts
            .map((foreignAccount) => {
            const matchingCode = accountCode.find((code) => code.root === foreignAccount.codeRoot);
            if (matchingCode === undefined) {
                return undefined;
            }
            const codeBase64 = uint8ArrayToBase64(matchingCode.code);
            return {
                accountId: foreignAccount.accountId,
                code: codeBase64,
            };
        })
            .filter((matchingCode) => matchingCode !== undefined);
        return processedCode;
    }
    catch (error) {
        logWebStoreError(error, "Error fetching foreign account code");
    }
}
export async function lockAccount(dbId, accountId) {
    try {
        const db = getDatabase(dbId);
        await db.latestAccountHeaders
            .where("id")
            .equals(accountId)
            .modify({ locked: true });
        // Also lock historical rows so that undo/rebuild preserves the lock.
        await db.historicalAccountHeaders
            .where("id")
            .equals(accountId)
            .modify({ locked: true });
    }
    catch (error) {
        logWebStoreError(error, `Error locking account: ${accountId}`);
    }
}
/**
 * Prunes historical account states for a single account up to the given nonce.
 *
 * Deletes all historical entries with `replacedAtNonce <= upToNonce` and any
 * orphaned account code. Mirrors the SQLite implementation.
 */
export async function pruneAccountHistory(dbId, accountId, upToNonce) {
    try {
        const db = getDatabase(dbId);
        let totalDeleted = 0;
        const boundaryNonce = BigInt(upToNonce);
        await db.dexie.transaction("rw", [
            db.historicalAccountHeaders,
            db.historicalAccountStorages,
            db.historicalStorageMapEntries,
            db.historicalAccountAssets,
            db.accountCodes,
            db.latestAccountHeaders,
            db.foreignAccountCode,
        ], async () => {
            // Nonces are stored as strings so we cannot use index range queries
            // (lexicographic ordering would be wrong). Filter in JS instead.
            const headers = await db.historicalAccountHeaders
                .where("id")
                .equals(accountId)
                .toArray();
            const toPrune = headers.filter((h) => BigInt(h.replacedAtNonce) <= boundaryNonce);
            // Collect code roots from headers we are about to delete.
            const candidateCodeRoots = new Set(toPrune.map((h) => h.codeRoot));
            for (const h of toPrune) {
                await db.historicalAccountHeaders
                    .where("accountCommitment")
                    .equals(h.accountCommitment)
                    .delete();
                const rat = h.replacedAtNonce;
                totalDeleted += 1;
                totalDeleted += await db.historicalAccountStorages
                    .where("[accountId+replacedAtNonce]")
                    .equals([accountId, rat])
                    .delete();
                totalDeleted += await db.historicalStorageMapEntries
                    .where("[accountId+replacedAtNonce]")
                    .equals([accountId, rat])
                    .delete();
                totalDeleted += await db.historicalAccountAssets
                    .where("[accountId+replacedAtNonce]")
                    .equals([accountId, rat])
                    .delete();
            }
            // Delete orphaned code: only check roots from the deleted headers,
            // and only if they are not referenced by any remaining header or foreign code.
            if (candidateCodeRoots.size > 0) {
                const latestHeaders = await db.latestAccountHeaders.toArray();
                const remainingHistorical = await db.historicalAccountHeaders.toArray();
                const foreignCodes = await db.foreignAccountCode.toArray();
                const referencedCodeRoots = new Set();
                for (const h of latestHeaders)
                    referencedCodeRoots.add(h.codeRoot);
                for (const h of remainingHistorical)
                    referencedCodeRoots.add(h.codeRoot);
                for (const f of foreignCodes)
                    referencedCodeRoots.add(f.codeRoot);
                for (const root of candidateCodeRoots) {
                    if (!referencedCodeRoots.has(root)) {
                        await db.accountCodes.where("root").equals(root).delete();
                        totalDeleted += 1;
                    }
                }
            }
        });
        return totalDeleted;
    }
    catch (error) {
        logWebStoreError(error, `Error pruning account history for ${accountId}`);
        throw error;
    }
}
async function resolveUndoAccountNonces(tx, accountCommitments) {
    const accountNonces = new Map();
    for (const commitment of accountCommitments) {
        const latestRecord = await tx.latestAccountHeaders
            .where("accountCommitment")
            .equals(commitment)
            .first();
        if (latestRecord) {
            if (!accountNonces.has(latestRecord.id)) {
                accountNonces.set(latestRecord.id, new Set());
            }
            accountNonces.get(latestRecord.id).add(latestRecord.nonce);
            continue;
        }
        const historicalRecord = await tx.historicalAccountHeaders
            .where("accountCommitment")
            .equals(commitment)
            .first();
        if (historicalRecord) {
            if (!accountNonces.has(historicalRecord.id)) {
                accountNonces.set(historicalRecord.id, new Set());
            }
            accountNonces.get(historicalRecord.id).add(historicalRecord.nonce);
        }
    }
    return accountNonces;
}
function sortUndoNonces(nonces) {
    return [...nonces].sort((a, b) => Number(BigInt(b) - BigInt(a)));
}
export async function getPostUndoAccountStates(dbId, accountCommitments) {
    try {
        const db = getDatabase(dbId);
        return await db.dexie.transaction("r", [
            db.latestAccountStorages,
            db.historicalAccountStorages,
            db.latestStorageMapEntries,
            db.historicalStorageMapEntries,
            db.latestAccountAssets,
            db.historicalAccountAssets,
            db.latestAccountHeaders,
            db.historicalAccountHeaders,
        ], async (tx) => {
            const accountNonces = await resolveUndoAccountNonces(tx, accountCommitments);
            const states = [];
            for (const [accountId, nonces] of accountNonces) {
                const [latestSlots, latestMapEntries, latestAssets] = await Promise.all([
                    tx.latestAccountStorage
                        .where("accountId")
                        .equals(accountId)
                        .toArray(),
                    tx.latestStorageMapEntries
                        .where("accountId")
                        .equals(accountId)
                        .toArray(),
                    tx.latestAccountAssets
                        .where("accountId")
                        .equals(accountId)
                        .toArray(),
                ]);
                const slots = new Map(latestSlots.map((slot) => [slot.slotName, { ...slot }]));
                const mapEntries = new Map(latestMapEntries.map((entry) => [
                    JSON.stringify([entry.slotName, entry.key]),
                    { ...entry },
                ]));
                const assets = new Map(latestAssets.map((asset) => [asset.vaultKey, { ...asset }]));
                const sortedNonces = sortUndoNonces(nonces);
                for (const nonce of sortedNonces) {
                    const [oldSlots, oldMapEntries, oldAssets] = await Promise.all([
                        tx.historicalAccountStorage
                            .where("[accountId+replacedAtNonce]")
                            .equals([accountId, nonce])
                            .toArray(),
                        tx.historicalStorageMapEntries
                            .where("[accountId+replacedAtNonce]")
                            .equals([accountId, nonce])
                            .toArray(),
                        tx.historicalAccountAssets
                            .where("[accountId+replacedAtNonce]")
                            .equals([accountId, nonce])
                            .toArray(),
                    ]);
                    for (const slot of oldSlots) {
                        if (slot.oldSlotValue === null) {
                            slots.delete(slot.slotName);
                        }
                        else {
                            slots.set(slot.slotName, {
                                accountId,
                                slotName: slot.slotName,
                                slotValue: slot.oldSlotValue,
                                slotType: slot.slotType,
                            });
                        }
                    }
                    for (const entry of oldMapEntries) {
                        const key = JSON.stringify([entry.slotName, entry.key]);
                        if (entry.oldValue === null) {
                            mapEntries.delete(key);
                        }
                        else {
                            mapEntries.set(key, {
                                accountId,
                                slotName: entry.slotName,
                                key: entry.key,
                                value: entry.oldValue,
                            });
                        }
                    }
                    for (const asset of oldAssets) {
                        if (asset.oldAsset === null) {
                            assets.delete(asset.vaultKey);
                        }
                        else {
                            assets.set(asset.vaultKey, {
                                accountId,
                                vaultKey: asset.vaultKey,
                                asset: asset.oldAsset,
                            });
                        }
                    }
                }
                const minNonce = sortedNonces[sortedNonces.length - 1];
                const oldHeader = await tx.historicalAccountHeaders
                    .where("[id+replacedAtNonce]")
                    .equals([accountId, minNonce])
                    .first();
                if (oldHeader === undefined) {
                    slots.clear();
                    mapEntries.clear();
                    assets.clear();
                }
                states.push({
                    accountId,
                    commitment: oldHeader?.accountCommitment ?? null,
                    storageSlots: [...slots.values()]
                        .map(({ slotName, slotValue, slotType }) => ({
                        slotName,
                        slotValue,
                        slotType,
                    }))
                        .sort((a, b) => a.slotName.localeCompare(b.slotName)),
                    storageMapEntries: [...mapEntries.values()]
                        .map(({ slotName, key, value }) => ({ slotName, key, value }))
                        .sort((a, b) => a.slotName.localeCompare(b.slotName) ||
                        a.key.localeCompare(b.key)),
                    vaultAssets: [...assets.values()]
                        .map(({ vaultKey, asset }) => ({ vaultKey, asset }))
                        .sort((a, b) => a.vaultKey.localeCompare(b.vaultKey)),
                });
            }
            return states;
        });
    }
    catch (error) {
        logWebStoreError(error, "Error computing post-undo account states");
        throw error;
    }
}
/**
 * Undoes discarded account states by restoring old values from historical
 * back to latest. Non-null old values overwrite latest; null old values
 * (entries that didn't exist before that nonce) cause deletion from latest.
 */
export async function undoAccountStates(dbId, accountCommitments, forestUpdate) {
    try {
        const db = getDatabase(dbId);
        await db.dexie.transaction("rw", [
            db.latestAccountStorages,
            db.historicalAccountStorages,
            db.latestStorageMapEntries,
            db.historicalStorageMapEntries,
            db.latestAccountAssets,
            db.historicalAccountAssets,
            db.latestAccountHeaders,
            db.historicalAccountHeaders,
            db.forestRevision,
            db.forestTrees,
            db.forestEntries,
            db.forestSubtrees,
        ], async (tx) => {
            await undoAccountStatesInTransaction(tx, accountCommitments);
            await applyForestUpdate(tx, forestUpdate);
        });
    }
    catch (error) {
        logWebStoreError(error, `Error undoing account states: ${accountCommitments.join(",")}`);
        throw error;
    }
}
export async function undoAccountStatesInTransaction(tx, accountCommitments) {
    const accountNonces = await resolveUndoAccountNonces(tx, accountCommitments);
    for (const [accountId, nonces] of accountNonces) {
        const sortedNonces = sortUndoNonces(nonces);
        for (const nonce of sortedNonces) {
            await restoreSlotsFromHistorical(tx, accountId, nonce);
            await restoreMapEntriesFromHistorical(tx, accountId, nonce);
            await restoreAssetsFromHistorical(tx, accountId, nonce);
        }
        const minNonce = sortedNonces[sortedNonces.length - 1];
        const oldHeader = await tx.historicalAccountHeaders
            .where("[id+replacedAtNonce]")
            .equals([accountId, minNonce])
            .first();
        if (oldHeader) {
            await tx.latestAccountHeaders.put({
                id: oldHeader.id,
                codeRoot: oldHeader.codeRoot,
                storageRoot: oldHeader.storageRoot,
                vaultRoot: oldHeader.vaultRoot,
                nonce: oldHeader.nonce,
                committed: oldHeader.committed,
                accountSeed: oldHeader.accountSeed,
                accountCommitment: oldHeader.accountCommitment,
                locked: oldHeader.locked,
                watched: oldHeader.watched ?? false,
            });
        }
        else {
            await tx.latestAccountHeaders.where("id").equals(accountId).delete();
            await tx.latestAccountStorage
                .where("accountId")
                .equals(accountId)
                .delete();
            await tx.latestStorageMapEntries
                .where("accountId")
                .equals(accountId)
                .delete();
            await tx.latestAccountAssets
                .where("accountId")
                .equals(accountId)
                .delete();
        }
        for (const nonce of sortedNonces) {
            await tx.historicalAccountStorage
                .where("[accountId+replacedAtNonce]")
                .equals([accountId, nonce])
                .delete();
            await tx.historicalStorageMapEntries
                .where("[accountId+replacedAtNonce]")
                .equals([accountId, nonce])
                .delete();
            await tx.historicalAccountAssets
                .where("[accountId+replacedAtNonce]")
                .equals([accountId, nonce])
                .delete();
            await tx.historicalAccountHeaders
                .where("[id+replacedAtNonce]")
                .equals([accountId, nonce])
                .delete();
        }
    }
}
