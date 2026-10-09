import Dexie from "dexie";
import * as semver from "semver";
import { logWebStoreError } from "./utils.js";
export const CLIENT_VERSION_SETTING_KEY = "clientVersion";
/**
 * The threshold of the v8 cutover: a store stamped below it, a prerelease of it included, or not
 * stamped at all holds data from networks that no longer exist, so that upgrade clears it once.
 * Raising it clears nothing that already ran v8. A later release that genuinely cannot migrate
 * older data adds a new Dexie version with the same clear-and-reseed upgrade and its own
 * threshold, which is the only way a store is ever cleared.
 */
export const MIGRATION_BASELINE = "0.17.0";
// How long the pre-open newer-store check waits on indexedDB.databases() before leaving the
// refusal to the ready hook.
const DATABASES_PROBE_TIMEOUT_MS = 1000;
/** The client-scope setting a 0.17.1 client queued undelivered private notes under. */
export const NOTE_TRANSPORT_OUTBOX_SETTING_KEY = "note_transport_outbox";
/** Mirrors `StorageSlotType::Map`, originally defined in miden-protocol. */
export const STORAGE_SLOT_TYPE_MAP = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
// Since we can't have a pointer to a JS Object from rust, we'll
// use this instead to keep track of open DBs. A client can have
// a DB for mainnet, devnet, testnet or a custom one, so this should be ok.
// Each name has one connection, held by every live Rust `IdxdbStore` on it.
const databaseRegistry = new Map();
const pendingOpens = new Map();
/**
 * Get a database instance from the registry by its ID.
 * Throws if the database hasn't been opened yet.
 */
export function getDatabase(dbId) {
    const entry = databaseRegistry.get(dbId);
    if (!entry) {
        throw new Error(`Database not found for id: ${dbId}. Call openDatabase first.`);
    }
    return entry.db;
}
/**
 * Releases one holder of the database registered for `network`, closing and
 * unregistering it when the last holder is gone. No-op for an unknown name.
 */
export function closeDatabase(network) {
    const entry = databaseRegistry.get(network);
    if (!entry) {
        return;
    }
    entry.holders -= 1;
    if (entry.holders > 0) {
        return;
    }
    entry.db.dexie.close();
    databaseRegistry.delete(network);
}
/**
 * Opens the database for `network`, or joins the connection already open or
 * opening under that name, and counts the caller as one holder until it calls
 * `closeDatabase`. Returns the database ID (network name) which can be used to
 * retrieve the database later.
 */
export async function openDatabase(network, clientVersion) {
    const registered = databaseRegistry.get(network);
    if (registered?.db.dexie.isOpen()) {
        registered.holders += 1;
        return network;
    }
    let pending = pendingOpens.get(network);
    if (!pending) {
        pending = { holders: 0, opened: Promise.resolve() };
        pendingOpens.set(network, pending);
        pending.opened = openAndRegister(network, clientVersion, pending);
    }
    pending.holders += 1;
    await pending.opened;
    return network;
}
// Registers the connection and counts its waiting holders in one turn, so a
// close landing in between cannot release it under them. An entry it replaces
// was closed elsewhere, and that entry's holders now hold this connection.
async function openAndRegister(network, clientVersion, pending) {
    const db = new MidenDatabase(network);
    try {
        const success = await db.open(clientVersion);
        /* v8 ignore next 3 - open() only returns false after logWebStoreError re-throws, so !success is unreachable */
        if (!success) {
            throw new Error(`Failed to open IndexedDB database: ${network}`);
        }
    }
    catch (err) {
        db.dexie.close();
        throw err;
    }
    finally {
        pendingOpens.delete(network);
    }
    const replaced = databaseRegistry.get(network);
    replaced?.db.dexie.close();
    databaseRegistry.set(network, {
        db,
        holders: (replaced?.holders ?? 0) + pending.holders,
    });
}
var Table;
(function (Table) {
    Table["AccountCode"] = "accountCode";
    Table["LatestAccountStorage"] = "latestAccountStorage";
    Table["HistoricalAccountStorage"] = "historicalAccountStorage";
    Table["LatestAccountAssets"] = "latestAccountAssets";
    Table["HistoricalAccountAssets"] = "historicalAccountAssets";
    Table["LatestStorageMapEntries"] = "latestStorageMapEntries";
    Table["HistoricalStorageMapEntries"] = "historicalStorageMapEntries";
    Table["AccountAuth"] = "accountAuth";
    Table["AccountKeyMapping"] = "accountKeyMapping";
    Table["LatestAccountHeaders"] = "latestAccountHeaders";
    Table["HistoricalAccountHeaders"] = "historicalAccountHeaders";
    Table["Addresses"] = "addresses";
    Table["Transactions"] = "transactions";
    Table["TransactionScripts"] = "transactionScripts";
    Table["InputNotes"] = "inputNotes";
    Table["OutputNotes"] = "outputNotes";
    Table["NotesScripts"] = "notesScripts";
    Table["BlockchainCheckpoint"] = "blockchainCheckpoint";
    Table["BlockHeaders"] = "blockHeaders";
    Table["PartialBlockchainNodes"] = "partialBlockchainNodes";
    Table["Tags"] = "tags";
    Table["ForeignAccountCode"] = "foreignAccountCode";
    Table["Settings"] = "settings";
    Table["AccountWitnesses"] = "accountWitnesses";
})(Table || (Table = {}));
/** Mirrors `SettingScope`, whose discriminants are part of a store's schema. */
export const SETTING_SCOPE_CLIENT = 0;
export const SETTING_SCOPE_USER = 1;
function indexes(...items) {
    return items.join(",");
}
// This store is the client, so its own bookkeeping belongs to the `Client` scope, which the
// user-facing settings API never reaches.
export async function readClientVersion(settings) {
    const record = await settings.get([
        SETTING_SCOPE_CLIENT,
        CLIENT_VERSION_SETTING_KEY,
    ]);
    return record ? textDecoder.decode(record.value) : null;
}
// What a store holds before its first sync: the chain checkpoint at the genesis block.
function seedFreshStore(tx) {
    return tx
        .table(Table.BlockchainCheckpoint)
        .put({ id: 1, blockNum: 0, partialBlockchainPeaks: new Uint8Array() });
}
// The upgrade of a cutover version. A store stamped below `threshold` (a prerelease of it
// included) or not stamped has every table cleared and is seeded as a fresh store; a stamp that
// is not valid semver keeps it. Clearing inside the versionchange transaction makes it atomic,
// and IndexedDB runs one at a time across tabs and workers, so a context opening the store
// meanwhile waits and then finds it upgraded. A fresh database runs no upgrade callbacks.
function clearStoreStampedBelow(threshold) {
    return async (tx) => {
        const stamp = await readClientVersion(tx.table(Table.Settings));
        if (stamp !== null &&
            !(semver.valid(stamp) && semver.lt(stamp, threshold))) {
            return;
        }
        console.warn(`Clearing IndexedDB store ${tx.db.name}: ` +
            (stamp === null
                ? "it has no client version stamp."
                : `it was written by client ${stamp}, older than ${threshold}.`));
        // A table a later version adds does not exist yet at this step.
        const tables = Object.values(Table).filter((name) => tx.idbtrans.db.objectStoreNames.contains(name));
        await Promise.all(tables.map((name) => tx.table(name).clear()));
        await seedFreshStore(tx);
    };
}
// Dexie keeps version N natively as N * 10, plus one for each schema patch it applies. Dexie may
// have patched the store's schema before the ready hook runs, so the message only promises that
// nothing was deleted.
function refuseNewerStore(name, nativeVersion, verno) {
    const storeVersion = Math.floor(nativeVersion / 10);
    if (storeVersion > verno) {
        throw new Error(`IndexedDB store "${name}" was written by a newer Miden client (schema version ` +
            `${storeVersion}; this client reads up to ${verno}). Nothing was deleted. Upgrade the ` +
            `Miden SDK to open it, or clear this site's data to start over.`);
    }
}
/** V1 baseline schema. Never modify it: every schema change goes through a new version block.
 *  Exported for migration tests, which seed a physical v1 database before opening it with the
 *  current version chain. */
export const V1_STORES = {
    [Table.AccountCode]: indexes("root"),
    [Table.LatestAccountStorage]: indexes("[accountId+slotName]", "accountId"),
    [Table.HistoricalAccountStorage]: indexes("[accountId+replacedAtNonce+slotName]", "accountId", "[accountId+replacedAtNonce]"),
    [Table.LatestStorageMapEntries]: indexes("[accountId+slotName+key]", "accountId", "[accountId+slotName]"),
    [Table.HistoricalStorageMapEntries]: indexes("[accountId+replacedAtNonce+slotName+key]", "accountId", "[accountId+replacedAtNonce]"),
    [Table.LatestAccountAssets]: indexes("[accountId+vaultKey]", "accountId"),
    [Table.HistoricalAccountAssets]: indexes("[accountId+replacedAtNonce+vaultKey]", "accountId", "[accountId+replacedAtNonce]"),
    [Table.AccountAuth]: indexes("pubKeyCommitmentHex"),
    [Table.AccountKeyMapping]: indexes("[accountIdHex+pubKeyCommitmentHex]", "accountIdHex", "pubKeyCommitmentHex"),
    [Table.LatestAccountHeaders]: indexes("&id", "accountCommitment"),
    [Table.HistoricalAccountHeaders]: indexes("&accountCommitment", "id", "[id+replacedAtNonce]"),
    [Table.Addresses]: indexes("address", "id"),
    [Table.Transactions]: indexes("id", "statusVariant"),
    [Table.TransactionScripts]: indexes("scriptRoot"),
    [Table.InputNotes]: indexes("detailsCommitment", "noteId", "nullifier", "scriptRoot", "stateDiscriminant", "[consumedBlockHeight+consumedTxOrder+noteId]"),
    [Table.OutputNotes]: indexes("detailsCommitment", "noteId", "recipientDigest", "stateDiscriminant", "nullifier"),
    [Table.NotesScripts]: indexes("scriptRoot"),
    [Table.BlockchainCheckpoint]: indexes("id"),
    [Table.BlockHeaders]: indexes("blockNum", "hasClientNotes"),
    [Table.PartialBlockchainNodes]: indexes("id"),
    [Table.Tags]: indexes("id++", "tag", "sourceNoteId", "sourceAccountId"),
    [Table.ForeignAccountCode]: indexes("accountId"),
    [Table.Settings]: indexes("key"),
};
export class MidenDatabase {
    dexie;
    accountCodes;
    latestAccountStorages;
    historicalAccountStorages;
    latestStorageMapEntries;
    historicalStorageMapEntries;
    latestAccountAssets;
    historicalAccountAssets;
    accountAuths;
    accountKeyMappings;
    latestAccountHeaders;
    historicalAccountHeaders;
    addresses;
    transactions;
    transactionScripts;
    inputNotes;
    outputNotes;
    notesScripts;
    blockchainCheckpoint;
    blockHeaders;
    partialBlockchainNodes;
    tags;
    foreignAccountCode;
    settings;
    accountWitnesses;
    constructor(network) {
        this.dexie = new Dexie(network);
        // --- Schema versioning ---
        //
        // A store survives client upgrades, so every change to a table's shape or to a stored
        // value's encoding ships here as a new version (see the policy above ensureClientVersion).
        //
        // v1 is the baseline schema. To add a migration:
        //   1. Add a .version(N+1).stores({...}).upgrade(tx => {...}) block below.
        //      Only list tables whose indexes changed; Dexie carries forward the rest.
        //   2. Update TypeScript interfaces and the Table enum if needed.
        //   3. Add a migration test in schema.test.ts.
        //   4. Run `pnpm build` and `pnpm test`.
        //
        // The version number is a simple incrementing integer, not the client semver.
        // Use a comment to note which client version introduced the change.
        //
        // Example — adding a `createdAt` field with an index to accounts:
        //
        //   // v2: Add createdAt to accounts (client v0.7.0)
        //   this.dexie.version(2).stores({
        //       accounts: indexes("&accountCommitment", "id", ..., "createdAt"),
        //   }).upgrade(tx => {
        //       return tx.table("accounts").toCollection().modify(account => {
        //           account.createdAt = 0;
        //       });
        //   });
        //
        // Tips:
        //   - Index-only changes: omit .upgrade(). Dexie creates indexes automatically.
        //   - New table: just include it in .stores(). It starts empty.
        //   - Remove a table: set it to null, e.g. `oldTable: null`.
        //   - Never modify a previous version block. Always add a new one.
        //
        // Note: The `populate` hook (below the version blocks) only fires on
        // first database creation, NOT during upgrades.
        //
        // Version blocks exist below, so V1_STORES is frozen. Never modify it; add a new version
        // block instead.
        this.dexie.version(1).stores(V1_STORES);
        // v2 (miden-client 0.15.4): prune note tags leaked by output-note
        // registration. Mirrors sqlite-store migration
        // `0002_prune_output_note_tags.sql`. Clients built against miden-client
        // < 0.15.4 registered a `Note`-sourced tag for every output note a
        // transaction created, but sync cleanup only removes tags of committed
        // *input* notes — leaking one `tags` row per created note. The client no
        // longer registers those tags; this upgrade deletes the rows already
        // leaked. A tag is kept while an inclusion-pending input note
        // (Expected = 0, Unverified = 1 — the mirror of
        // `InputNoteRecord::is_inclusion_pending`) still needs it.
        this.dexie
            .version(2)
            .stores({})
            .upgrade(async (tx) => {
            const outputNoteCommitments = new Set(await tx.outputNotes.toCollection().primaryKeys());
            if (outputNoteCommitments.size === 0) {
                return;
            }
            const pendingInputNoteCommitments = new Set(await tx.inputNotes
                .where("stateDiscriminant")
                .anyOf([0, 1])
                .primaryKeys());
            await tx.tags
                .filter((tag) => !!tag.sourceNoteId &&
                outputNoteCommitments.has(tag.sourceNoteId) &&
                !pendingInputNoteCommitments.has(tag.sourceNoteId))
                .delete();
        });
        // v3 (miden-client 0.16.0-rc.4): key the input-note consumption index by
        // `detailsCommitment` instead of `noteId`, so the seek in
        // `Store::get_input_note_after` compares the values an `InputNoteCursor`
        // carries and needs no lookup of the cursor's own note. Index-only, so
        // Dexie rebuilds it without an upgrade hook.
        this.dexie.version(3).stores({
            [Table.InputNotes]: indexes("detailsCommitment", "noteId", "nullifier", "scriptRoot", "stateDiscriminant", "[consumedBlockHeight+consumedTxOrder+detailsCommitment]"),
        });
        // v4/v5 (miden-client 0.16.0-rc.4): `settings` is keyed by `[scope+key]`. A primary key
        // cannot change in place, hence the drop and the recreate; the rows it held are cached
        // values the client re-fetches. The client version stamp goes with them, which the v8
        // cutover reads as a store older than MIGRATION_BASELINE.
        this.dexie.version(4).stores({ [Table.Settings]: null });
        this.dexie.version(5).stores({
            [Table.Settings]: indexes("[scope+key]", "scope"),
        });
        // v6: accounts whose witness the sync keeps fresh. The witness column is null until the
        // first refresh.
        this.dexie.version(6).stores({
            [Table.AccountWitnesses]: indexes("&accountId"),
        });
        // v7 (miden-client 0.17.2): the client keeps no private-note relay queue, so a queue row a
        // 0.17.1 client left behind would never be read or cleared. Mirrors sqlite-store migration
        // `0002_drop_note_transport_outbox.sql`; a user-scope row of the same name is untouched.
        this.dexie
            .version(7)
            .stores({})
            .upgrade((tx) => tx
            .table(Table.Settings)
            .delete([SETTING_SCOPE_CLIENT, NOTE_TRANSPORT_OUTBOX_SETTING_KEY]));
        // v8 (miden-client 0.17.4): the one clear on the move from resets to migrations. Every store
        // a 0.17.0 or later client stamped is kept.
        this.dexie
            .version(8)
            .stores({})
            .upgrade(clearStoreStampedBelow(MIGRATION_BASELINE));
        this.accountCodes = this.dexie.table(Table.AccountCode);
        this.latestAccountStorages = this.dexie.table(Table.LatestAccountStorage);
        this.historicalAccountStorages = this.dexie.table(Table.HistoricalAccountStorage);
        this.latestStorageMapEntries = this.dexie.table(Table.LatestStorageMapEntries);
        this.historicalStorageMapEntries = this.dexie.table(Table.HistoricalStorageMapEntries);
        this.latestAccountAssets = this.dexie.table(Table.LatestAccountAssets);
        this.historicalAccountAssets = this.dexie.table(Table.HistoricalAccountAssets);
        this.accountAuths = this.dexie.table(Table.AccountAuth);
        this.accountKeyMappings = this.dexie.table(Table.AccountKeyMapping);
        this.latestAccountHeaders = this.dexie.table(Table.LatestAccountHeaders);
        this.historicalAccountHeaders = this.dexie.table(Table.HistoricalAccountHeaders);
        this.addresses = this.dexie.table(Table.Addresses);
        this.transactions = this.dexie.table(Table.Transactions);
        this.transactionScripts = this.dexie.table(Table.TransactionScripts);
        this.inputNotes = this.dexie.table(Table.InputNotes);
        this.outputNotes = this.dexie.table(Table.OutputNotes);
        this.notesScripts = this.dexie.table(Table.NotesScripts);
        this.blockchainCheckpoint = this.dexie.table(Table.BlockchainCheckpoint);
        this.blockHeaders = this.dexie.table(Table.BlockHeaders);
        this.partialBlockchainNodes = this.dexie.table(Table.PartialBlockchainNodes);
        this.tags = this.dexie.table(Table.Tags);
        this.foreignAccountCode = this.dexie.table(Table.ForeignAccountCode);
        this.settings = this.dexie.table(Table.Settings);
        this.accountWitnesses = this.dexie.table(Table.AccountWitnesses);
        this.dexie.on("populate", (tx) => {
            seedFreshStore(tx)
                /* v8 ignore next 2 — populate blockchainCheckpoint failure requires fake-indexeddb to simulate a write error, not modelable in unit tests */
                .catch((err) => logWebStoreError(err, "Failed to populate DB"));
        });
        // `open` refuses a newer store before Dexie touches it where `indexedDB.databases()` exists.
        // This sticky hook is the fallback for runtimes without it, and it also refuses Dexie's
        // automatic reopen after another tab upgraded the store under an open connection.
        this.dexie.on("ready", (db) => refuseNewerStore(db.name, db.backendDB().version, db.verno), true);
    }
    async open(clientVersion) {
        console.log(`Opening database ${this.dexie.name} for client version ${clientVersion}...`);
        try {
            await this.refuseInstalledNewerStore();
            await this.dexie.open();
            await this.ensureClientVersion(clientVersion);
            console.log("Database opened successfully");
            return true;
            /* v8 ignore next 4 — logWebStoreError always re-throws, so `return false` and this catch block are unreachable */
        }
        catch (err) {
            logWebStoreError(err, "Failed to open database");
            return false;
        }
    }
    // Dexie 4 opens a store whose schema version is above this client's instead of failing with
    // VersionError, and first patches in any table or index the newer schema dropped, raising the
    // native version. Reading the installed version first refuses such a store untouched.
    async refuseInstalledNewerStore() {
        const installed = await this.installedVersion();
        if (installed !== undefined) {
            refuseNewerStore(this.dexie.name, installed, this.dexie.verno);
        }
    }
    // Best effort: the ready hook still refuses a newer store, so a databases() that rejects, or
    // never answers (Safari 14 can leave the first call pending), must not fail or stall the open.
    async installedVersion() {
        const { indexedDB } = Dexie.dependencies;
        if (typeof indexedDB?.databases !== "function") {
            return undefined;
        }
        let timer;
        const gaveUp = new Promise((resolve) => {
            timer = setTimeout(() => resolve(undefined), DATABASES_PROBE_TIMEOUT_MS);
        });
        try {
            const databases = await Promise.race([indexedDB.databases(), gaveUp]);
            return databases?.find((info) => info.name === this.dexie.name)?.version;
        }
        catch {
            return undefined;
        }
        finally {
            clearTimeout(timer);
        }
    }
    // Store version policy: a store is kept across client upgrades and downgrades. Every change to
    // a table's shape or to a stored value's encoding ships a Dexie version whose upgrade()
    // converts the existing rows, and dexie.open() has run them by now. The stamp written here
    // only records the last client for diagnostics and for a future cutover's threshold.
    async ensureClientVersion(clientVersion) {
        if (!clientVersion) {
            console.warn("openDatabase called without a client version; not stamping the store.");
            return;
        }
        if ((await readClientVersion(this.settings)) !== clientVersion) {
            await this.persistClientVersion(clientVersion);
        }
    }
    async persistClientVersion(clientVersion) {
        await this.settings.put({
            scope: SETTING_SCOPE_CLIENT,
            key: CLIENT_VERSION_SETTING_KEY,
            value: textEncoder.encode(clientVersion),
        });
    }
}
