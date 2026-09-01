import Dexie from "dexie";
import * as semver from "semver";
import { logWebStoreError } from "./utils.js";

export const CLIENT_VERSION_SETTING_KEY = "clientVersion";

/** Mirrors `StorageSlotType::Map`, originally defined in miden-protocol. */
export const STORAGE_SLOT_TYPE_MAP = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Since we can't have a pointer to a JS Object from rust, we'll
// use this instead to keep track of open DBs. A client can have
// a DB for mainnet, devnet, testnet or a custom one, so this should be ok.
const databaseRegistry = new Map<string, MidenDatabase>();

// In-process fallback queue for environments without navigator.locks (e.g. Node/Vitest)
const initLocks = new Map<string, Promise<void>>();

export async function acquireDbInitLock<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return await navigator.locks.request(`miden-db-init:${name}`, fn);
  }

  const prevLock = initLocks.get(name) ?? Promise.resolve();
  let release: () => void;
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  initLocks.set(name, nextLock);

  await prevLock;
  try {
    return await fn();
  } finally {
    release!();
    if (initLocks.get(name) === nextLock) {
      initLocks.delete(name);
    }
  }
}

/**
 * Get a database instance from the registry by its ID.
 * Throws if the database hasn't been opened yet.
 */
export function getDatabase(dbId: string): MidenDatabase {
  const db = databaseRegistry.get(dbId);
  if (!db) {
    throw new Error(
      `Database not found for id: ${dbId}. Call openDatabase first.`
    );
  }
  return db;
}

/**
 * Opens a database for the given network and registers it in the registry.
 * Returns the database ID (network name) which can be used to retrieve the database later.
 */
export async function openDatabase(
  network: string,
  clientVersion: string
): Promise<string> {
  return await acquireDbInitLock(network, async () => {
    const db = new MidenDatabase(network);
    const success = await db.open(clientVersion);
    /* v8 ignore next 3 — open() only returns false after logWebStoreError re-throws, so !success is unreachable */
    if (!success) {
      throw new Error(`Failed to open IndexedDB database: ${network}`);
    }
    databaseRegistry.set(network, db);
    return network;
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
  StateSync = "stateSync",
  BlockHeaders = "blockHeaders",
  PartialBlockchainNodes = "partialBlockchainNodes",
  Tags = "tags",
  ForeignAccountCode = "foreignAccountCode",
  Settings = "settings",
}

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
  state: Uint8Array;
}

export interface INotesScript {
  scriptRoot: string;
  serializedNoteScript: Uint8Array;
}

export interface IStateSync {
  id: number;
  blockNum: number;
}

export interface IBlockHeader {
  blockNum: number;
  header: Uint8Array;
  /** Serialized MMR peaks at this block's forest. Set only on rows that were
   *  the chain tip when their corresponding sync ran — `applyStateSync`
   *  writes peaks to the row where `blockNum === state_sync.block_num`.
   *  Backfilled blocks (`insertBlockHeader` from `get_and_store_authenticated_block`)
   *  leave this undefined. `getCurrentBlockchainPeaks` reads the row at
   *  the current `stateSync.blockNum`. */
  partialBlockchainPeaks?: Uint8Array;
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
  key: string;
  value: Uint8Array;
}

export interface JsVaultAsset {
  vaultKey: string;
  asset: string;
}

export interface JsStorageSlot {
  slotName: string;
  slotValue: string;
  slotType: number;
}

export interface JsStorageMapEntry {
  slotName: string;
  key: string;
  value: string;
}

function indexes(...items: string[]): string {
  return items.join(",");
}

/** V1 baseline schema. Extracted as a constant because once migrations are enabled, this must
 *  never be modified — all schema changes should go through new version blocks instead.
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
  [Table.StateSync]: indexes("id"),
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
    stateSync: Table<IStateSync, number>;
    blockHeaders: Table<IBlockHeader, number>;
    partialBlockchainNodes: Table<IPartialBlockchainNode, number>;
    foreignAccountCode: Table<IForeignAccountCode, string>;
    settings: Table<ISetting, string>;
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
  stateSync: Dexie.Table<IStateSync, number>;
  blockHeaders: Dexie.Table<IBlockHeader, number>;
  partialBlockchainNodes: Dexie.Table<IPartialBlockchainNode, number>;
  tags: Dexie.Table<ITag, number>;
  foreignAccountCode: Dexie.Table<IForeignAccountCode, string>;
  settings: Dexie.Table<ISetting, string>;
};

export class MidenDatabase {
  dexie: MidenDexie;
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
  stateSync: Dexie.Table<IStateSync, number>;
  blockHeaders: Dexie.Table<IBlockHeader, number>;
  partialBlockchainNodes: Dexie.Table<IPartialBlockchainNode, number>;
  tags: Dexie.Table<ITag, number>;
  foreignAccountCode: Dexie.Table<IForeignAccountCode, string>;
  settings: Dexie.Table<ISetting, string>;

  constructor(network: string) {
    this.dexie = new Dexie(network) as MidenDexie;

    // --- Schema versioning ---
    //
    // NOTE: Migrations coexist with the client-version nuke: the database is
    // still nuked on major/minor client-version changes (network resets — see
    // ensureClientVersion), while Dexie version blocks below handle schema and
    // data fixes for stores that survive patch upgrades. Once the network
    // stabilizes and data can be preserved across all upgrades, the
    // version-change nuke will be removed and migrations alone will take over.
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
    // Version blocks exist below, so V1_STORES is frozen — never modify it;
    // add a new version block instead. To retire the nuke entirely (once data
    // must survive major/minor upgrades), remove the close/delete/open logic
    // in ensureClientVersion and just persist the new version there.
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
    //
    // This data-only fix coexists with the version-change nuke above: the
    // nuke covers major/minor client upgrades (network resets), while this
    // upgrade runs for stores preserved across patch upgrades.
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
    this.stateSync = this.dexie.table<IStateSync, number>(Table.StateSync);
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
    this.settings = this.dexie.table<ISetting, string>(Table.Settings);

    this.dexie.on("populate", () => {
      this.stateSync
        .put({ id: 1, blockNum: 0 } as IStateSync)
        /* v8 ignore next 2 — populate stateSync failure requires fake-indexeddb to simulate a write error, not modelable in unit tests */
        .catch((err: unknown) =>
          logWebStoreError(err, "Failed to populate DB")
        );
    });
  }

  async open(clientVersion: string): Promise<boolean> {
    console.log(
      `Opening database ${this.dexie.name} for client version ${clientVersion}...`
    );
    try {
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

  private async ensureClientVersion(clientVersion: string): Promise<void> {
    if (!clientVersion) {
      console.warn(
        "openDatabase called without a client version; skipping version enforcement."
      );
      return;
    }

    const storedVersion = await this.getStoredClientVersion();
    if (!storedVersion) {
      await this.persistClientVersion(clientVersion);
      return;
    }

    if (storedVersion === clientVersion) {
      return;
    }

    const validCurrent = semver.valid(clientVersion);
    const validStored = semver.valid(storedVersion);
    if (validCurrent && validStored) {
      const parsedCurrent = semver.parse(validCurrent);
      const parsedStored = semver.parse(validStored);
      const sameMajorMinor =
        parsedCurrent?.major === parsedStored?.major &&
        parsedCurrent?.minor === parsedStored?.minor;
      if (sameMajorMinor || !semver.gt(clientVersion, storedVersion)) {
        await this.persistClientVersion(clientVersion);
        return;
      }
    } else {
      console.warn(
        `Failed to parse semver (${storedVersion} vs ${clientVersion}), forcing store reset.`
      );
    }

    console.warn(
      `IndexedDB client version mismatch (stored=${storedVersion}, expected=${clientVersion}). Resetting store.`
    );
    this.dexie.close();
    await this.dexie.delete();
    await this.dexie.open();
    await this.persistClientVersion(clientVersion);
  }

  private async getStoredClientVersion(): Promise<string | null> {
    const record = await this.settings.get(CLIENT_VERSION_SETTING_KEY);
    if (!record) {
      return null;
    }
    return textDecoder.decode(record.value);
  }

  private async persistClientVersion(clientVersion: string): Promise<void> {
    await this.settings.put({
      key: CLIENT_VERSION_SETTING_KEY,
      value: textEncoder.encode(clientVersion),
    });
  }
}
