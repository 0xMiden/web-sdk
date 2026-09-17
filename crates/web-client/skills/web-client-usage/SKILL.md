---
name: web-client-usage
description: Conventions for writing JavaScript/TypeScript code that uses the Miden web SDK (`@miden-sdk/miden-sdk`). Use when building apps on Miden, writing integration tests, or calling MidenClient methods - covers initialization, the resource-based API (accounts, transactions, notes, tags, settings, compile, keystore, pswap), sync ordering, type conversions, transaction flows, fees, custom contracts, foreign accounts, private note transport, observability, and pitfalls.
---

# Web SDK Usage Patterns

This skill targets the `@miden-sdk/miden-sdk` npm package published from
[`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk) (the JS web client; at
0.16.1 it builds on the `miden-client` 0.16.1 Rust crate). For React-hook usage,
prefer the `react-sdk-patterns` skill - only fall through to the raw client when
a hook does not cover what you need. For pinning a reference block so a
proposer, its co-signers and the executor all derive the same transaction
summary, see the sibling `chain-anchored-execution` skill; do not re-derive that
flow here.

## API Overview

The SDK exposes a top-level `MidenClient` whose state is split across typed
**resources**:

| Resource             | What it covers                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.accounts`    | Wallets, faucets, custom contracts, listing, import/export, addresses                                                                                                          |
| `client.transactions` | `send` / `mint` / `bridge` / `consume` / `consumeAll` / `swap` / `pswapCreate` / `pswapConsume` / `pswapCancel` / `createNetworkNote` / `execute` / `executeProgram` / `batch` / `preview` / `captureAnchor` / `executeRequest` / `submit` / `submitProven` / `foreignAccountInputs` / `list` / `waitFor` |
| `client.notes`       | Listing, fetching, importing/exporting, private-note transport                                                                                                                 |
| `client.tags`        | Note-tag subscriptions                                                                                                                                                         |
| `client.settings`    | Persistent client settings                                                                                                                                                     |
| `client.compile`     | Compiling MASM into account components, tx scripts, note scripts                                                                                                               |
| `client.keystore`    | Inserting / fetching / removing secret keys                                                                                                                                    |
| `client.pswap`       | Partial-swap lineages: `lineages` / `lineagesFor` / `lineage` / `cancelByOrder`                                                                                                |

`MidenClient` is the public surface. The underlying WASM-bound class is
exported as `WasmWebClient` (an alias for `WebClient`) for low-level operations
the resource API does not yet wrap. The client's own handle on it is the
private field `#inner`, which is **not reachable from outside the class** -
the supported escape hatch is `client._withInnerWebClient(fn)`:

```typescript
const summary = await client._withInnerWebClient(async (inner) => {
  const request = await inner.newConsumeTransactionRequest(notes, accountId);
  return inner.executeForSummary(accountId, request);
});
```

The callback runs with the WASM RefCell held, so it cannot race the proxy's
call chain. It is marked `@internal`: pin the SDK version if you depend on it,
and re-test the low-level surface on every upgrade.

## Client Initialization

### Convenience constructors (recommended)

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

// Testnet - autoSync on, testnet RPC + prover + note transport
const client = await MidenClient.createTestnet();

// Devnet equivalent
const client = await MidenClient.createDevnet();
```

Both accept the same `ClientOptions` for overrides:

```typescript
const client = await MidenClient.createTestnet({
  storeName: "my-app-tests", // isolates the IndexedDB store
  proverUrl: "local", // prove locally instead of remote
  autoSync: false, // disable initial sync
});
```

### Generic constructor

```typescript
const client = await MidenClient.create({
  rpcUrl: "https://rpc.testnet.miden.io", // string URL or "testnet"/"devnet"/"localhost"/"local"
  noteTransportUrl: "https://transport.miden.io",
  storeName: "my-store",
  seed: new Uint8Array(32), // optional - deterministic key generation
  proverUrl: "testnet", // optional - sets a default prover
  autoSync: true, // optional - call sync() after init
  useWorker: true, // optional - default true; see below
  keystore: {
    // optional - external HSM/keystore
    getKey: async (pubKey) => {
      /* return secretKey or null */
    },
    insertKey: async (pubKey, secretKey) => {
      /* persist */
    },
    sign: async (pubKey, signingInputs) => {
      /* return signature */
    },
  },
});
```

If `rpcUrl` is omitted, `create()` delegates to `createTestnet()`.

`useWorker` defaults to `true` and runs WASM calls off the main thread. Set it
to `false` when you pass a `CallbackProver` from
`TransactionProver.newCallbackProver(jsFn)` (the worker boundary serializes the
prover and silently downgrades the callback variant to `"local"`), or when
embedding in a single-WebView native shell. `client.lastAuthError()` - which
returns the raw value your sign callback threw - is only meaningful with
`useWorker: false`.

There is no `debugMode` option. It was removed in 0.16 along with upstream
transaction debug mode.

### Observability

`ClientOptions.observer` is called once per underlying client operation with a
`MidenObservation` carrying `op`, `outcome` (`"ok"` / `"error"`) and
`durationMs`. The SDK never transports an observation and has no telemetry
dependency; a throwing observer can never fail an operation. `op` names the
wrapped client method, not the high-level call, so one `transactions.send(...)`
reports four observations (`executeTransaction`, `proveTransaction`,
`submitProvenTransaction`, `applyTransaction`). Registration is process-wide:
a second client constructed with an `observer` replaces the first one's.

```typescript
const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: (o) => console.log(o.op, o.outcome, Math.round(o.durationMs)),
});
```

`observeSensitive: true` adds a `sensitive` channel with the verbatim error
message and stack. It defaults to off, and when off the `sensitive` key is
**absent** rather than `undefined`, so `"sensitive" in observation`
distinguishes the two. Only the literal boolean `true` enables it, it is sealed
onto the client at construction, and it logs a one-time console warning. Ready
made bindings live in `@miden-sdk/telemetry-sentry` (`createSentryObserver`)
and `@miden-sdk/telemetry-otel` (`createOtelObserver`); both require
`includeSensitive: true` a second time before they forward that channel.

### Lazy / SSR-safe init

Some bundles (Next.js, Capacitor, raw `/lazy` entry) cannot await WASM at
import time. Use `MidenClient.ready()` to wait for WASM in-band - it is
idempotent and shared across callers:

```typescript
await MidenClient.ready();
const client = await MidenClient.createTestnet();
```

### Termination

```typescript
client.terminate(); // free WASM resources, close the store handle
```

After `terminate()`, every method throws - guard against late callbacks on
unmount.

## Sync - Always Sync First

The client's view of the chain is only as fresh as its last sync. **Always
call `sync()` before reading account state or building a transaction that
depends on freshly received notes.**

```typescript
const summary = await client.sync(); // returns SyncSummary
const height = await client.getSyncHeight(); // current local block number
```

`sync()` fetches private notes from the note-transport layer and then syncs
on-chain state, failing fast on either. The halves are separately available as
`client.syncChain()` (chain only) and `client.syncNoteTransport()` (transport
only).

Common patterns:

- Sync before consuming notes (notes must be committed on-chain)
- Sync after submitting a transaction to observe the result
- Pass `waitForConfirmation: true` to a `transactions.send/mint/consume/swap`
  call to let the SDK wait for the tx commit instead of polling manually
- Use `client.waitForIdle()` to flush all queued WASM calls before doing a
  side-effect that must not race with a kernel callback (e.g. clearing an
  in-memory unlock token after a wallet "lock")

`autoSync: true` (default for `createTestnet`/`createDevnet`) only triggers a
single sync at construction time - it is not a polling loop. Use the React
SDK's `useSyncState` or `MidenProvider` `autoSyncInterval` for periodic sync.

## Type Conversions

Type confusion across the WASM boundary is the leading source of bugs.

### `AccountId`

```typescript
const id = AccountId.fromHex("0xabc123..."); // throws on invalid hex
const id = Address.fromBech32("mtst1abc...").accountId();
const hex = id.toString(); // "0x..."
```

Pass `AccountId` (or any account ref the resource accepts: a hex/bech32
`string`, `Account`, `AccountHeader`, or `AccountId`) to resource methods -
never raw strings to methods that ask for `AccountId` directly. Note that an
`Address` object is **not** an account ref: `AccountRef = string | Account | AccountHeader | AccountId`, and the resolver only special-cases objects with an
`.id()` method (`Address` exposes `accountId()`, not `id()`), so call
`address.accountId()` first.

`AccountId.fromHex` throws on malformed input; wrap in `try/catch` when
accepting user input.

### Amounts - Always `BigInt`

```typescript
BigInt(1000);
1000n; // numeric literal
BigInt("1000");
```

Amount fields accept `number | bigint` (`SendOptions`/`MintOptions.amount`,
`FaucetOptions.maxSupply`) and are coerced internally with `BigInt(...)`, so
an integer `number` works and does **not** throw. The hazard is pre-conversion
precision loss: a numeric literal above `Number.MAX_SAFE_INTEGER` (2^53) loses
precision before it ever reaches `BigInt()`. Use `bigint` for any value that
might exceed 2^53.

### Visibility & Account Types

```typescript
import {
  NoteVisibility,
  AccountType,
  AuthScheme,
  StorageMode,
} from "@miden-sdk/miden-sdk";

NoteVisibility.Public; // "public"
NoteVisibility.Private; // "private"

// AccountType is a faucet-kind selector with ONLY two members:
AccountType.FungibleFaucet; // 0
AccountType.NonFungibleFaucet; // 1

AuthScheme.Falcon; // default - Falcon-512 over Poseidon2
AuthScheme.ECDSA; // EcdsaK256Keccak

StorageMode.Public;
StorageMode.Private;
```

Use `NoteVisibility` strings with the high-level resource APIs - `NoteType` is a
separate enum exported for the low-level WASM APIs and is easy to confuse with
`NoteVisibility`, so do not pass it where a `NoteVisibility` is expected. Use
`AuthScheme.Falcon` for the Poseidon2-based Falcon-512 scheme.

`AccountType` exposes **only** `FungibleFaucet`/`NonFungibleFaucet`. There is no
`MutableWallet`/`ImmutableWallet`/`MutableContract`/`ImmutableContract` member -
those evaluate to `undefined`. Wallets and contracts are not chosen via
`AccountType`: a wallet is the default (omit `type`), and a contract is any
`accounts.create()` call that passes `components` (or `type: "MutableContract"`/`"ImmutableContract"` as strings). See "Account Creation".

`StorageMode` has only `Public`/`Private`. There is no `StorageMode.Network`
(accessing it yields `undefined`, which silently resolves to private).

## Account Creation

```typescript
// Wallet - the default when no `type` is given (private, Falcon)
const wallet = await client.accounts.create();

// Wallet with explicit options - omit `type` (there is no
// AccountType.*Wallet member; passing one would be undefined -> default wallet)
const wallet = await client.accounts.create({
  storage: "private",
  auth: AuthScheme.Falcon,
});

// Faucet - selected via AccountType.FungibleFaucet / NonFungibleFaucet
const faucet = await client.accounts.create({
  type: AccountType.FungibleFaucet,
  storage: "public",
  symbol: "DAG",
  decimals: 8,
  maxSupply: 10_000_000n,
});

// Custom contract - selected by passing `components` (NOT by an AccountType
// member). Requires seed and an AuthSecretKey.
const component = await client.compile.component({
  code: contractMasm,
  slots: [],
});
const contract = await client.accounts.create({
  seed: new Uint8Array(32),
  auth: secretKey, // AuthSecretKey, not the AuthScheme enum
  components: [component], // presence of `components` routes to a contract
});
```

A contract is whatever `accounts.create()` call carries `components` - the
string forms `type: "MutableContract"` / `"ImmutableContract"` also route to a
contract, but the canonical selector is `components`, and an empty
`components` array is rejected. There is **no** `AccountType.MutableContract`;
`type: AccountType.MutableContract` is `undefined` and, without `components`,
would silently create a wallet.

### Standard auth components

Two auth components must come from the SDK rather than from your own MASM,
because the client identifies an auth component by its procedure root and
declines to attach fee conversion info to one it cannot classify:

- `createAuthGuardedMultisig(config)` builds the standard guarded multisig,
  statically linked exactly as the Rust client builds it. Configure it with
  `new AuthGuardedMultisigConfig(approvers, defaultThreshold, guardian, authScheme)`
  (optionally `.withProcThresholds([...])`). Compiling equivalent MASM through
  `AccountComponent.compile` links the standards package dynamically, yields a
  different `auth_tx` root, and every transaction from the account then fails
  on a fee-charging chain.
- `AccountComponent.createNetworkAuthComponents(allowedNoteScriptFees, feeFaucetId, allowedTxScriptRoots?)`
  builds a network account's auth. Each `new NoteScriptFee(noteScript.root(), amount)`
  pairs an allowlisted note script root with the fee the account charges to
  consume notes running it (zero is valid). It returns an **array**; add every
  element to the builder:

  ```typescript
  const components = AccountComponent.createNetworkAuthComponents(
    [new NoteScriptFee(noteScript.root(), 0n)],
    feeFaucetId
  );
  const builder = new AccountBuilder(seed)
    .storageMode(AccountStorageMode.public())
    .withComponent(myComponent);
  for (const component of components) builder.withComponent(component);
  ```

  The older `AccountComponent.createNetworkAuth` no longer exists.

## Fees

Since protocol 0.16 the verification fee is paid inside the account's auth
procedure, which reads it from the transaction's auth argument. Fees settle in
the chain's native fee asset at rate 1/1, so there is nothing for a caller to
convert - `miden-client` builds and commits the conversion info. The one thing
it will not invent is the salt the commitment is made under, because every
multisig flavour reuses that salt as its transaction summary's replay guard.

Every `client.transactions` operation that builds its own request already
declares a salt. The paths that take a **request from you** do not:
`submit`, `executeRequest`, `submitBatch`, and the `custom` operation of
`batch` / `preview`. For those, build the request from
`client.feeAwareTransactionRequestBuilder(account)` instead of a bare
`new TransactionRequestBuilder()`:

```typescript
const builder = await client.feeAwareTransactionRequestBuilder(wallet);
const request = builder.withCustomScript(script).build();
await client.transactions.submit(wallet, request);
```

`account` is the account that **executes** the request, not the recipient. The
method is a safe drop-in: on a zero-fee chain, or for a single-sig, no-auth or
network account, the builder comes back untouched and the request is
byte-identical to one from a bare builder.

What happens if you skip it:

- Multisig / smart multisig / guarded multisig: `FeeConversionInfoRequired`,
  naming the component.
- A custom auth procedure that reads conversion info: the transaction aborts in
  the VM with `ERR_FEE_CONVERSION_INFO_MISSING`. Attach the commitment yourself
  with `TransactionRequestBuilder.withAuthArg` plus `extendAdviceMap`.

`withAuthArg` and `withFeeConversionSalt` are mutually exclusive - each setter
clears the other, so whichever is called last wins.

## Transactions

The transactions API is option-bag-based and accepts any account ref
(`Account`, `AccountHeader`, hex string, `AccountId`).

### Send

```typescript
const { txId } = await client.transactions.send({
  account: wallet, // sender
  to: "0xrecipient...", // any account ref
  token: faucet, // faucet account ref - identifies the asset
  amount: 100n,
  type: NoteVisibility.Public, // optional, but defaults to "public" - see note below
  reclaimAfter: 100, // optional - sender can reclaim after this block
  timelockUntil: 50, // optional - recipient can consume after this block
  waitForConfirmation: true,
  timeout: 30_000,
});
```

**`type` defaults to PUBLIC, not private** - for both `send` and `mint`, the
note-type resolver treats an omitted/`undefined` `type` as
`NoteVisibility.Public`. Omitting `type` therefore creates a **public** note (a
privacy hazard). Always pass `type: NoteVisibility.Private` explicitly when a
private note is required.

For private sends where you also need to deliver the note out-of-band, set
`returnNote: true` and the call returns the constructed `Note` object -
incompatible with `reclaimAfter`/`timelockUntil`.

```typescript
const { txId, note } = await client.transactions.send({
  account: wallet,
  to: "mtst1...", // account ref: hex/bech32 string, Account,
  // AccountHeader, or AccountId (not an Address)
  token: faucet,
  amount: 100n,
  type: NoteVisibility.Private,
  returnNote: true,
});

// Stream the note via the note-transport service. For one of this client's own
// output notes prefer sendPrivateOutput, which derives the scan block for you.
await client.notes.sendPrivateOutput({ noteId: note.id(), to: "mtst1..." });
```

### Mint

```typescript
const { txId } = await client.transactions.mint({
  account: faucet, // faucet executes the mint
  to: targetAccountId, // recipient
  amount: 1000n,
  type: NoteVisibility.Public,
  waitForConfirmation: true,
});
```

The transaction executes on the **faucet** - a frequent bug is passing the
recipient as `account`. On a fee-charging chain the faucet pays the fee from
its own vault, so fund it first.

### Consume

```typescript
// Specific notes
await client.transactions.consume({
  account: wallet,
  notes: [noteId1, noteRecord, "0xnote..."], // any of: hex, NoteId, InputNoteRecord, Note
  waitForConfirmation: true,
});

// Drain everything consumable for the account
const { txId, consumed, remaining } = await client.transactions.consumeAll({
  account: wallet,
  maxNotes: 50, // optional cap
});
```

Both pass the consuming account through for you. If you build the request
yourself, `newConsumeTransactionRequest` is now **async and takes the consuming
account as a second argument**: `await inner.newConsumeTransactionRequest(notes, accountId)`.
The account is what decides whether fee conversion info is attached, so there
is no safe default. `newPswapConsumeTransactionRequest` and
`newPswapCancelTransactionRequest` became async for the same reason; their
parameters are unchanged, so adding `await` is the whole migration.

### Swap

```typescript
await client.transactions.swap({
  account: wallet,
  offer: { token: tokenA, amount: 100n }, // field is `offer`, not `offered`
  request: { token: tokenB, amount: 50n }, // field is `request`, not `requested`
  type: NoteVisibility.Public, // swap-note visibility
  paybackType: NoteVisibility.Private, // payback-note visibility
});
```

Partial swaps use `transactions.pswapCreate` / `pswapConsume` / `pswapCancel`,
and `client.pswap` reads the resulting lineages: `lineages()`,
`lineagesFor(account)`, `lineage(orderId)` (the order id is `u64`-shaped, so
pass a decimal string or `bigint`, never a `number`), and
`cancelByOrder({ orderId })`. `cancelByOrder` is the one path that cannot
declare a fee conversion salt, so cancel a **multisig** creator's order with
`transactions.pswapCancel` instead.

### Execute (custom scripts)

```typescript
const script = await client.compile.txScript({
  code: scriptMasm,
  libraries: [{ namespace: "my::lib", code: libMasm, linking: "dynamic" }],
});

await client.transactions.execute({
  account: contract,
  script,
  foreignAccounts: [
    publicAccountId, // fetched from the network at execution time
    { id: otherPublicId, storage: storageRequirements }, // same, plus storage requirements
  ],
  waitForConfirmation: true,
});
```

**Every entry in `foreignAccounts` is built as a _public_ foreign account.**
The resource maps both the bare-ref form and the `{ id, storage }` wrapper
through `ForeignAccount.public(...)`, which rejects a non-public account id with
`InvalidForeignAccountId`. The wrapper supplies storage requirements; it does
not make the account private. For a private foreign account, or for prefetched
state, build the request yourself (see below) and submit it with
`transactions.submit`. The same applies to `transactions.executeProgram`.

### Foreign accounts (FPI)

`ForeignAccount` has three constructors:

- `ForeignAccount.public(accountId, storageRequirements)` - state is fetched
  from the network at execution time.
- `ForeignAccount.private(account)` - you supply the account's state; only its
  inclusion proof is fetched.
- `ForeignAccount.prefetched(accountInputs)` - nothing is fetched at all.

Fetch the inputs up front with
`client.transactions.foreignAccountInputs(accounts, blockNum)`, which returns
an `AccountInputs[]` in the order given. Each witness opens against the account
tree of `blockNum` alone, so the results are valid only for a transaction whose
reference block is exactly `blockNum` (the anchor's block when executing against
a `ChainAnchor`, the sync height otherwise). Do not sync between fetching and
executing. `AccountInputs.serialize()` / `AccountInputs.deserialize(bytes)`
ships prefetched state to another client.

```typescript
const foreign = ForeignAccount.public(foreignAccountId, storageRequirements);
const blockNum = await client.getSyncHeight();
const [inputs] = await client.transactions.foreignAccountInputs(
  [foreign],
  blockNum
);

const builder = await client.feeAwareTransactionRequestBuilder(account);
const request = builder
  .withCustomScript(script)
  .withForeignAccounts(new ForeignAccountArray([ForeignAccount.prefetched(inputs)]))
  .build();
await client.transactions.submit(account, request);
```

Only the accounts you name are fetched; this does not discover accounts the
transaction loads on its own, such as faucets whose asset callbacks it triggers.

### Multi-party requests

When several clients must execute the *same* request and agree on the resulting
`TransactionSummary`, pin the parts that would otherwise be re-derived:

- `TransactionRequestBuilder.withExplicitInputNote(note, args?)` pins whether
  each input note is consumed authenticated or unauthenticated, in the mode its
  `InputNote` carries. Repeated calls add more notes, and the note stays usable
  by the caller. `withInputNotes` leaves that choice to each executor.
- Prefetched foreign-account inputs (above) pin the foreign state.
- A `ChainAnchor` pins the reference block - see the `chain-anchored-execution`
  skill.

### Preview (dry run)

`transactions.preview({ operation, ... })` runs the same kernel as the real
call without proving or submitting. `operation` is one of `"send"`, `"mint"`,
`"bridge"`, `"consume"`, `"swap"`, `"pswapCreate"`, `"pswapConsume"`,
`"pswapCancel"`, `"custom"`.

**It is not a general confirmation-screen helper.** The summary only exists
while authorization is pending - it is returned when the account's auth
procedure aborts with the unauthorized event (a multisig below its signing
threshold, for example), which is the payload out-of-band signing flows need. If
the transaction is already fully authorized it executes successfully, produces
no summary, and the call **rejects** with an error carrying
`code: "TRANSACTION_ALREADY_AUTHORIZED"` (on Node.js the code prefixes the
message). Submit it with `transactions.execute` / `submit` instead.

To collect signatures and submit afterwards, preview with `operation: "custom"`
and pass the **same** `TransactionRequest` object to both calls. Every other
operation rebuilds its request from the options, and two builds are not
identical: output-note serial numbers and the fee conversion salt are drawn from
the client's RNG, so the summary you signed would not be the one the submitted
transaction produces. Only `"custom"` accepts an `anchor`.

`TransactionSummary` exposes `userParams()` (seven caller-defined field
elements; this replaces the removed `salt()`, and the protocol assigns them no
meaning), `blockCommitment()`, `expirationDelta()` and `toCommitment()`. Its
`accountDelta()` is still **relative**, unlike the absolute
`ExecutedTransaction.accountPatch()` below.

### Reading output notes

**`outputNotes()` includes the kernel's fee note** on any chain whose
verification base fee is non-zero, so a transaction that created one note
returns two. Nothing throws; the list is simply longer, which makes this the
change most likely to pass unnoticed.

- `ExecutedTransaction` (returned at execution time) offers the split directly:
  `userOutputNotes()` is the list without the fee note, `feeNote()` is the fee
  note alone (or `undefined`).
- `TransactionRecord` and `TransactionSummary` have **no** split accessor. A
  record is read back from the store and the fee script root is not exposed to
  JS, so if you read `outputNotes()` on either, account for the extra note
  yourself.

`ExecutedTransaction.accountPatch()` and `TransactionStoreUpdate.accountPatch()`
replaced `accountDelta()` and return the absolute-valued `AccountPatch` /
`AccountStoragePatch` / `AccountVaultPatch` models.

### Listing transactions

```typescript
await client.transactions.list(); // every stored transaction
await client.transactions.list({ status: "uncommitted" });
await client.transactions.list({ ids: [txId, "0xabc..."] });
```

`TransactionFilter.expiredBefore()` and the `{ expiredBefore }` query were
removed - expiry is now decided during state sync.
`transactions.list({ expiredBefore })` **throws** rather than silently falling
back to the unfiltered query. Use `{ status: "uncommitted" }` and compare
`TransactionRecord.expirationBlockNum()` against the height you care about.

## Notes

```typescript
await client.notes.list(); // all input notes
await client.notes.list({ status: "committed" }); // "consumed" | "committed" | "expected" | "processing" | "unverified"
await client.notes.list({ scriptRoots: [noteScript.root()] }); // hex strings or Word instances
await client.notes.get(noteId); // single record
await client.notes.listSent(); // output notes
await client.notes.listAvailable({ account: wallet }); // consumable for an account

// Import/export
await client.notes.import(noteFile);
const file = await client.notes.export(noteId);
```

`{ scriptRoots }` narrows at the store level, without loading and screening
unrelated notes. It is a received-note filter: `listSent` returns an empty list
for it.

### Private-note transport

```typescript
// Fetches incrementally from the stored pagination cursor. Historical notes for
// a newly tracked tag sit below that cursor and are back-filled by sync().
await client.notes.fetchPrivate();

// Relay one of this client's own output notes - the scan block is derived from
// the note's stored expected height. Prefer this form.
await client.notes.sendPrivateOutput({ noteId, to: "mtst1..." });

// Agnostic form for an arbitrary note. `scanAfterBlockNum` is REQUIRED.
await client.notes.sendPrivate({
  note,
  to: "mtst1...",
  scanAfterBlockNum: submissionHeight,
});
```

`sendPrivate` **throws** without an integer `scanAfterBlockNum`. It is the block
the recipient scans **forward** from for the note's on-chain commitment, so it
must be at or below the commitment block: a hint above it is never scanned back
to and the recipient silently never receives the note. A safe choice is the
chain tip when the note's transaction was submitted - which is exactly why
relaying *after* waiting for the commit used to drop delivery. `to` accepts a
bech32 string, a 0x-hex string, an `Account`, or an `AccountId`; it does **not**
accept a pre-parsed `Address` object.

`fetchPrivate()` takes no arguments. The `{ mode: "all" }` full re-scan was
removed; after adding a tag, just `sync()`.

## Accounts (querying)

```typescript
await client.accounts.list(); // tracked accounts
await client.accounts.get(ref); // single (returns null if not tracked)
await client.accounts.getOrImport(ref); // tries get(), falls back to import()
await client.accounts.getDetails(ref); // { account, vault, storage, code, keys }
await client.accounts.insert({ account, overwrite }); // start tracking an existing account
await client.accounts.getBalance(account, token); // single-asset balance, returns bigint
await client.accounts.addAddress(ref, address); // track / untrack an address
await client.accounts.removeAddress(ref, address);
```

`getDetails(ref)` returns `{ account, vault, storage, code, keys }` - the full
`Account`, its `AssetVault`, `AccountStorage`, `AccountCode | null`, and the key
commitments (`Word[]`); there is no `status` field. It throws if the account is
not tracked.

For a single asset balance without loading the full vault, prefer
`client.accounts.getBalance(account, token)` (returns `bigint`). It wraps the
WASM client's `accountReader(id)` lazy reader, which lives on the low-level
client: reach it through `client._withInnerWebClient(async (inner) => inner.accountReader(id))`,
not through the private `#inner` field.

## Keystore

```typescript
await client.keystore.insert(accountId, secretKey);
await client.keystore.get(pubKeyCommitment);
await client.keystore.remove(pubKeyCommitment);
await client.keystore.getCommitments(accountId);
await client.keystore.getAccountId(pubKeyCommitment);
```

`keystore.insert` is the single call that both stores the key and registers
its commitment with the account.

## Compile

```typescript
await client.compile.component({
  code,
  namespace,
  slots,
  supportAllTypes: true,
});
await client.compile.txScript({ code, libraries });
await client.compile.noteScript({ code, libraries });
```

`namespace` on `component()` is the module path procedure identities are derived
from; use the same namespace when linking that component into a script.

`libraries` entries take three forms:

- `{ namespace, code, linking? }` - built and linked inline.
- `{ component, linking? }` - links the **exact** code an `AccountComponent`
  installed. Use this when a script calls procedures installed on an account, so
  procedure identities match.
- a pre-built `Library` object, linked dynamically.

`linking` is `"dynamic"` (default) or `"static"`.

### MASM shape

The annotations are not optional and changed in 0.16:

```masm
// Account component procedure
@account_procedure
pub proc increment_count
  ...
end

// Transaction script
use miden::core::sys
@transaction_script
pub proc main
  exec.sys::truncate_stack
end

// Note script - a MASM library with a single @note_script procedure,
// not a begin/end program
use miden::core::sys
@note_script
pub proc main
  exec.sys::truncate_stack
end
```

`basic_wallet::add_assets_to_account` was renamed to
`basic_wallet::move_note_assets_to_account`; a script still using the old name
fails to compile with `undefined item 'add_assets_to_account'`.

## Common Workflows

### Mint and consume (fund a fresh wallet)

```typescript
const wallet = await client.accounts.create();
const faucet = await client.accounts.create({
  type: AccountType.FungibleFaucet,
  storage: "public",
  symbol: "TEST",
  decimals: 8,
  maxSupply: 1_000_000n,
});

await client.transactions.mint({
  account: faucet,
  to: wallet,
  amount: 10_000n,
  type: NoteVisibility.Public,
  waitForConfirmation: true,
});

await client.sync();
await client.transactions.consumeAll({
  account: wallet,
  waitForConfirmation: true,
});
```

### Wait for an external transfer

```typescript
await client.sync();
const before = (await client.notes.listAvailable({ account: wallet })).length;

while (true) {
  await new Promise((r) => setTimeout(r, 3000));
  await client.sync();
  const now = (await client.notes.listAvailable({ account: wallet })).length;
  if (now > before) break;
}
```

## Common Pitfalls

1. **Forgetting to sync.** Notes won't appear, balances will be stale, foreign
   accounts will be at the wrong block.
2. **Indexing `outputNotes()[0]`.** On a fee-charging chain the list carries the
   kernel's fee note too. Use `ExecutedTransaction.userOutputNotes()`, or filter
   it yourself on a `TransactionRecord` / `TransactionSummary`, which have no
   split accessor.
3. **Building a request from a bare `TransactionRequestBuilder`.** Use
   `client.feeAwareTransactionRequestBuilder(account)` for anything you hand to
   `submit` / `executeRequest` / `submitBatch` / a `custom` preview, or a
   multisig account fails with `FeeConversionInfoRequired`.
4. **`notes.sendPrivate()` without `scanAfterBlockNum`.** It throws. Prefer
   `notes.sendPrivateOutput({ noteId, to })` for your own output notes, and
   never pass a hint above the commitment block.
5. **`number` literals above 2^53 for amounts.** Amount fields accept
   `number | bigint` and coerce via `BigInt()` (no `TypeError`), but a numeric
   literal above `Number.MAX_SAFE_INTEGER` loses precision _before_ coercion.
   Use `bigint` for large amounts.
6. **Omitting `type` and expecting a private note.** `send`/`mint` default
   `type` to **public** - pass `NoteVisibility.Private` explicitly for privacy.
7. **Expecting `transactions.preview` to summarize a valid transaction.** It
   rejects with `TRANSACTION_ALREADY_AUTHORIZED` unless authorization is pending.
8. **Passing a private account id in `execute({ foreignAccounts })`.** Every
   entry becomes a public foreign account; build the request yourself with
   `ForeignAccount.private` / `.prefetched`.
9. **`transactions.list({ expiredBefore })`.** The filter was removed and the
   query now throws. Use `{ status: "uncommitted" }`.
10. **Passing a low-level `AccountId`-only WASM method a raw string** - resource
    methods accept hex/bech32 strings, but pre-parse with `AccountId.fromHex()`
    (and catch its throw) when calling APIs that demand an `AccountId` directly.
11. **Consuming notes before they're committed** - sync first, check status.
12. **Submitting `mint` with the recipient as `account`** - mint executes on
    the faucet account, not the target.
13. **Private notes without transport** - must call `notes.sendPrivateOutput()`
    / `notes.sendPrivate()` (or pass `returnNote: true` to `transactions.send`
    and deliver out-of-band).
14. **Holding WASM-owned objects across `terminate()`** - every `Account`,
    `Note`, `AccountId`, `NoteAndArgsArray` etc. owns Rust memory through the
    WASM ArrayBuffer. After `terminate()` they panic with "null pointer
    passed to rust" - drop references on unmount.
15. **Calling `accountReader(...)` in parallel with a write** - the readers
    share the WASM client. Wrap concurrent flows with `client.waitForIdle()`
    or rely on the React SDK's `runExclusive`.
16. **Assuming `TransactionProver.newLocalProver()` is cheap.** It now produces
    Poseidon2 proofs, matching the client's default prover, and is roughly
    1.6-2.6x slower than the old Blake3 default.
