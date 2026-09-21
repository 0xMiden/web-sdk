---
name: web-client-usage
description: Conventions for writing JavaScript/TypeScript code that uses the Miden web SDK (`@miden-sdk/miden-sdk`). Use when building apps on Miden, writing integration tests, or calling MidenClient methods - covers initialization, the resource-based API (accounts, transactions, notes, tags, settings, compile, keystore, pswap), sync ordering, type conversions, transaction flows, fees, batching, named storage slots, custom contracts, foreign accounts, private note transport, mock-chain testing, observability, and pitfalls.
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
| `client.transactions` | `send` / `mint` / `bridge` / `consume` / `consumeAll` / `swap` / `pswapCreate` / `pswapConsume` / `pswapCancel` / `createNetworkNote` / `execute` / `executeProgram` / `batch` / `submitBatch` / `preview` / `captureAnchor` / `executeRequest` / `submit` / `submitProven` / `list` / `waitFor` |
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

**You must hold your own mutex around this.** The call chain serializes the
callback against external callers, but it does not make the callback atomic.
While `fn` runs, the client's re-entrancy depth is raised so that calls made
*by* `fn` run inline instead of queueing - that is what stops `fn` deadlocking
against itself. The consequence is the trap: if an unrelated task runs during
one of `fn`'s `await`s and calls into the SDK, it also sees a raised depth,
also runs inline, and races wasm-bindgen's borrow check. The chain will not
save you there; only your own mutex around the whole `_withInnerWebClient`
call will.

Do not let the `inner` reference escape the callback either - it is only valid
for the duration of `fn`.

It is marked `@internal`: pin the SDK version if you depend on it, and re-test
the low-level surface on every upgrade.

## Client Initialization

### Convenience constructors (recommended)

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

// Testnet - autoSync on, testnet RPC + prover + note transport
const client = await MidenClient.createTestnet({ feeFaucetId: FEE_FAUCET });

// Devnet equivalent
const client = await MidenClient.createDevnet({ feeFaucetId: FEE_FAUCET });
```

`feeFaucetId` is not optional today, on any constructor but `createMock`. Since
0.17 the chain's fee asset lives in a protocol configuration the node does not
serve over RPC, and the SDK carries a per-network default for no network yet, so
a client created without it fails with an error naming the option. It is the
faucet the chain mints its fee asset from: ask whoever runs the network, or read
it from a local node's genesis. Snippets below leave it out to keep their own
point legible.

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
  feeFaucetId: FEE_FAUCET, // required - the chain's fee faucet, bech32 or hex
  noteTransportUrl: "https://transport.miden.io",
  storeName: "my-store",
  seed: new Uint8Array(32), // optional - string or Uint8Array; see below
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

`seed` is `string | Uint8Array`. A string is legal: `hashSeed()` SHA-256s it to
32 bytes before it reaches WASM, and a `Uint8Array` passes through unchanged.
The same two forms work for `MidenClient.createMock({ seed })` and for the
wallet path of `accounts.create({ seed })`. The **contract** path of
`accounts.create` is the exception - its seed goes straight into
`new AccountBuilder(seed)`, so it must be a raw 32-byte `Uint8Array`.

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
reports five observations (`newSendTransactionRequest`, `executeTransaction`,
`proveTransaction`, `submitProvenTransaction`, `applyTransaction`) - the request
is built through the client too. Registration is process-wide: a second client
constructed with an `observer` replaces the first one's. `skills/observability/`
has the full contract, the exclusions and the two shipped bindings.

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

### Testing without a node

`MidenClient.createMock()` builds a client backed by an in-process mock chain,
so a test suite needs no node, no faucet and no block time:

```typescript
const client = await MidenClient.createMock({ seed, serializedMockChain });
await client.proveBlock(); // advance the mock chain by one block
const dump = await client.serializeMockChain(); // snapshot for restore
client.usesMockChain(); // boolean - true only for a mock client
```

`serializedMockChain` restores a previous `serializeMockChain()` dump;
`serializedNoteTransport` does the same for the mock note-transport node
(`serializeMockNoteTransportNode()`). `proveBlock`, `serializeMockChain` and
`serializeMockNoteTransportNode` throw on a non-mock client.

### Termination

```typescript
client.terminate(); // free WASM resources, close the store handle
```

After `terminate()`, nearly every method throws `Client terminated` - guard
against late callbacks on unmount. The exceptions are `usesMockChain()`, the
`defaultProver` getter and `terminate()` itself, which is idempotent.
`MidenClient` also implements `[Symbol.dispose]` and `[Symbol.asyncDispose]`,
both of which just call `terminate()`, so `using client = ...` works.

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

**`storage` defaults per kind, not globally**: a wallet defaults to `private`, a
faucet and a contract to `public`. Pass `storage` explicitly whenever the
visibility matters.

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
  consume notes running it (zero is valid). `feeFaucetId` must be the chain's
  own fee faucet, `client.feeFaucetId()`: the node never runs network
  transactions for an account whose fee asset differs from the chain's protocol
  configuration, and the client is not told - the notes just sit unconsumed.
  It returns an **array**; add every element to the builder:

  ```typescript
  const feeFaucetId = await client.feeFaucetId();
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
method is a safe drop-in: for a single-sig, no-auth or network account the
builder comes back untouched and the request is byte-identical to one from a
bare builder. A zero base fee is not a second condition: since 0.17 a multisig
resolves its auth args whatever the chain charges, so a multisig gets them on a
fee-free chain too.

What happens if you skip it:

- Multisig / smart multisig / guarded multisig: `FeeConversionInfoRequired`,
  naming the component.
- A custom auth procedure that reads conversion info: the transaction aborts in
  the VM with `ERR_FEE_CONVERSION_INFO_MISSING`. Attach the commitment yourself
  with `TransactionRequestBuilder.withAuthArg` plus `extendAdviceMap`.

`withAuthArg` and `withFeeConversionSalt` are mutually exclusive - each setter
clears the other, so whichever is called last wins. Never call either on a builder from `feeAwareTransactionRequestBuilder` for a multisig: that builder already carries the three-word auth args, and either setter discards them, so the transaction aborts in the auth procedure. Pass `feeConversionSalt` to `feeAwareTransactionRequestBuilder` instead - and build a fresh `Word` for every call, because the parameter is moved across the WASM boundary and a spent handle arrives as "no salt given".

## Transactions

**A note carries at most 16 assets** (`MAX_ASSETS_PER_NOTE` in `miden-protocol`). The
constructors `unwrap` the protocol's `TooManyAssets` error, so going over the cap from
JavaScript **traps the WASM instance** rather than rejecting with a catchable error - check
the length yourself before building a note with many assets. Duplicates are rejected too,
and the order of assets is unspecified.

Per-asset callbacks are read off `FungibleAsset.callbacks()`. There is no `withCallbacks`
builder - do not reach for one.

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

### Bridge

`bridge` emits a single public B2AGG (Bridge-to-AggLayer) note that the bridge
account consumes, burning the asset so it can be claimed at the destination
address on the destination network.

```typescript
const { txId } = await client.transactions.bridge({
  account: wallet, // sender - the executing account
  bridgeAccount: bridgeAccountId, // consumes the note and burns the asset
  token: faucet, // faucet ref of the fungible asset to bridge
  amount: 100n,
  destinationNetwork: 1, // AggLayer-assigned network id
  destinationAddress: "0xabc...", // 0x-prefixed Ethereum hex
});
```

### Network notes

`transactions.createNetworkNote(options)` builds a **public** custom-script note
carrying a `NetworkAccountTarget` attachment, submits it as one of the sender's
output notes, and returns `{ txId, note, result }`. The attachment is what makes
`note.isNetworkNote()` true and what gets the note auto-consumed by a public
network account.

```typescript
const { note } = await client.transactions.createNetworkNote({
  account: wallet,
  target: networkAccountId, // an account ref, or a built NetworkAccountTarget
  script: noteScript, // or `recipient` - exactly one of the two
  inputs: [1n, 2n], // optional note storage the script reads
  assets: [asset], // optional - a network note may carry none
});
```

Provide **exactly one** of `recipient` (a pre-built `NoteRecipient`) or `script`
(a `NoteScript`, from which the recipient is built with a fresh serial number).
Passing both, or neither, throws a descriptive error naming the two fields.

`target` must genuinely be a network account: one built from
`AccountComponent.createNetworkAuthComponents(...)` (see "Standard auth
components") with the chain's fee faucet, already committed on-chain at the
transaction's reference block, whose allowlist prices the note's script root.
The fee faucet requirement fails silently: the note is emitted, and the node
simply never consumes it. The note is priced by calling
`estimate_note_fee` on the target even on a chain that charges no fees, so
targeting a plain wallet fails with
`account procedure ... is not in the account procedure index map`, and targeting
an account that has not been committed yet fails to resolve the account at all.

That pricing call also caps the transaction: `estimate_note_fee` applies the
standards' default expiration delta, so the emitting transaction must be
included within **20 blocks** of its reference block, roughly a minute at a
three-second block interval. An expiration can only be lowered, never raised,
so neither the SDK nor the caller can widen it. If proving is slow enough that
the node rejects the submission as expired, re-execute against a fresh
reference block and submit again.

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

`ConsumeAllResult.txId` is `TransactionId | null`: when the account has nothing
consumable, `consumeAll` submits no transaction and resolves to
`{ txId: null, consumed: 0, remaining: 0 }`. Check `txId` before dereferencing
it. (With `maxNotes: 0` it also returns a null `txId`, but `remaining` then
carries the full count.)

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

**`paybackType` falls back to `type`, not to public.** Both `swap` and
`pswapCreate` resolve it as `opts.paybackType ?? opts.type`, so a private swap
emits a private payback note unless you say otherwise. This is the one place the
note-type default differs from `send` / `mint`.

Partial swaps use `transactions.pswapCreate` / `pswapConsume` / `pswapCancel`,
and `client.pswap` reads the resulting lineages: `lineages()`,
`lineagesFor(account)`, `lineage(orderId)` (the order id is `u64`-shaped, so
pass a decimal string or `bigint`, never a `number`), and
`cancelByOrder({ orderId })`. `cancelByOrder` is the one path that cannot
declare a fee conversion salt, so cancel a **multisig** creator's order with
`transactions.pswapCancel` instead.

A `PswapLineageRecord` exposes `orderId()`, `status()`, `creator()`, `offered()`,
`requested()`, `filled()` and `remaining()`; `status()` is one of `Active`,
`FullyFilled` or `Reclaimed`. `cancelByOrder` throws **before submitting** in two
cases - when no lineage exists for the order, and when the lineage is already
terminal - so a failure there has cost you nothing on chain. Note that its read,
build and submit are three separate awaits with no lock across them, so a
concurrent fill can still land between them and the submit then fails on the
nullified note.

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
not make the account private. For a private foreign account, build the request
yourself (see below) and submit it with
`transactions.submit`. The same applies to `transactions.executeProgram`.

### Execute a program (read-only view call)

```typescript
const stack = await client.transactions.executeProgram({
  account: contract,
  script, // a compiled TransactionScript
  adviceInputs, // optional - defaults to empty
  foreignAccounts: [publicAccountId], // optional, same public-only rule as above
});
```

`executeProgram` runs the script against the account and returns a `FeltArray`
of the resulting stack. Nothing is proven, submitted or persisted, so this is
the call to reach for when you only want to read a value a MASM procedure
computes.

### Foreign accounts (FPI)

`ForeignAccount` has two constructors:

- `ForeignAccount.public(accountId, storageRequirements)` - state is fetched
  from the network at execution time.
- `ForeignAccount.private(account)` - you supply the account's state; only its
  inclusion proof is fetched.

The account's state and witness are read against the transaction's reference
block, and the vault entries and storage-map keys the foreign code touches are
resolved during execution as per-asset and per-key witnesses rather than up
front. Pin the transaction to a block the node still serves account state for;
prefetching the state to execute against an older block is no longer possible
(`foreignAccountInputs` and `ForeignAccount.prefetched` were removed in 0.17).

```typescript
const foreign = ForeignAccount.public(foreignAccountId, storageRequirements);

const builder = await client.feeAwareTransactionRequestBuilder(account);
const request = builder
  .withCustomScript(script)
  .withForeignAccounts(new ForeignAccountArray([foreign]))
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

### Staged transaction lifecycle

`transactions.submit(account, request, options?)` runs execute, prove, submit
and apply in one call. Split it when you want to time, retry or relocate a
single stage - proving in a `chrome.offscreen` document while the service worker
executes and submits, for example:

```typescript
const executed = await client.transactions.executeRequest(account, request);
const proven = await executed.prove({ prover });
const submitted = await proven.submit();
await submitted.apply();
```

- `executeRequest` returns a `TransactionExecution` (`.result`, `.id`,
  `.prove(options?)`). Nothing is proven, submitted or persisted yet. It takes
  an optional `anchor` to execute against a pinned reference block.
- `.prove()` returns a `TransactionProof` (`.proof`, `.result`, `.submit()`).
  Pure computation: it touches neither the network nor the local store, and
  `.proof` is the `ProvenTransaction` to ship elsewhere.
- `.submit()` returns a `TransactionSubmission` (`.blockNumber`, `.result`,
  `.apply()`, `.waitForConfirmation(options?)`). Submitting does **not** persist
  anything locally; until `.apply()` runs the store is unaware of the
  transaction and observers (PSWAP lineage tracking, for one) never fire.
- `submitProven(proof, result)` enters at the last stage with a proof produced
  somewhere that never saw this client's store.

**The stages are not atomic as a group.** Awaiting other mutating calls on the
same account between them can interleave state - drive the chain as an
uninterrupted sequence per account.

**A prover is consumed by `prove()`.** Build or clone a fresh
`TransactionProver` for each call. Passing an already-used one does not throw -
it silently falls back to the built-in local prover, so the symptom is a second
proof that runs locally (and slowly) when you configured a remote one.

### Batching

`transactions.batch` builds each operation itself; `submitBatch(account, requests, options?)`
is the pre-built-request counterpart. Both submit atomically - every transaction
in the batch lands or none does.

```typescript
const { blockNumber } = await client.transactions.batch({
  account: wallet,
  operations: [
    { kind: "consume", notes: [noteId] },
    { kind: "send", to: other, token: faucet, amount: 10n },
    { kind: "custom", request: prebuiltRequest },
  ],
  waitForConfirmation: true,
});
```

`BatchOperation` kinds are `send`, `mint`, `consume`, `swap`, `execute` and
`custom`; each mirrors the singular options **minus `account`**.

**V1 is single-account, and it rewrites every operation's account.** The builder
spreads `{ ...op, account: opts.account }` over each operation before building
it, so the batch-level account executes all of them. Mixing account roles does
not raise an error, it builds the wrong request: a `mint` inside a
wallet-scoped batch is rebuilt as if the wallet were the issuing faucet.
Minting on a faucet and spending from a wallet are two accounts, so they are two
calls.

The result is `{ blockNumber }` only - the Rust V1 batch API returns no
per-transaction ids, so `waitForConfirmation` polls local sync height until it
reaches that block rather than watching transaction status. A
`custom` operation carries a request you built, so the fee rules above apply to
it: use `client.feeAwareTransactionRequestBuilder(account)`. The V1 batch API
has no per-call prover override.

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

### Waiting for a transaction

```typescript
await client.transactions.waitFor(txId, {
  timeout: 60_000, // default; 0 polls indefinitely
  interval: 5_000, // default
  onProgress: (status) => {}, // "pending" | "submitted" | "committed"
});
```

`timeout` is wall clock in milliseconds, not a block count. The loop polls
`syncChain()` rather than `sync()`, so an unreachable note-transport endpoint
does not stall it, and a transient sync failure is swallowed and retried. It
throws on timeout, and throws `Transaction rejected: <id>` as soon as the
record comes back discarded. `waitForConfirmation: true` on any transaction
call runs this same loop.

## Notes

```typescript
await client.notes.list(); // all input notes
await client.notes.list({ status: "committed" }); // "consumed" | "committed" | "expected" | "processing" | "unverified"
await client.notes.list({ scriptRoots: [noteScript.root()] }); // hex strings or Word instances
await client.notes.get(noteId); // single record
await client.notes.listSent(); // output notes
await client.notes.listAvailable({ account: wallet }); // consumable for an account

// Import/export
const idHex = await client.notes.import(noteFile); // hex string, NOT a NoteId
const file = await client.notes.export(noteId);
```

`notes.import` resolves to a **hex string**, not a `NoteId`: the note id when
the file carries metadata, or the note's details commitment for a details-only
file that cannot have an id yet. Pass it to `NoteId.fromHex` when a `NoteId`
instance is required.

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

await client.accounts.import(ref); // by id - fetches state from the network
await client.accounts.import({ file }); // from an exported AccountFile
await client.accounts.import({ seed, auth }); // rebuild a PUBLIC account from its seed
const file = await client.accounts.export(ref); // AccountFile
```

`accounts.import` takes three shapes, all resolving to the `Account`: an account
ref imports by id, fetching state from the network; `{ file }` imports a
previously exported `AccountFile` and works for public and private accounts
alike; `{ seed, auth? }` reconstructs the account from its init seed. **The seed
path is public-only** - a private account's state cannot be re-derived from a
seed, so use the account-file workflow for those.

`getDetails(ref)` returns `{ account, vault, storage, code, keys }` - the full
`Account`, its `AssetVault`, a `StorageView`, `AccountCode | null`, and the key
commitments (`Word[]`); there is no `status` field. `storage` is **not** the raw
WASM `AccountStorage`: `Account.prototype.storage()` is patched at load time to
return a `StorageView`, whose `getItem(name)` resolves both Value and StorageMap
slots to a `StorageResult`. Reach the protocol-level `AccountStorage` through
`storage.raw` if you need it. It throws if the account is
not tracked.

For a single asset balance without loading the full vault, prefer
`client.accounts.getBalance(account, token)` (returns `bigint`). It wraps the
WASM client's `accountReader(id)` lazy reader, which lives on the low-level
client: reach it through `client._withInnerWebClient(async (inner) => inner.accountReader(id))`,
not through the private `#inner` field.

## Storage - slots are named, not indexed

`StorageSlot` constructors take a slot **name**, never an index. Each rejects an
invalid name with `invalid storage slot name: ...`:

```typescript
StorageSlot.fromValue(name, word);
StorageSlot.emptyValue(name);
StorageSlot.map(name, storageMap);
```

MASM declares the matching name as a word constant and reads through it:

```masm
use miden::protocol::active_account
use miden::core::word

const COUNTER_SLOT = word("miden::tutorials::counter")
...
push.COUNTER_SLOT[0..2] exec.active_account::get_item
```

Read state back through `StorageView`, which the SDK installs over
`Account.prototype.storage()` when WASM loads - so `account.storage()` returns
the wrapper, not the raw `AccountStorage`:

- `getItem(slotName)` - a `StorageResult`, for a value slot or a map slot alike
- `getMapItem(slotName, key)` / `getMapEntries(slotName)` - map reads
- `getCommitment(slotName)` - the slot's raw protocol value, which for a map
  slot is its Merkle root (useful for proving state did not change)
- `getSlotNames()` - every slot name on the account
- `commitment()` - the commitment to the whole storage
- `.raw` - the underlying `AccountStorage`, for anything the view does not wrap

`StorageResult` carries `.isMap`, `.entries` (lazily parsed, `undefined` for a
value slot), `.word`, `toFelts()`, `toU64s()`, `felt()`, `toBigInt()`,
`toHex()`, `toString()` and `toJSON()`.

**Use `toBigInt()` for exact u64 values.** `valueOf()` - what `+result`, `result * 2`
and any other arithmetic coercion call - throws a `RangeError` above
`Number.MAX_SAFE_INTEGER` rather than silently losing precision. `toString()`
and template interpolation are lossless, so `` `count: ${result}` `` is safe.

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

**`keystore.remove()` is not available on the browser/WASM path.** Every method
here forwards to a keystore handle on the inner client when one exists and falls
back to a WASM client method otherwise. `remove` is the one with no fallback, so
in the browser it throws `remove() is not supported on this platform`. The other
four work everywhere.

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
   `ForeignAccount.private`.
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
17. **Reusing a `TransactionProver` across `prove()` calls.** It is consumed by
    the first call; the second silently falls back to the built-in local prover
    instead of erroring. Build or clone a fresh one per call.
18. **Mixing account roles in one `batch()`.** V1 rewrites every operation's
    account to the batch-level one, so a `mint` alongside a wallet `send` builds
    the wrong request rather than failing. Split it into two calls.
19. **Dereferencing `consumeAll().txId` unconditionally.** It is `null`, with
    zero counts, when the account had nothing consumable.
