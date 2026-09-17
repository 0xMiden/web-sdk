---
name: idxdb-patterns
description: Enforce conventions for the IndexedDB/Dexie persistence layer of the Miden web client, which lives in the web-sdk repo (idxdb-store crate). Use when editing TypeScript in `crates/idxdb-store/src/ts/`, writing Dexie transactions, or modifying the database schema.
---

# IndexedDB Store Patterns (idxdb-store)

This layer lives in the **web-sdk** repo (`github.com/0xMiden/web-sdk`,
crate `crates/idxdb-store`, package `miden-idxdb-store`), not in the
`miden-client` repo. It is a Dexie-backed `Store` implementation for the
WASM web client.

The schema splits account-related tables into `Latest…` / `Historical…`
pairs to support account-history pruning (`WasmWebClient.pruneAccountHistory()`
- it is a WASM method, not part of the `MidenClient` resource surface).
Always check `crates/idxdb-store/src/ts/schema.ts` for the canonical table
list before adding rows or filters. The active set includes `AccountAuth`,
`AccountKeyMapping`, `Addresses`, `Settings`, `ForeignAccountCode`,
`NotesScripts`, `TransactionScripts`, `BlockchainCheckpoint`,
`PartialBlockchainNodes`, `LatestStorageMapEntries`,
`HistoricalStorageMapEntries`, plus the account-storage / asset /
account-header latest/historical pairs.

## Build Workflow

The `idxdb-store` has a dual-file workflow:

- **TypeScript source** lives in `crates/idxdb-store/src/ts/`
- **Generated JavaScript** lives in `crates/idxdb-store/src/js/`
- **Both are committed to git**. The `js` folder is currently *not*
  gitignored (the `#js` entry in `src/.gitignore` is commented out)
- The Rust side imports the generated `.js` modules via
  `#[wasm_bindgen(module = "/src/js/...")]`, so the JS must be kept in
  sync with the TS

After modifying any `.ts` file, regenerate the JS with the canonical
top-level Make target (which runs the package's `build` script through
**pnpm**; this repo is pnpm-only, there is no yarn):

```bash
make rust-client-ts-build   # == pnpm --filter web_store run build
```

The underlying package script is `tsc --build --force ./tsconfig.json`
(`crates/idxdb-store/src/package.json`). Always commit both the `.ts`
source and the regenerated `.js` output together.

## Database Registry

There is no JS object pointer on the Rust side, so open databases are
tracked in a module-level `Map` keyed by network name, in
`crates/idxdb-store/src/ts/schema.ts`:

```typescript
const databaseRegistry = new Map<string, MidenDatabase>();

export function getDatabase(dbId: string): MidenDatabase {
  const db = databaseRegistry.get(dbId);
  if (!db) {
    throw new Error(
      `Database not found for id: ${dbId}. Call openDatabase first.`
    );
  }
  return db;
}

export async function openDatabase(
  network: string,
  clientVersion: string
): Promise<string> {
  const db = new MidenDatabase(network);
  const success = await db.open(clientVersion);
  if (!success) {
    throw new Error(`Failed to open IndexedDB database: ${network}`);
  }
  databaseRegistry.set(network, db);
  return network;
}
```

Rules:

- Every exported store function takes `dbId: string` as its first parameter
- Call `const db = getDatabase(dbId)` at the top of each function. Look it
  up per call rather than holding a long-lived reference across calls
- The `dbId` is the network name (`"mainnet"`, `"devnet"`, `"testnet"`, or
  a custom one); `openDatabase` registers under and returns `network`

## Schema Interfaces

Define TypeScript interfaces for each table with the `I` prefix. Use
`Latest…` / `Historical…` pairs for anything that participates in account
history (storage slots, storage map entries, vault assets, and account
headers). The account-header pair uses `IAccount` (latest, keyed on `id`)
and `IHistoricalAccount` (same fields plus `replacedAtNonce`) inside
`latestAccountHeaders` / `historicalAccountHeaders`:

```typescript
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

export interface ILatestAccountAsset {
  accountId: string;
  vaultKey: string;     // ASSET_KEY, see the `miden-concepts` skill
  asset: string;        // ASSET_VALUE serialized
}

export interface IHistoricalAccountAsset {
  accountId: string;
  replacedAtNonce: string;
  vaultKey: string;
  oldAsset: string | null;
}

export interface IAccount {
  id: string;           // primary key, NOT `accountId`
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

export interface IBlockchainCheckpoint {
  id: number;           // always 1; the singleton sync row
  blockNum: number;
  partialBlockchainPeaks: Uint8Array;
}

export interface ISetting {
  scope: number;        // SETTING_SCOPE_CLIENT | SETTING_SCOPE_USER
  key: string;
  value: Uint8Array;
}
```

Rules:

- Use `string` for hex-encoded values (hashes, IDs, commitments, nonces,
  vault keys)
- Use `Uint8Array` for raw binary data
- Use `?` suffix for optional fields, `| null` when the column explicitly
  represents the absence of a previous value (e.g. `oldSlotValue`,
  `oldAsset`, `oldValue` in the history tables)
- Use `boolean` for flags, `number` for block heights and slot types
- The LATEST account-header table keys on `id`; the HISTORICAL
  account-header table keys on `accountCommitment` (with `id` and
  `[id+replacedAtNonce]` as secondary indexes). The storage / asset /
  map-entry / foreign-code tables key on `accountId`. Don't confuse the two.
- The asset layer is two-word: `vaultKey` is the `ASSET_KEY` and `asset`
  is the encoded `ASSET_VALUE`. Don't fold them back into a single hex
  string.
- `settings` rows are **scoped**. `ISetting` carries a `scope` discriminant
  and the row's primary key is the compound `[scope, key]`, never `key`
  alone. See [Scoped settings](#scoped-settings) below.

## Table Enum

Define tables as a TypeScript enum, in the order they appear in
`crates/idxdb-store/src/ts/schema.ts`. The Rust side imports table-backed
JS functions verbatim:

```typescript
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
}
```

There is no `stateSync` table. The singleton sync row lives in
`blockchainCheckpoint` (id `1`) and carries `partialBlockchainPeaks`
alongside `blockNum`.

## Schema Versioning

The Dexie schema is a **version chain**, not a single declaration.
`V1_STORES` is the frozen v1 baseline, applied as
`this.dexie.version(1).stores(V1_STORES)` in the `MidenDatabase`
constructor; its index strings are built with a small `indexes(...)`
helper, e.g.
`[Table.LatestAccountStorage]: indexes("[accountId+slotName]", "accountId")`.
Every later change is its own `.version(N).stores({...})` block.

**The current schema version is 5.**

| Version | Change |
| --- | --- |
| 1 | Baseline, `V1_STORES` |
| 2 | Data-only. Deletes `tags` rows leaked by output-note registration, mirroring the sqlite-store `0002_prune_output_note_tags.sql`. A tag is kept while an inclusion-pending input note (`stateDiscriminant` 0 or 1) still needs it |
| 3 | Rekeys the input-note consumption index to `[consumedBlockHeight+consumedTxOrder+detailsCommitment]` (was `...+noteId`), so `Store::get_input_note_after` seeks on the values an `InputNoteCursor` carries. Index-only, no `.upgrade()` hook |
| 4 | Drops `settings`: `this.dexie.version(4).stores({ [Table.Settings]: null })` |
| 5 | Recreates `settings` as `indexes("[scope+key]", "scope")`. A primary key cannot change in place, hence the drop-and-recreate pair |

### Migrations ARE in use

Migrations **coexist** with the client-version nuke; the old "migrations are
not enabled yet, just edit `V1_STORES`" rule is dead. `ensureClientVersion`
still nukes the DB (close / `delete` / re-open) when the running client
version is a higher major **or minor** than the stored one, because the Miden
network resets on those upgrades. Same-major.minor patch bumps and downgrades
just persist the new version without resetting (see the semver
`sameMajorMinor` / `!semver.gt(...)` guard). The Dexie version blocks handle
schema and data fixes for stores that survive those patch upgrades.

**`V1_STORES` is frozen. Never modify it.** schema.ts says so at the constant
and again above `this.dexie.version(1)`. Adding a table or changing an index
today means:

1. Update the `Table` enum + interface(s) in `schema.ts`
2. Add a **new** `this.dexie.version(N+1).stores({...})` block at the bottom
   of the chain, listing only the tables whose indexes changed (Dexie carries
   the rest forward). Add `.upgrade(tx => {...})` only if existing rows need
   rewriting; index-only changes need no hook. Removing a table is
   `{ [Table.Foo]: null }`, and a primary-key change is a drop block followed
   by a recreate block (see v4/v5)
3. Update the `declare module "dexie"` augmentation, the `MidenDexie` type,
   and the `MidenDatabase` field + `this.dexie.table<...>(...)` assignment
4. Update Rust-side reads/writes, which import the corresponding JS
   functions through `#[wasm_bindgen(module = "/src/js/<file>.js")]`
   (e.g. account functions from `/src/js/accounts.js`, schema/registry
   functions from `/src/js/schema.js`)
5. Run `make rust-client-ts-build` to regenerate the JS, and add a
   migration test in `schema.test.ts` (the existing ones seed a physical v1
   database from the exported `V1_STORES`, then reopen through
   `MidenDatabase` so the whole chain runs)

The `populate` hook fires only on first database creation, never during an
upgrade. It seeds the `blockchainCheckpoint` singleton.

Because v1 is frozen history, `V1_STORES[Table.Settings]` still reads
`indexes("key")`. That is **not** the live schema. Read the last version
block that touches a table, not `V1_STORES`, when you need its current key.

## Scoped Settings

`settings` is namespaced by scope. The same key under `Client` and under
`User` is a separate row, and the primary key is the compound `[scope, key]`:

```typescript
export const SETTING_SCOPE_CLIENT = 0;   // store's own bookkeeping
export const SETTING_SCOPE_USER = 1;     // the user-facing settings API
```

- All five settings functions take `scope` as the parameter right after
  `dbId`: `getSetting`, `insertSetting`, `removeSetting`, `listSettingKeys`,
  `applySettingsMutations`. The Rust side passes `SettingScope::as_u8()`.
- Address a row with the **tuple**: `db.settings.get([scope, key])`,
  `db.settings.delete([scope, key])`, and `put({ scope, key, value })`.
  A bare `get(key)` silently misses.
- `listSettingKeys` filters on the `scope` secondary index and strips the
  scope off the compound primary keys it gets back:
  `keys.map(([, key]) => key)`.
- There is **no** `INTERNAL_SETTING_KEYS` filter any more. It existed to hide
  the store's own `clientVersion` row from user listings; that row now lives
  in `SETTING_SCOPE_CLIENT` and a scoped listing cannot see it.
- `ensureClientVersion` reads and writes `CLIENT_VERSION_SETTING_KEY` under
  `SETTING_SCOPE_CLIENT`, never `User`.

## Dexie Transactions

### Atomic Operations

When multiple tables must be updated together, wrap in a Dexie transaction.
List every table the transaction touches, and use `Promise.all()` to run
independent operations concurrently (from `applyStateSync` in
`crates/idxdb-store/src/ts/sync.ts`):

```typescript
const tablesToAccess = [
  db.blockchainCheckpoint,
  db.inputNotes,
  db.outputNotes,
  db.notesScripts,
  db.transactions,
  db.transactionScripts,
  db.blockHeaders,
  db.partialBlockchainNodes,
  db.tags,
  db.latestAccountHeaders,
  db.historicalAccountHeaders,
  // ... plus the latest/historical storage, map-entry and asset tables
];

return await db.dexie.transaction("rw", tablesToAccess, async (tx) => {
  await Promise.all([
    /* input/output note upserts */,
    /* transaction upserts */,
    /* per-account applyFullAccountState calls */,
    updateSyncHeight(tx, blockNum, newPeaks),
    updatePartialBlockchainNodes(tx, serializedNodeIds, serializedNodes),
    updateCommittedNoteTags(tx, committedNoteTagSources),
    /* block-header writes */,
  ]);
});
```

Rules:

- Use `"rw"` for read-write transactions
- List all tables that will be accessed in the `tablesToAccess` array
- Use `Promise.all()` inside transactions to parallelize independent operations
- Pass the `tx` transaction object to helper functions that need table access
- Helper write functions (e.g. `upsertInputNote`) commonly take an optional
  `tx?: Transaction`: if supplied they run inside the caller's transaction,
  otherwise they open their own `db.dexie.transaction(...)`

### Table Access Within Transactions

The Dexie `Transaction` type doesn't statically declare table accessors.
`schema.ts` augments `declare module "dexie"` so `tx.inputNotes` etc.
type-check; where that augmentation isn't in scope, type-cast the
transaction (from `updateSyncHeight` in `sync.ts`):

```typescript
async function updateSyncHeight(
  tx: Transaction,
  blockNum: number,
  newPeaks: Uint8Array
) {
  try {
    const current = await (
      tx as Transaction & {
        blockchainCheckpoint: Dexie.Table<IBlockchainCheckpoint, number>;
      }
    ).blockchainCheckpoint.get(1);
    if (!current || current.blockNum < blockNum) {
      await (
        tx as Transaction & {
          blockchainCheckpoint: Dexie.Table<IBlockchainCheckpoint, number>;
        }
      ).blockchainCheckpoint.update(1, {
        blockNum: blockNum,
        partialBlockchainPeaks: newPeaks,
      });
    }
  } catch (error) {
    logWebStoreError(error, "Failed to update sync height");
  }
}
```

### Forward-Only Updates

Only advance the sync height forward (never regress):

```typescript
if (!current || current.blockNum < blockNum) {
  // Update
}
```

The MMR peaks travel with `blockNum` in the same row, so skipping the height
update deliberately skips the peaks update too. A backward-going sync must
not overwrite newer peaks with older ones. Keep them in one `update()` call.

## Error Handling

### logWebStoreError

Use `logWebStoreError()` from `./utils.js` for error logging. It formats
Dexie errors (and walks `error.inner`), then **re-throws** the error:

```typescript
import { logWebStoreError } from "./utils.js";

try {
  // database operation
} catch (error) {
  logWebStoreError(error, "Error while fetching account headers");
}
```

Because `logWebStoreError` always re-throws, code after a `catch` that
calls it (e.g. a trailing `return []`) is effectively unreachable on the
error path. The surrounding `try` body must return the success value.

TypeScript cannot see that, so two conventions cover the gap:

- Where the unreachable tail would otherwise make the function's return type
  include `undefined`, add an explicit `throw error;` after the
  `logWebStoreError` call (see `removeSetting`, `removeAccountAddress`).
- Mark the genuinely unreachable tail with a `/* v8 ignore next N */` pragma
  and a one-line reason, so it doesn't sink the coverage gate.

### Reads return optional / empty

Read functions wrap their body in `try/catch`, returning the queried value
on success. The fallback after the catch (empty array, `null`, or
`undefined`) documents intent but is unreachable because `logWebStoreError`
re-throws (from `getAccountIds` in `crates/idxdb-store/src/ts/accounts.ts`):

```typescript
export async function getAccountIds(dbId: string) {
  try {
    const db = getDatabase(dbId);
    const records = await db.latestAccountHeaders.toArray();
    return records.map((entry) => entry.id);   // header rows key on `id`
  } catch (error) {
    logWebStoreError(error, "Error while fetching account IDs");
  }
  /* v8 ignore next 2 */
  return [];
}
```

### Functions that report presence

Some `Store` trait methods need to say whether anything was there.
`removeSetting` and `removeAccountAddress` return `Promise<boolean>`:

- `Table.delete()` resolves to nothing whether or not a row matched, so
  `removeSetting` reads inside the same `"rw"` transaction and returns that.
- `Collection.delete()` resolves to the number of rows removed, so
  `removeAccountAddress` returns `deleted > 0` and needs no extra read.

Both end their `catch` with `throw error;` for the reason above. The
corresponding `WasmWebClient` JS methods still resolve to nothing; the
boolean is for the Rust `Store` impl.

## Data Operations

### Querying

Use Dexie's query API. Patterns actually used in the store:

```typescript
// Get all records
const records = await db.latestAccountHeaders.toArray();

// Get by primary key (the blockchainCheckpoint singleton is row id 1)
const current = await db.blockchainCheckpoint.get(1);

// Look up a header by its `id` index (header PK is `id`)
const record = await db.latestAccountHeaders
  .where("id")
  .equals(accountId)
  .first();

// Filter a single-field index, optionally narrowing with `.and(...)`
const slots = await db.latestAccountStorages
  .where("accountId")
  .equals(accountId)
  .and((record) => nameSet.has(record.slotName))
  .toArray();

// Match multiple keys against one index
const codes = await db.accountCodes.where("root").anyOf(codeRoots).toArray();
```

For compound indexes, use the **bracket-string** index name and pass the
key parts as an array to `.equals(...)` (from `applyAccountPatch`):

```typescript
const oldSlot = await db.latestAccountStorages
  .where("[accountId+slotName]")
  .equals([accountId, slot.slotName])
  .first();
```

### Cursor-seeking input notes

`getInputNoteAfter` replaces the old `getInputNoteByOffset`: it seeks **past
a cursor** rather than skipping an ordinal count, so a set that changes
between calls can no longer skip or repeat a note. Two things follow:

- The cursor is `(consumedBlockHeight, consumedTxOrder, detailsCommitment)`
  and is compared as an index key with `.above([...])`, never looked up. That
  is why v3 rekeyed the index on `detailsCommitment`: the seek resolves the
  right position even once the cursor's own note has been deleted.
- With a cursor set, `blockStart` is left to the row predicate. Emitting both
  a cursor bound and a `blockStart` bound abandons the row-value seek.
- Notes with **no** consumption order are no longer returned. Dexie skips
  rows whose index components are `undefined`, and `SqliteStore` behaves the
  same way. Don't "fix" this by widening the query.

```typescript
const INPUT_NOTE_CONSUMPTION_INDEX =
  "[consumedBlockHeight+consumedTxOrder+detailsCommitment]";
```

### Latest vs Historical

For account state, the `latest…` tables hold the current row (keyed by
`accountId`, or the compound `[accountId+slotName]` / `[accountId+vaultKey]`
/ `[accountId+slotName+key]`); the matching `historical…` tables hold the
value that was replaced, keyed by `[accountId+replacedAtNonce…]` with the
prior value in `oldSlotValue` / `oldAsset` / `oldValue` (`null` when no
previous value existed). The write path is **archive-then-replace**: read
the current latest row, `put` it into historical under the new nonce, then
`put` the new value into latest (see `applyAccountPatch` /
`applyFullAccountState`).

Undo restores from history back to latest, keyed by the compound nonce
index; a non-null old value overwrites latest, a `null` old value deletes
the latest row (from `restoreSlotsFromHistorical` in `accounts.ts`):

```typescript
const oldSlots = await db.historicalAccountStorages
  .where("[accountId+replacedAtNonce]")
  .equals([accountId, nonce])
  .toArray();

for (const slot of oldSlots) {
  if (slot.oldSlotValue !== null) {
    await db.latestAccountStorages.put({ /* ...restore old value... */ });
  } else {
    await db.latestAccountStorages
      .where("[accountId+slotName]")
      .equals([accountId, slot.slotName])
      .delete();
  }
}
```

`pruneAccountHistory` drops `historical…` rows whose
`replacedAtNonce <= upToNonce` and any orphaned account code. Write
functions must keep the latest row authoritative regardless of how much
history has been pruned.

### Absolute patches, not relative deltas

`applyAccountPatch` is the account write path (the old `applyTransactionDelta`
is gone along with the relative delta model). Values arriving from Rust are
**absolute**, so the store writes the final state rather than composing it:

- `JsStorageSlot` carries an optional `patchOperation` discriminant.
  `0` and `2` on a map slot (`slotType === STORAGE_SLOT_TYPE_MAP`, exported
  from `schema.ts` as `1`) mean the map is reset: archive every persisted
  entry for that slot into `historicalStorageMapEntries`, then delete them
  from `latestStorageMapEntries`.
- `patchOperation === 2` additionally deletes the latest storage-slot row
  instead of writing a new value.
- Everything else is a plain archive-then-replace `put`.

Getting this wrong is silent: a missed reset leaves stale map entries that no
later patch overwrites, because an absolute patch only names the keys it sets.

### Serialization Conventions

- Hex strings for cryptographic values (hashes, IDs, commitments, vault keys)
- `uint8ArrayToBase64()` (from `./utils.js`) when a `Uint8Array` must be
  returned to Rust as a base64 string (e.g. serialized account code, seeds)
- `Uint8Array` for direct binary storage in a table column
- Default empty strings for optional string fields when reading out:
  `record.storageRoot || ""`
- `BigInt()` for nonce comparisons and sorting (nonces are stored as
  strings, so lexicographic / index-range ordering would be wrong)

## Upsert Pattern

Dexie `Table.put()` is itself an upsert: it inserts or replaces by primary
key. The store builds a plain data object and calls `.put()`; it does not
read-then-branch. Convert `null` to `undefined` so Dexie omits the field
from indexes (a `null` in a compound index is a real value; an absent
field is skipped, which is what keeps unconsumed notes out of the
consumption index). From `upsertInputNote` in
`crates/idxdb-store/src/ts/notes.ts`:

```typescript
export async function upsertInputNote(
  dbId: string,
  detailsCommitment: string,
  noteId: string | undefined,
  // ... more params
  consumedBlockHeight?: number | null,
  consumedTxOrder?: number | null,
  consumerAccountId?: string | null,
  tx?: Transaction
) {
  const db = getDatabase(dbId);
  const doWork = async (t: Transaction) => {
    try {
      const data = {
        detailsCommitment,
        noteId: noteId ?? undefined,
        // null -> undefined so Dexie omits these from compound indexes
        consumedBlockHeight: consumedBlockHeight ?? undefined,
        consumedTxOrder: consumedTxOrder ?? undefined,
        consumerAccountId: consumerAccountId ?? undefined,
        // ... remaining fields
      };
      await t.inputNotes.put(data);
      await t.notesScripts.put({ scriptRoot, serializedNoteScript });
    } catch (error) {
      logWebStoreError(error, `Error inserting note: ${detailsCommitment}`);
      throw error;
    }
  };
  // Run inside the caller's tx if provided, else open one.
  if (tx) return doWork(tx);
  return db.dexie.transaction("rw", db.inputNotes, db.notesScripts, doWork);
}
```
