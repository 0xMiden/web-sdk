# @miden-sdk/miden-sdk - Agent Guide

**Audience: AI coding agents** writing application code against the Miden web
SDK. Humans are welcome to read it, but it is written to be loaded into an
agent's context and followed.

This file ships inside the published package. The copy at
`node_modules/@miden-sdk/miden-sdk/AGENTS.md` always matches the version you
have installed, so **prefer it over your training data**, which is likely to
describe an older API. Miden is pre-1.0 and the surface still moves between
minor versions.

## Load the right skill

Detailed, task-scoped guidance ships alongside this file in
`node_modules/@miden-sdk/miden-sdk/skills/`. Read the one that matches what you
are doing rather than guessing from the type signatures alone.

| Skill | Load it when |
|---|---|
| `skills/web-client-usage/SKILL.md` | Any code that calls `MidenClient` or `RpcClient` - initialization, the resource API, stateless queries and submission, sync ordering, type conversions, transaction flows, custom contracts, private note transport. |
| `skills/frontend-pitfalls/SKILL.md` | Before shipping. WASM initialization, concurrent access, cross-origin isolation, `BigInt` at the WASM boundary. These are the failures that survive code review and break in production. |
| `skills/signer-integration/SKILL.md` | Wiring an external signer (Para, Turnkey, a wallet adapter) or implementing a custom one. |
| `skills/chain-anchored-execution/SKILL.md` | Multisig proposals, offline co-signing - anything where one party signs a transaction summary and another executes it. Read before using `captureAnchor`, before re-executing a multisig proposal (0.17: at the tip, never at an anchor), or when co-signers' summary commitments never match. |
| `skills/observability/SKILL.md` | Wiring telemetry, tracing or metrics around the client - the `MidenObservation` contract, which operations are and are not observed, the opt-in sensitive channel, and the OpenTelemetry and Sentry bindings. Read it when an observation you expected never arrives, or when observation counts do not match your call counts. |
| `skills/frontend-source-guide/SKILL.md` | Anything the other skills don't cover - driving `WasmWebClient` directly, or troubleshooting SDK internals. Maps this repository's source so you can read the implementation instead of guessing. |

Building a React app? `@miden-sdk/react` wraps this client in hooks and ships
its own guide at `node_modules/@miden-sdk/react/AGENTS.md`. Prefer the hooks for
anything they cover; drop to this client only for what they don't.

Configuring the bundler? See `node_modules/@miden-sdk/vite-plugin/AGENTS.md`.

## The shape of the API

`MidenClient` is the main entry point. Construct it with a static factory -
never with `new` - and route work through its typed resources:

```ts
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.createTestnet();
await client.sync();
```

`create(options)` targets an explicit endpoint; `createTestnet()`,
`createDevnet()` and `createMainnet()` are preconfigured; `createMock(options)`
backs tests with an in-memory chain and no network (pass a distinct `storeName`
when running multiple same-origin browser mocks, as omitting it shares `mock_client_db`).

`feeFaucetId` is optional. Since 0.17 the chain's fee asset lives in the
protocol configuration, which the client receives from the node when it syncs,
so execution never needs the option: it only sets what `client.feeFaucetId()`
reports before the first sync. Before that sync, a client created without it
rejects `feeFaucetId()` and asks you to sync first; a mock client reports its
mock chain's own faucet.

`client.protocolConfig()` returns that configuration as a `ProtocolConfig`: its
`feeFaucetId()` is the faucet `client.feeFaucetId()` reports after a sync, and
its `commitment()` is what block headers carry as `protocolConfigCommitment()`.
It rejects with "the network's protocol configuration is not known yet" until
the first sync stores the configuration; a mock client is seeded with its
chain's.

On testnet and devnet, `accounts.requestFundingNote(account, options?)` and
`accounts.fundAccount(account, options?)` request the native fee asset from the
public faucet. `requestFundingNote` returns the faucet receipt
`{ noteId, transactionId, faucetId, amount }`; `fundAccount` also waits for the
public P2ID note, consumes it, and returns `{ noteId, transactionId, balance }`.
Defaults come from the RPC endpoint;
other networks need `faucetUrl`. The mint request is never retried: after a
failure that retains a `noteId`, resume that note instead of calling the faucet
again. See `docs/external/src/web-client/library/funding.md`.

State is split across resources rather than living on the client:
`accounts`, `transactions`, `notes`, `tags`, `chain`, `settings`, `keystore`, `compile`,
`pswap` and `contracts`. Client-level methods cover the lifecycle around them - `sync`,
`syncChain`, `syncNoteTransport`, `getSyncHeight`, `waitForIdle` and
`terminate`.

`client.checkHealth()` resolves to `{ reachable: true, version, chainTip,
genesisCommitment?, blockProducer? }` or `{ reachable: false, error }` and never
rejects for a node problem, so do not wrap it in `try`.
`client.monitorHealth({ intervalMs, onChange })` (`intervalMs` at most
2147483647) calls `onChange` with the first
result and then only when reachability or the block producer's `status` changes,
and returns `stop()`; `terminate()` stops it as well.

For an application that manages its own state, construct `RpcClient` directly:

```ts
import { Endpoint, RpcClient } from "@miden-sdk/miden-sdk";

const rpc = new RpcClient(Endpoint.testnet());
const updates = await rpc.syncNullifiers(new Uint16Array([0x1234]), 100, 200);
```

`syncNullifiers` copies prefixes before asynchronous work and scans duplicate
prefixes once without changing the input array. On Node.js, use an
`ArrayBuffer`-backed `Uint16Array`; shared backing memory is rejected during
argument conversion.

The block range is inclusive; results are prefix matches, exposed as
`NullifierUpdate` objects with `nullifier()` and `blockNum()`. Filter by the full
nullifier yourself and keep the upper bound at or below the node's chain tip.
This client opens no local store.

To find included transactions, call
`rpc.syncTransactions(blockFrom, blockTo, accountIds)`. It returns every matching
`RpcTransactionRecord` across all pages and account chunks, with `id()`,
`accountId()` and `blockNum()` accessors. Both bounds are inclusive; a reversed
range rejects and an empty account list returns `[]`. Duplicate account IDs are
scanned once. Keep `blockTo` at or below the node's tip. In the browser, the call
consumes the `AccountId` wrappers; recreate them from saved strings for each
array entry, poll or retry.

For confirmation, start at the admission tip returned by submission, match the
exact transaction ID, and advance your own cursor to `blockTo + 1` only after a
successful scan. Inclusion assumes trust in the RPC node. A polling timeout
means unconfirmed, not failed; this method does not poll or track local state.

To submit externally proved work, use `getTransactionEncryptionKey` with your
trusted genesis commitment and trusted block header, then
`submitProvenTx(proof, inputs, key)` or
`submitProvenTxBatch(provenBatch, proposedBatch, transactionInputs, key)`.
The SDK verifies the key attestation and seals the complete execution inputs.
A transaction proof alone is insufficient, and a batch requires a batch proof
with inputs in proposal order. The returned number is the node's chain tip at
submission, not a commitment receipt. These calls do not execute, prove, apply
local state or deliver private notes. In the browser, the batch call consumes
its input wrappers; keep serialized copies to construct fresh wrappers for
a retry. Read the usage skill's stateless RPC section for the trust and
serialization requirements.

## Rules that are easy to get wrong

When a browser transaction fails on a VM assertion, inspect the optional
`error.masm` before matching message text. Its `errorCode` is a decimal string.
Assertion text and source locations can be absent, including after production
debug info stripping.

**Invitation checks do not reserve codes.** Use
`client.accounts.isInvitationCodeValid(code)` to check whether a non-empty
code can register an account. It returns `false` for unknown or used codes,
and `true` when the node does not enforce an allowlist. Registration can still
fail after a successful check; only `accounts.register()` consumes the code.

**Sync before you read.** Local state is a cache of chain state. Calling
`client.sync()` first is the difference between correct balances and confusing
ones. `skills/web-client-usage/SKILL.md` documents where in each flow it belongs.

Clients sharing a browser database read coherent persisted account state.
Account witnesses refresh when another client changes that state, preserving
untouched vault assets and storage maps. This does not fetch new chain state;
continue to sync before relying on on-chain balances.

**One client per store.** Two live clients on one store do not coordinate.
Opening a store another live client in the realm has open (the same IndexedDB
name in the browser, the same SQLite file on Node.js) logs a `console.warn`
naming that client as `client #N`. `MidenClient.create({ ..., exclusive: true })`
makes the open throw instead, naming the owner, and refuses every later open of
the store while that client lives. `terminate()` releases the store.

For browser stores, `apply` requires the stored account to match the
transaction's execution input. A mismatch rejects before changing account state
or transaction history. A submitted transaction is already accepted by the node when
local apply fails, so `apply` and the single-transaction `transactions.*` helpers
(which apply after submitting) reject with `code: "ApplyTransactionAfterSubmitFailed"`,
`transactionId`, `submissionHeight` and the original error as `cause`. A batch whose
local update fails after the node accepted it rejects with the same `code` and the
accepted block in its message, without those fields. Do not submit it again.
`ApplyTransactionAfterSubmitFailed` fields are browser builds only: Node.js errors
only prefix the message with the code.
A batch whose admission is indeterminate rejects with
`code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN"`, `transactionIds`, and nothing recorded
locally, plus `submission` (browser in-thread and Node.js) or `submissionId`
(browser Web Worker); resend it
with `transactions.retryProvenBatch(error.submission ?? { submissionId: error.submissionId })`
and never re-run `batch` / `submitBatch`. A rejected retry records nothing and a
sync does not insert the records, so look the ids up on the node.

MASM that does not assemble or link rejects with `code: "MASM_COMPILE_FAILED"`;
a transaction program that fails in the VM (a failing `assert`) rejects with
`code: "TRANSACTION_EXECUTION_FAILED"`, the VM diagnostic in the message. Same
Node.js prefix rule as above.
In the browser, a library that fails to build (`buildLibrary`, including an inline
`{ namespace, code }` library of `compile.txScript` or `compile.noteScript`) rejects with a bare
string that has no `code`.

**Submitting never registers network scripts.** Scripts a request declares
through `withExpectedNtxScripts` are not registered by any submit path; submit
`newRegisterNoteScriptsTransactionRequest` first. Nodes added with
`extendMerkleStore` are stored as given, so each `InnerNodeInfo` value must
already be the Poseidon2 merge of its children.

**Amounts are always `BigInt`.** Passing a `number` either throws at the WASM
boundary or silently loses precision above 2^53. Convert at the edges of your
own code, not in the middle of a transaction builder.

**The WASM client is single-threaded.** Concurrent calls into one client
instance are not safe. Serialize them. Applications that fan out requests from
multiple components need a lock or a queue around the client, and this is the
single most common source of "impossible" runtime errors.

**Free what you allocate.** WASM-backed objects are not garbage collected the
way plain JS objects are. Call `terminate()` on the client when you are done
with it, and free the object wrappers the skills call out individually.

**Account visibility and faucet kind are separate.** Use native
`AccountType.Private` / `AccountType.Public` with `AccountBuilder.accountType()`.
Use `FaucetType.FungibleFaucet` for `accounts.create({ type })`, and `storage`
for visibility. Pass `components` to `accounts.create` for a contract. A
contract also needs a raw 32-byte `seed` and `auth`. `auth` is an
`AuthSecretKey` stored with the account, or `"none"` for a NoAuth contract that
anyone can call and that stores no key. Omitting `auth` is rejected and does
not default to NoAuth. `"none"` is only valid on a contract; wallet and faucet
`auth` stays `AuthScheme.Falcon` or `AuthScheme.ECDSA`. Older
`AccountType.FungibleFaucet` references must migrate to
`FaucetType.FungibleFaucet`; `create()` throws a `TypeError` for an unrecognised
`type` rather than creating a wallet. The legacy `0` / `1` are still faucet
selectors and equal `AccountType.Private` / `Public`, so never pass a visibility
value as `type`.

A component, transaction script or note script can also come from a compiled
package (`.masp`) instead of MASM source: pass `package` (a `Package` or its
serialized bytes) in place of `code`, for example
`client.compile.component({ package: bytes, slots })`, then pass the result to
`accounts.create({ components })` as usual. `compile.txScript` and
`compile.noteScript` take `{ package }` the same way. `namespace` and
`libraries` apply to source only, and a package must be the right kind for what
you build. A component built from a package always gets the fixed metadata name
`"custom"`, whatever name the package declares, and `supportAllTypes` still
defaults to `true`. The `Package` you pass stays usable afterward.

## Read non-fungible assets

```typescript
await client.sync();
const { vault } = await client.accounts.getDetails(wallet);
const assets = vault.nonFungibleAssets().map((asset) => ({
  issuer: asset.faucetId().toString(),
  key: asset.vaultKey().toHex(),
  value: Array.from(asset.intoWord().toU64s()),
}));
```

`nonFungibleAssets()` returns only non-fungible assets from the local vault
snapshot. It returns an empty array when none are present. The order is not
specified. `faucetId()` identifies the issuer, `vaultKey()` returns the complete
asset key, and `intoWord().toU64s()` returns all four value limbs as `bigint`
values. Keep these values as `bigint` or strings to prevent precision loss.

Compare both the complete key and all four value limbs to verify an asset.
The key alone does not contain the complete value. To reconstruct an asset,
use `VaultAsset.nonFungible({ key, value })` with the two `Word` objects.

## Build notes with either asset type

```typescript
const token = VaultAsset.fungible(faucetId, 100n);
const name = VaultAsset.nonFungible({ key, value });
const assets = new NoteAssets([name]);
assets.push(token);
```

`NoteAssets` accepts one list of 0 to 16 assets. Existing `FungibleAsset`
constructor and `push()` calls remain valid. Duplicate IDs and excess assets
throw catchable errors; a failed push leaves the list unchanged. Inputs remain
usable. `vault.assets()` and `note.assets().assets()` return both variants;
use `kind()`, `asFungible()`, or `asNonFungible()` to inspect them.

For registry publishing, use `Note.withAttachments()` with a single name asset,
public metadata, the registry's approved script and inputs, and
`[new NetworkAccountTarget(registryId).toAttachment()]`. The registry account
must be public. A tag alone does not make a network note. Consume the returned P2ID note to put
the asset back in the vault. The amount-based `send` helper remains fungible-only.

## Fee sponsorship notes

Use standalone `createFeeSponsorshipNote` (or `Note.createFeeSponsorshipNote`)
to build a fee-sponsorship note bound to `featureNoteId` and routed to a
**public** `to` account (`to` must be public for network routing). `reclaimer`
defaults to the sponsor (`from`). Omit `reclaimAfter` / `reclaimHeight` to
disable reclaim; when set, it must be a positive 32-bit integer (`0` is
rejected). Prefer `createFeeSponsorshipNote` when passing an `AccountId`
`reclaimer` because standalone clones it, whereas `Note.createFeeSponsorshipNote`
consumes a passed `reclaimer` `AccountId` in browser WASM even on error.

```typescript
const sponsorship = createFeeSponsorshipNote({
  from: sponsorId,
  to: publicTargetId,
  featureNoteId: featureNote.id(),
  asset: new FungibleAsset(feeFaucetId, 1_000n),
  reclaimer: reclaimerId, // optional; defaults to `from`
  reclaimAfter: 100, // optional positive 32-bit integer (> 0; 0 is rejected)
});

const decoded = FeeSponsorshipNote.tryFromNote(sponsorship);
decoded.featureNoteId();
decoded.sender();
decoded.reclaimer();
decoded.reclaimHeight(); // number | undefined
decoded.asset();
decoded.tag();
decoded.serialNumber();
decoded.intoNote();
```

## Decode standard notes

`P2idNote`, `P2ideNote` and `SwapNote` decode a standard note into its typed
fields, so an inbox can show who a note pays, when it unlocks and what a swap
exchanges without reading raw storage:

```typescript
import { NoteScript, P2idNote, P2ideNote, SwapNote } from "@miden-sdk/miden-sdk";

const note = record.toNote();
const root = note.script().root().toHex();

if (root === NoteScript.p2id().root().toHex()) {
  const p2id = P2idNote.tryFromNote(note);
  p2id.target(); // who it pays
  p2id.assets();
} else if (root === NoteScript.p2ide().root().toHex()) {
  const p2ide = P2ideNote.tryFromNote(note);
  p2ide.target();
  p2ide.timelockHeight(); // number | undefined: not consumable before this block
  p2ide.reclaimer();
  p2ide.reclaimHeight(); // number | undefined: the reclaimer may take it back from here
} else if (root === NoteScript.swap().root().toHex()) {
  const swap = SwapNote.tryFromNote(note);
  swap.offeredAsset(); // what the consumer receives
  swap.requestedAsset(); // what the consumer pays back to swap.sender()
  swap.paybackNoteType();
  swap.paybackTarget(); // AccountId | undefined (public payback only)
  swap.paybackRecipient(); // Word | undefined (private payback only)
}
```

Each decoder also exposes `sender()`, `serialNumber()`, `noteType()` and
`intoNote()`. `tryFromNote` throws when the note runs another script
(`not a P2ID note`), when its storage does not decode, or, for `SwapNote`, when
it does not carry exactly one asset.

`PswapNote` and `BurnNote` decode a partial-fill swap order and a burn the same
way:

```typescript
import { BurnNote, NoteScript, PswapNote } from "@miden-sdk/miden-sdk";

if (root === NoteScript.pswap().root().toHex()) {
  const pswap = PswapNote.tryFromNote(note);
  pswap.offeredAsset(); // FungibleAsset on offer
  pswap.requestedAsset(); // FungibleAsset asked for the whole offer
  pswap.minFillStep(); // smallest fill, 0 when unbounded
  pswap.creatorAccountId(); // receives every payback
  pswap.orderId(); // decimal string, as PswapLineageRecord.orderId()
  pswap.parentDepth(); // 0 for the original order, +1 per remainder
} else if (root === NoteScript.burn().root().toHex()) {
  const burn = BurnNote.tryFromNote(note);
  burn.asset(); // what the faucet burns
  burn.faucetId(); // the faucet that consumes the note
}
```

A BURN note whose storage does not hold exactly the asset it carries is
rejected, as the BURN script rejects it at consume time. A PSWAP note with more than one
attachment is rejected too.

`MintNote` decodes a MINT note, which asks a network faucet to mint an asset
into a new note:

```typescript
import { MintNote, NoteScript } from "@miden-sdk/miden-sdk";

if (root === NoteScript.mint().root().toHex()) {
  const mint = MintNote.tryFromNote(note);
  mint.asset(); // what the faucet mints
  mint.faucetId(); // the faucet that consumes the note
  mint.tag(); // tag of the minted note
  mint.recipientDigest(); // private minted note: its recipient, else undefined
  mint.recipientScriptRoot(); // public minted note: its script root,
  mint.recipientSerialNumber(); // serial number
  mint.recipientStorage(); // and storage, else undefined
}
```

To screen a note before importing it, pass it to `client.notes.screen`. Each
entry is a `NoteConsumability`, as `ConsumableNoteRecord.noteConsumability()`
lists them:

```typescript
const all = await client.notes.screen(note); // every tracked account
const mine = await client.notes.screen(note, { account: wallet });
for (const entry of mine) {
  const status = entry.consumptionStatus();
  status.isConsumableNow(); // consumable at the last synced block
  status.consumableAfterBlock(); // unlock height when locked, else undefined
}
```

The screener leaves out accounts that can never consume the note, and accounts
that cannot consume it under the current conditions, so an empty array means
no screened account can consume it now. It is also empty when the client
tracks no accounts, so do not read it as never consumable. Screening does
not import the note. The low-level `WebClient` exposes the same screen as
`getNoteConsumability(note)` and `getNoteConsumabilityForAccount(note, accountId)`.

## Going deeper

- Narrative documentation and the full generated API reference:
  <https://docs.miden.xyz/builder/tools/clients/web-client/>
- Breaking changes and migration notes, worth reading at upgrade time:
  the `CHANGELOG.md` in [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk).
- The type declarations shipped in `dist/` are authoritative for signatures.
  When this guide and the types disagree, the types are right and this file is
  a bug - please report it.

## Starting a new project rather than adding to one

If there is no application yet, [`0xMiden/agentic-template`](https://github.com/0xMiden/agentic-template)
scaffolds the full stack: Rust contracts, MockChain tests, local-node
validation, and a React frontend already wired to this SDK.
