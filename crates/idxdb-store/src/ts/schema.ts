import Dexie, { type Transaction } from "dexie";
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

interface RegistryEntry {
  db: MidenDatabase;
  holders: number;
}

interface PendingOpen {
  holders: number;
  opened: Promise<void>;
}

// Since we can't have a pointer to a JS Object from rust, we'll
// use this instead to keep track of open DBs. A client can have
// a DB for mainnet, devnet, testnet or a custom one, so this should be ok.
// Each name has one connection, held by every live Rust `IdxdbStore` on it.
const databaseRegistry = new Map<string, RegistryEntry>();
const pendingOpens = new Map<string, PendingOpen>();

/**
 * Get a database instance from the registry by its ID.
 * Throws if the database hasn't been opened yet.
 */
export function getDatabase(dbId: string): MidenDatabase {
  const entry = databaseRegistry.get(dbId);
  if (!entry) {
    throw new Error(
      `Database not found for id: ${dbId}. Call openDatabase first.`
    );
  }
  return entry.db;
}

/**
 * Releases one holder of the database registered for `network`, closing and
 * unregistering it when the last holder is gone. No-op for an unknown name.
 */
export function closeDatabase(network: string): void {
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
export async function openDatabase(
  network: string,
  clientVersion: string
): Promise<string> {
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
async function openAndRegister(
  network: string,
  clientVersion: string,
  pending: PendingOpen
): Promise<void> {
  const db = new MidenDatabase(network);
  try {
    const success = await db.open(clientVersion);
    /* v8 ignore next 3 - open() only returns false after logWebStoreError re-throws, so !success is unreachable */
    if (!success) {
      throw new Error(`Failed to open IndexedDB database: ${network}`);
    }
  } catch (err) {
    db.dexie.close();
    throw err;
  } finally {
    pendingOpens.delete(network);
  }
  const replaced = databaseRegistry.get(network);
  replaced?.db.dexie.close();
  databaseRegistry.set(network, {
    db,
    holders: (replaced?.holders ?? 0) + pending.holders,
  });
}

enum Table {
  AccountCode = "accountCode",
  LatestAccountStorage = "latestAccountStorage",
  HistoricalAccountStorage = "historicalAccountStorage",
  LatestAccountAssets = "latestAccountAssets",
  HistoricalAccountAssets = "historicalAccountAssets",
  LatestStorageMapEntries = "latestStorageMapEntries",
  HistoricalStorageMapEntries = "historicalStorageMapEntries",
  AccountAuth = "accountAuth",
  AccountKeyMapping = "accountKeyMapping",
  LatestAccountHeaders = "latestAccountHeaders",
  HistoricalAccountHeaders = "historicalAccountHeaders",
  Addresses = "addresses",
  Transactions = "transactions",
  TransactionScripts = "transactionScripts",
  InputNotes = "inputNotes",
  OutputNotes = "outputNotes",
  NotesScripts = "notesScripts",
  BlockchainCheckpoint = "blockchainCheckpoint",
  BlockHeaders = "blockHeaders",
  PartialBlockchainNodes = "partialBlockchainNodes",
  Tags = "tags",
  ForeignAccountCode = "foreignAccountCode",
  Settings = "settings",
  AccountWitnesses = "accountWitnesses",
}

/** Mirrors `SettingScope`, whose discriminants are part of a store's schema. */
export const SETTING_SCOPE_CLIENT = 0;
export const SETTING_SCOPE_USER = 1;

export interface IAccountCode {
  root: string;
  code: Uint8Array;
}

export interface ILatestAccountStorage {
  accountId: string;
  slotName: string;
  slotValue: string;
  slotType: number;
}

export interface IHistoricalAccountStorage {
  accountId: string;
  replacedAtNonce: string;
  slotName: string;
  oldSlotValue: string | null;
  slotType: number;
}

export interface ILatestStorageMapEntry {
  accountId: string;
  slotName: string;
  key: string;
  value: string;
}

export interface IHistoricalStorageMapEntry {
  accountId: string;
  replacedAtNonce: string;
  slotName: string;
  key: string;
  oldValue: string | null;
}

export interface ILatestAccountAsset {
  accountId: string;
  vaultKey: string;
  asset: string;
}

export interface IHistoricalAccountAsset {
  accountId: string;
  replacedAtNonce: string;
  vaultKey: string;
  oldAsset: string | null;
}

export interface IAccountAuth {
  pubKeyCommitmentHex: string;
  secretKeyHex: string;
}

export interface IAccountKeyMapping {
  accountIdHex: string;
  pubKeyCommitmentHex: string;
}

export interface IAccount {
  id: string;
  codeRoot: string;
  storageRoot: string;
  vaultRoot: string;
  nonce: string;
  committed: boolean;
  accountSeed?: Uint8Array;
  accountCommitment: string;
  locked: boolean;
  watched: boolean;
}

export interface IHistoricalAccount {
  id: string;
  replacedAtNonce: string;
  codeRoot: string;
  storageRoot: string;
  vaultRoot: string;
  nonce: string;
  committed: boolean;
  accountSeed?: Uint8Array;
  accountCommitment: string;
  locked: boolean;
  watched: boolean;
}

export interface IAddress {
  address: Uint8Array;
  id: string;
}

export interface ITransaction {
  id: string;
  details: Uint8Array;
  blockNum: number;
  scriptRoot?: string;
  statusVariant: number;
  status: Uint8Array;
}

export interface ITransactionScript {
  scriptRoot: string;
  txScript?: Uint8Array;
}

export interface IInputNote {
  detailsCommitment: string;
  noteId?: string;
  stateDiscriminant: number;
  assets: Uint8Array;
  attachments: Uint8Array;
  serialNumber: Uint8Array;
  inputs: Uint8Array;
  scriptRoot: string;
  nullifier?: string;
  serializedCreatedAt: string;
  state: Uint8Array;
  consumedBlockHeight?: number;
  consumedTxOrder?: number;
  consumerAccountId?: string;
}

export interface IOutputNote {
  detailsCommitment: string;
  noteId: string;
  recipientDigest: string;
  assets: Uint8Array;
  attachments: Uint8Array;
  metadata: Uint8Array;
  stateDiscriminant: number;
  nullifier?: string;
  expectedHeight: number;
  scriptRoot?: string;
  state: Uint8Array;
}

export interface INotesScript {
  scriptRoot: string;
  serializedNoteScript: Uint8Array;
}

export interface IBlockchainCheckpoint {
  id: number;
  blockNum: number;
  partialBlockchainPeaks: Uint8Array;
}

export interface IBlockHeader {
  blockNum: number;
  header: Uint8Array;
  hasClientNotes: string;
}

export interface IPartialBlockchainNode {
  id: number;
  node: string;
}

export interface ITag {
  id?: number;
  tag: string;
  sourceNoteId?: string;
  sourceAccountId?: string;
  sourceSubscriptionKey?: string;
}

export interface IForeignAccountCode {
  accountId: string;
  codeRoot: string;
}

export interface ISetting {
  scope: number;
  key: string;
  value: Uint8Array;
}

// `witness` stays null until the first sync refreshes it.
export interface IAccountWitness {
  accountId: string;
  witness: Uint8Array | null;
}

export interface JsVaultAsset {
  vaultKey: string;
  asset: string;
}

export interface JsStorageSlot {
  slotName: string;
  slotValue: string;
  slotType: number;
  patchOperation?: number;
}

export interface JsStorageMapEntry {
  slotName: string;
  key: string;
  value: string;
}

function indexes(...items: string[]): string {
  return items.join(",");
}

// This store is the client, so its own bookkeeping belongs to the `Client` scope, which the
// user-facing settings API never reaches.
export async function readClientVersion(
  settings: Dexie.Table<ISetting, [number, string]>
): Promise<string | null> {
  const record = await settings.get([
    SETTING_SCOPE_CLIENT,
    CLIENT_VERSION_SETTING_KEY,
  ]);
  return record ? textDecoder.decode(record.value) : null;
}

// What a store holds before its first sync: the chain checkpoint at the genesis block.
function seedFreshStore(tx: Transaction): Promise<unknown> {
  return tx
    .table<IBlockchainCheckpoint, number>(Table.BlockchainCheckpoint)
    .put({ id: 1, blockNum: 0, partialBlockchainPeaks: new Uint8Array() });
}

// The upgrade of a cutover version. A store stamped below `threshold` (a prerelease of it
// included) or not stamped has every table cleared and is seeded as a fresh store; a stamp that
// is not valid semver keeps it. Clearing inside the versionchange transaction makes it atomic,
// and IndexedDB runs one at a time across tabs and workers, so a context opening the store
// meanwhile waits and then finds it upgraded. A fresh database runs no upgrade callbacks.
function clearStoreStampedBelow(threshold: string) {
  return async (tx: Transaction): Promise<void> => {
    const stamp = await readClientVersion(
      tx.table<ISetting, [number, string]>(Table.Settings)
    );
    if (
      stamp !== null &&
      !(semver.valid(stamp) && semver.lt(stamp, threshold))
    ) {
      return;
    }
    console.warn(
      `Clearing IndexedDB store ${tx.db.name}: ` +
        (stamp === null
          ? "it has no client version stamp."
          : `it was written by client ${stamp}, older than ${threshold}.`)
    );
    // A table a later version adds does not exist yet at this step.
    const tables = Object.values(Table).filter((name) =>
      tx.idbtrans.db.objectStoreNames.contains(name)
    );
    await Promise.all(tables.map((name) => tx.table(name).clear()));
    await seedFreshStore(tx);
  };
}

// Dexie keeps version N natively as N * 10, plus one for each schema patch it applies. Dexie may
// have patched the store's schema before the ready hook runs, so the message only promises that
// nothing was deleted.
function refuseNewerStore(
  name: string,
  nativeVersion: number,
  verno: number
): void {
  const storeVersion = Math.floor(nativeVersion / 10);
  if (storeVersion > verno) {
    throw new Error(
      `IndexedDB store "${name}" was written by a newer Miden client (schema version ` +
        `${storeVersion}; this client reads up to ${verno}). Nothing was deleted. Upgrade the ` +
        `Miden SDK to open it, or clear this site's data to start over.`
    );
  }
}

/** V1 baseline schema. Never modify it: every schema change goes through a new version block.
 *  Exported for migration tests, which seed a physical v1 database before opening it with the
 *  current version chain. */
export const V1_STORES: Record<string, string> = {
  [Table.AccountCode]: indexes("root"),
  [Table.LatestAccountStorage]: indexes("[accountId+slotName]", "accountId"),
  [Table.HistoricalAccountStorage]: indexes(
    "[accountId+replacedAtNonce+slotName]",
    "accountId",
    "[accountId+replacedAtNonce]"
  ),
  [Table.LatestStorageMapEntries]: indexes(
    "[accountId+slotName+key]",
    "accountId",
    "[accountId+slotName]"
  ),
  [Table.HistoricalStorageMapEntries]: indexes(
    "[accountId+replacedAtNonce+slotName+key]",
    "accountId",
    "[accountId+replacedAtNonce]"
  ),
  [Table.LatestAccountAssets]: indexes("[accountId+vaultKey]", "accountId"),
  [Table.HistoricalAccountAssets]: indexes(
    "[accountId+replacedAtNonce+vaultKey]",
    "accountId",
    "[accountId+replacedAtNonce]"
  ),
  [Table.AccountAuth]: indexes("pubKeyCommitmentHex"),
  [Table.AccountKeyMapping]: indexes(
    "[accountIdHex+pubKeyCommitmentHex]",
    "accountIdHex",
    "pubKeyCommitmentHex"
  ),
  [Table.LatestAccountHeaders]: indexes("&id", "accountCommitment"),
  [Table.HistoricalAccountHeaders]: indexes(
    "&accountCommitment",
    "id",
    "[id+replacedAtNonce]"
  ),
  [Table.Addresses]: indexes("address", "id"),
  [Table.Transactions]: indexes("id", "statusVariant"),
  [Table.TransactionScripts]: indexes("scriptRoot"),
  [Table.InputNotes]: indexes(
    "detailsCommitment",
    "noteId",
    "nullifier",
    "scriptRoot",
    "stateDiscriminant",
    "[consumedBlockHeight+consumedTxOrder+noteId]"
  ),
  [Table.OutputNotes]: indexes(
    "detailsCommitment",
    "noteId",
    "recipientDigest",
    "stateDiscriminant",
    "nullifier"
  ),
  [Table.NotesScripts]: indexes("scriptRoot"),
  [Table.BlockchainCheckpoint]: indexes("id"),
  [Table.BlockHeaders]: indexes("blockNum", "hasClientNotes"),
  [Table.PartialBlockchainNodes]: indexes("id"),
  [Table.Tags]: indexes("id++", "tag", "sourceNoteId", "sourceAccountId"),
  [Table.ForeignAccountCode]: indexes("accountId"),
  [Table.Settings]: indexes("key"),
};

// Dexie dynamically adds table accessors to Transaction objects at runtime,
// but the Transaction type doesn't declare them. This augmentation bridges that gap
// so that code passing a Transaction (e.g. `await t.inputNotes.put(...)`) type-checks.
declare module "dexie" {
  interface Transaction {
    inputNotes: Table<IInputNote, string>;
    outputNotes: Table<IOutputNote, string>;
    notesScripts: Table<INotesScript, string>;
    transactions: Table<ITransaction, string>;
    transactionScripts: Table<ITransactionScript, string>;
    tags: Table<ITag, number>;
    latestAccountHeaders: Table<IAccount, string>;
    historicalAccountHeaders: Table<IAccount, string>;
    latestAccountStorages: Table<ILatestAccountStorage, string>;
    historicalAccountStorages: Table<IHistoricalAccountStorage, string>;
    latestStorageMapEntries: Table<ILatestStorageMapEntry, string>;
    historicalStorageMapEntries: Table<IHistoricalStorageMapEntry, string>;
    latestAccountAssets: Table<ILatestAccountAsset, string>;
    historicalAccountAssets: Table<IHistoricalAccountAsset, string>;
    accountCodes: Table<IAccountCode, string>;
    accountAuths: Table<IAccountAuth, string>;
    accountKeyMappings: Table<IAccountKeyMapping, string>;
    addresses: Table<IAddress, string>;
    blockchainCheckpoint: Table<IBlockchainCheckpoint, number>;
    blockHeaders: Table<IBlockHeader, number>;
    partialBlockchainNodes: Table<IPartialBlockchainNode, number>;
    foreignAccountCode: Table<IForeignAccountCode, string>;
    settings: Table<ISetting, [number, string]>;
    accountWitnesses: Table<IAccountWitness, string>;
  }
}

export type MidenDexie = Dexie & {
  accountCodes: Dexie.Table<IAccountCode, string>;
  latestAccountStorages: Dexie.Table<ILatestAccountStorage, string>;
  historicalAccountStorages: Dexie.Table<IHistoricalAccountStorage, string>;
  latestStorageMapEntries: Dexie.Table<ILatestStorageMapEntry, string>;
  historicalStorageMapEntries: Dexie.Table<IHistoricalStorageMapEntry, string>;
  latestAccountAssets: Dexie.Table<ILatestAccountAsset, string>;
  historicalAccountAssets: Dexie.Table<IHistoricalAccountAsset, string>;
  accountAuths: Dexie.Table<IAccountAuth, string>;
  accountKeyMappings: Dexie.Table<IAccountKeyMapping, string>;
  latestAccountHeaders: Dexie.Table<IAccount, string>;
  historicalAccountHeaders: Dexie.Table<IHistoricalAccount, string>;
  addresses: Dexie.Table<IAddress, string>;
  transactions: Dexie.Table<ITransaction, string>;
  transactionScripts: Dexie.Table<ITransactionScript, string>;
  inputNotes: Dexie.Table<IInputNote, string>;
  outputNotes: Dexie.Table<IOutputNote, string>;
  notesScripts: Dexie.Table<INotesScript, string>;
  blockchainCheckpoint: Dexie.Table<IBlockchainCheckpoint, number>;
  blockHeaders: Dexie.Table<IBlockHeader, number>;
  partialBlockchainNodes: Dexie.Table<IPartialBlockchainNode, number>;
  tags: Dexie.Table<ITag, number>;
  foreignAccountCode: Dexie.Table<IForeignAccountCode, string>;
  settings: Dexie.Table<ISetting, [number, string]>;
  accountWitnesses: Dexie.Table<IAccountWitness, string>;
};

export class MidenDatabase {
  dexie: MidenDexie;
  // The version of the client running in this realm, as passed to `open`; empty when it was
  // opened without one. A store's stamp records the last opener, so an import compares with this.
  clientVersion = "";
  accountCodes: Dexie.Table<IAccountCode, string>;
  latestAccountStorages: Dexie.Table<ILatestAccountStorage, string>;
  historicalAccountStorages: Dexie.Table<IHistoricalAccountStorage, string>;
  latestStorageMapEntries: Dexie.Table<ILatestStorageMapEntry, string>;
  historicalStorageMapEntries: Dexie.Table<IHistoricalStorageMapEntry, string>;
  latestAccountAssets: Dexie.Table<ILatestAccountAsset, string>;
  historicalAccountAssets: Dexie.Table<IHistoricalAccountAsset, string>;
  accountAuths: Dexie.Table<IAccountAuth, string>;
  accountKeyMappings: Dexie.Table<IAccountKeyMapping, string>;
  latestAccountHeaders: Dexie.Table<IAccount, string>;
  historicalAccountHeaders: Dexie.Table<IHistoricalAccount, string>;
  addresses: Dexie.Table<IAddress, string>;
  transactions: Dexie.Table<ITransaction, string>;
  transactionScripts: Dexie.Table<ITransactionScript, string>;
  inputNotes: Dexie.Table<IInputNote, string>;
  outputNotes: Dexie.Table<IOutputNote, string>;
  notesScripts: Dexie.Table<INotesScript, string>;
  blockchainCheckpoint: Dexie.Table<IBlockchainCheckpoint, number>;
  blockHeaders: Dexie.Table<IBlockHeader, number>;
  partialBlockchainNodes: Dexie.Table<IPartialBlockchainNode, number>;
  tags: Dexie.Table<ITag, number>;
  foreignAccountCode: Dexie.Table<IForeignAccountCode, string>;
  settings: Dexie.Table<ISetting, [number, string]>;
  accountWitnesses: Dexie.Table<IAccountWitness, string>;

  constructor(network: string) {
    this.dexie = new Dexie(network) as MidenDexie;

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
        const outputNoteCommitments = new Set<string>(
          await tx.outputNotes.toCollection().primaryKeys()
        );
        if (outputNoteCommitments.size === 0) {
          return;
        }
        const pendingInputNoteCommitments = new Set<string>(
          await tx.inputNotes
            .where("stateDiscriminant")
            .anyOf([0, 1])
            .primaryKeys()
        );
        await tx.tags
          .filter(
            (tag) =>
              !!tag.sourceNoteId &&
              outputNoteCommitments.has(tag.sourceNoteId) &&
              !pendingInputNoteCommitments.has(tag.sourceNoteId)
          )
          .delete();
      });

    // v3 (miden-client 0.16.0-rc.4): key the input-note consumption index by
    // `detailsCommitment` instead of `noteId`, so the seek in
    // `Store::get_input_note_after` compares the values an `InputNoteCursor`
    // carries and needs no lookup of the cursor's own note. Index-only, so
    // Dexie rebuilds it without an upgrade hook.
    this.dexie.version(3).stores({
      [Table.InputNotes]: indexes(
        "detailsCommitment",
        "noteId",
        "nullifier",
        "scriptRoot",
        "stateDiscriminant",
        "[consumedBlockHeight+consumedTxOrder+detailsCommitment]"
      ),
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
      .upgrade((tx) =>
        tx
          .table(Table.Settings)
          .delete([SETTING_SCOPE_CLIENT, NOTE_TRANSPORT_OUTBOX_SETTING_KEY])
      );

    // v8 (miden-client 0.17.4): the one clear on the move from resets to migrations. Every store
    // a 0.17.0 or later client stamped is kept.
    this.dexie
      .version(8)
      .stores({})
      .upgrade(clearStoreStampedBelow(MIGRATION_BASELINE));

    this.accountCodes = this.dexie.table<IAccountCode, string>(
      Table.AccountCode
    );
    this.latestAccountStorages = this.dexie.table<
      ILatestAccountStorage,
      string
    >(Table.LatestAccountStorage);
    this.historicalAccountStorages = this.dexie.table<
      IHistoricalAccountStorage,
      string
    >(Table.HistoricalAccountStorage);
    this.latestStorageMapEntries = this.dexie.table<
      ILatestStorageMapEntry,
      string
    >(Table.LatestStorageMapEntries);
    this.historicalStorageMapEntries = this.dexie.table<
      IHistoricalStorageMapEntry,
      string
    >(Table.HistoricalStorageMapEntries);
    this.latestAccountAssets = this.dexie.table<ILatestAccountAsset, string>(
      Table.LatestAccountAssets
    );
    this.historicalAccountAssets = this.dexie.table<
      IHistoricalAccountAsset,
      string
    >(Table.HistoricalAccountAssets);
    this.accountAuths = this.dexie.table<IAccountAuth, string>(
      Table.AccountAuth
    );
    this.accountKeyMappings = this.dexie.table<IAccountKeyMapping, string>(
      Table.AccountKeyMapping
    );
    this.latestAccountHeaders = this.dexie.table<IAccount, string>(
      Table.LatestAccountHeaders
    );
    this.historicalAccountHeaders = this.dexie.table<
      IHistoricalAccount,
      string
    >(Table.HistoricalAccountHeaders);
    this.addresses = this.dexie.table<IAddress, string>(Table.Addresses);
    this.transactions = this.dexie.table<ITransaction, string>(
      Table.Transactions
    );
    this.transactionScripts = this.dexie.table<ITransactionScript, string>(
      Table.TransactionScripts
    );
    this.inputNotes = this.dexie.table<IInputNote, string>(Table.InputNotes);
    this.outputNotes = this.dexie.table<IOutputNote, string>(Table.OutputNotes);
    this.notesScripts = this.dexie.table<INotesScript, string>(
      Table.NotesScripts
    );
    this.blockchainCheckpoint = this.dexie.table<IBlockchainCheckpoint, number>(
      Table.BlockchainCheckpoint
    );
    this.blockHeaders = this.dexie.table<IBlockHeader, number>(
      Table.BlockHeaders
    );
    this.partialBlockchainNodes = this.dexie.table<
      IPartialBlockchainNode,
      number
    >(Table.PartialBlockchainNodes);
    this.tags = this.dexie.table<ITag, number>(Table.Tags);
    this.foreignAccountCode = this.dexie.table<IForeignAccountCode, string>(
      Table.ForeignAccountCode
    );
    this.settings = this.dexie.table<ISetting, [number, string]>(
      Table.Settings
    );
    this.accountWitnesses = this.dexie.table<IAccountWitness, string>(
      Table.AccountWitnesses
    );

    this.dexie.on("populate", (tx) => {
      seedFreshStore(tx)
        /* v8 ignore next 2 — populate blockchainCheckpoint failure requires fake-indexeddb to simulate a write error, not modelable in unit tests */
        .catch((err: unknown) =>
          logWebStoreError(err, "Failed to populate DB")
        );
    });

    // `open` refuses a newer store before Dexie touches it where `indexedDB.databases()` exists.
    // This sticky hook is the fallback for runtimes without it, and it also refuses Dexie's
    // automatic reopen after another tab upgraded the store under an open connection.
    this.dexie.on(
      "ready",
      (db) => refuseNewerStore(db.name, db.backendDB().version, db.verno),
      true
    );
  }

  async open(clientVersion: string): Promise<boolean> {
    console.log(
      `Opening database ${this.dexie.name} for client version ${clientVersion}...`
    );
    this.clientVersion = clientVersion;
    try {
      await this.refuseInstalledNewerStore();
      await this.dexie.open();
      await this.ensureClientVersion(clientVersion);
      console.log("Database opened successfully");
      return true;
      /* v8 ignore next 4 — logWebStoreError always re-throws, so `return false` and this catch block are unreachable */
    } catch (err) {
      logWebStoreError(err, "Failed to open database");
      return false;
    }
  }

  // Dexie 4 opens a store whose schema version is above this client's instead of failing with
  // VersionError, and first patches in any table or index the newer schema dropped, raising the
  // native version. Reading the installed version first refuses such a store untouched.
  private async refuseInstalledNewerStore(): Promise<void> {
    const installed = await this.installedVersion();
    if (installed !== undefined) {
      refuseNewerStore(this.dexie.name, installed, this.dexie.verno);
    }
  }

  // Best effort: the ready hook still refuses a newer store, so a databases() that rejects, or
  // never answers (Safari 14 can leave the first call pending), must not fail or stall the open.
  private async installedVersion(): Promise<number | undefined> {
    const { indexedDB } = Dexie.dependencies;
    if (typeof indexedDB?.databases !== "function") {
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), DATABASES_PROBE_TIMEOUT_MS);
    });
    try {
      const databases = await Promise.race([indexedDB.databases(), gaveUp]);
      return databases?.find((info) => info.name === this.dexie.name)?.version;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  // Store version policy: a store is kept across client upgrades and downgrades. Every change to
  // a table's shape or to a stored value's encoding ships a Dexie version whose upgrade()
  // converts the existing rows, and dexie.open() has run them by now. The stamp written here
  // only records the last client for diagnostics and for a future cutover's threshold.
  private async ensureClientVersion(clientVersion: string): Promise<void> {
    if (!clientVersion) {
      console.warn(
        "openDatabase called without a client version; not stamping the store."
      );
      return;
    }
    if ((await readClientVersion(this.settings)) !== clientVersion) {
      await this.persistClientVersion(clientVersion);
    }
  }

  async persistClientVersion(clientVersion: string): Promise<void> {
    await this.settings.put({
      scope: SETTING_SCOPE_CLIENT,
      key: CLIENT_VERSION_SETTING_KEY,
      value: textEncoder.encode(clientVersion),
    });
  }
}
