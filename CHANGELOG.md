# Changelog

## Unreleased (TBD)

### Fixes

* [FIX][react] Hooks no longer reuse by-value WASM objects across poll/refetch iterations, which zeroed the JS wrapper's pointer on first use and made every later use throw `null pointer passed to rust` (closes [#278](https://github.com/0xMiden/web-sdk/issues/278)). Four sites, each now rebuilding the handle from a snapshotted hex or account reference:
  * `useWaitForNotes` — `getConsumableNotes` takes `Option<AccountId>` by value, so the single `AccountId` built before the loop was dead after the first poll. The helper therefore only worked when the notes were already present and failed whenever it actually had to wait.
  * `useWaitForCommit` — `TransactionFilter.ids([txId])` consumed the caller's `TransactionId` on the first poll.
  * `useTransactionHistory` — the memoised `TransactionId`s were handed to `TransactionFilter.ids` again on every refetch, so the second refetch (e.g. the one driven by a sync tick) threw.
  * `useTransaction` — `txId.toHex()` was read after `waitForTransactionCommit` had already consumed the handle; the hex is now snapshotted before the call.

## 0.15.9 (2026-08-04)

### Enhancements

* [FEATURE][web] Added `NoteScript.burn()`, `NoteScript.mint()`, and `NoteScript.pswap()`, exposing the remaining well-known note scripts (the faucet burn/mint pair plus partial-fill swap) so the static constructors now mirror every `StandardNote` variant alongside the existing `p2id()` / `p2ide()` / `swap()`. The standard BURN note script root is now reachable from TypeScript as `NoteScript.burn().root().toHex()`. ([#256](https://github.com/0xMiden/web-sdk/pull/256))

```ts
const burnScriptRoot = NoteScript.burn().root().toHex();
```

### Fixes

* [FIX][web] `client.notes.sendPrivate(...)` now relays a block hint (the sender's current sync height) through the transport layer, so an already-synced recipient locates the note's on-chain commitment deterministically instead of relying on a narrow fixed lookback window that silently dropped it. Relay promptly after submitting the note's transaction so the hint stays at or before the note's commitment. No API change. ([web-sdk#258](https://github.com/0xMiden/web-sdk/pull/258))
* [FIX][web] Bundled `miden-client` bumped to 0.15.5. Upstream note-transport fixes reaching the web SDK: a transport delivery that collides with a note a local transaction is consuming no longer wedges `sync()` (it is skipped and the cursor advances), and transport deliveries are now validated on receipt — entries whose details don't match the header's commitment, or whose tag was never requested, are dropped. `prepare_transaction` also no longer panics on an already-consumed input note that carries no metadata. ([miden-client 0.15.5](https://github.com/0xMiden/rust-sdk/releases/tag/v0.15.5))

## 0.15.8 (2026-07-22)

### Enhancements

* [FEATURE][web] `BasicFungibleFaucetComponent.fromAccountStorage(accountStorage)` reads faucet metadata directly from an account's storage, covering faucets whose account shape makes `fromAccount` fail (e.g. AggLayer faucets). Available on both the browser and Node.js bindings (closes [#243](https://github.com/0xMiden/web-sdk/issues/243), [web-sdk#244](https://github.com/0xMiden/web-sdk/pull/244)).

```ts
const faucetMeta = BasicFungibleFaucetComponent.fromAccountStorage(account.storage());
faucetMeta.symbol().toString(); // "DAG"
```

* [FEATURE][web] `FungibleAsset.fromVaultEntry(key, value)` reconstructs a fungible asset from the word pair stored under it in an account vault — the outputs of `FungibleAsset.vaultKey()` (faucet id + callback flag) and `FungibleAsset.intoWord()` (the value word holding the amount) — so `FungibleAsset.fromVaultEntry(a.vaultKey(), a.intoWord())` round-trips an asset read from vault data, callback flag included. `FungibleAsset.fromVaultKey(key, amount)` is a convenience for when you hold the key word plus a scalar `bigint` amount rather than the value word, and `FungibleAsset.vaultKey()` exposes the key word for the round trip. (closes [#246](https://github.com/0xMiden/web-sdk/issues/246))

## 0.15.7 (2026-07-20)

### Enhancements

* [FEATURE][web] Manual transaction lifecycle on `client.transactions` — `executeRequest(account, request)` returns a staged handle you advance with `.prove({ prover? })` → `.submit()` → `.apply()`, exposing the stages that `submit()` runs in one call so each can be benchmarked and error-handled independently. Each stage carries its own context, so nothing is re-threaded between calls. A proof produced on a detached client can be submitted with `client.transactions.submitProven(proof, result)` (closes [#233](https://github.com/0xMiden/web-sdk/issues/233)).

```ts
const executed = await client.transactions.executeRequest(wallet, request);
const proven = await executed.prove();
const submitted = await proven.submit();
await submitted.apply();
```

* [FEATURE][web] `FungibleAsset.callbacks()` and `FungibleAsset.withCallbacks(flag)` expose the asset's `AssetCallbackFlag` (`Disabled` / `Enabled`) — the vault-key bit that decides whether the issuing faucet's callbacks run when the asset is added to an account or note. The constructor always yields `Disabled`; `withCallbacks` returns a copy carrying the given flag. The flag is part of the asset's vault key, so it must match the flag the issuing faucet applies. (closes [#239](https://github.com/0xMiden/web-sdk/issues/239))

```ts
const asset = new FungibleAsset(faucetId, 10n);
asset.callbacks(); // AssetCallbackFlag.Disabled
const enabled = asset.withCallbacks(AssetCallbackFlag.Enabled);
```

## 0.15.6 (2026-07-17)

### Fixes

* [FIX][web] Bundled `miden-client` bumped to 0.15.4. Upstream fixes reaching the web SDK: public-account sync no longer discards the client's own just-committed transaction as `Superseded` (which could permanently wedge a sole-writer account); transaction-submission failures now report the node's actual cause instead of a misclassified error; `ConsumedExternal` notes retain their metadata, so they stay findable by note ID after consumption; sync responses slightly above the node's 4 MiB payload budget no longer fail to decode. ([miden-client 0.15.4](https://github.com/0xMiden/rust-sdk/releases/tag/v0.15.4))
* [FIX][web] Creating a transaction no longer registers a note tag per output note. Previously each created note leaked one `tags` row in IndexedDB (cleanup only ever covered input notes); a store migration prunes the leaked tags, keeping those still needed by inclusion-pending input notes. Mirrors the client-side SQLite migration. (client [0xMiden/rust-sdk#2323](https://github.com/0xMiden/rust-sdk/pull/2323))

### Enhancements

* [FEATURE][web] `InputNoteRecord.isInclusionPending()` and `OutputNoteRecord.isInclusionPending()` — `true` while the note's on-chain inclusion is still unsettled (input notes: `Expected` / `Unverified`; output notes: `ExpectedFull` / `ExpectedPartial`), i.e. while sync is the mechanism that can advance the record. (client [0xMiden/rust-sdk#2323](https://github.com/0xMiden/rust-sdk/pull/2323))
* [FEATURE][web] `AccountComponent.createNetworkAuth(allowedNoteScriptRoots, allowedTxScriptRoots?)` builds the auth component for a network account — a public account the node auto-consumes network notes against. The note-script allowlist (roots from `NoteScript.root()`) must be non-empty; transaction scripts are forbidden unless allowlisted via the optional second argument. Readback: `Account.isNetworkAccount()` and `Account.networkNoteAllowlist()`. ([#236](https://github.com/0xMiden/web-sdk/pull/236))

```ts
const auth = AccountComponent.createNetworkAuth([noteScript.root()]);
const { account } = new AccountBuilder(seed)
  .storageMode(AccountStorageMode.public())
  .withComponent(counterComponent)
  .withAuthComponent(auth)
  .build();
```

## 0.15.5 (2026-07-08)

### Enhancements

* [FEATURE][web] `client.transactions.createNetworkNote(...)`, `Note.withAttachments/attachments/isNetworkNote`, `NetworkAccountTarget`, and standalone `buildNetworkNote` — create custom-script notes that target a public network account. ([#230](https://github.com/0xMiden/web-sdk/pull/230))
* [FEATURE][react] `useCreateNetworkNote` — build + submit a custom-script network note. ([#230](https://github.com/0xMiden/web-sdk/pull/230))

## 0.15.4 (2026-06-29)

### Fixes

* [FIX][web] `account.storage().getItem(slot)` / `getMapItem(...)` results (`StorageResult`) now forward `toU64s()`. The result is typed as a `Word` and already forwards `toFelts()` / `toHex()` / `toBigInt()`, but `toU64s()` was missing, so reading raw u64 elements off a storage value (e.g. `getItem(slot).toU64s()`) threw `toU64s is not a function` at runtime. This broke the OpenZeppelin multisig client's `AccountInspector` (run on every multisig-account `load`), and thus every guardian transaction. ([#194](https://github.com/0xMiden/web-sdk/pull/194))

### Enhancements

* [FEATURE][web] `BasicFungibleFaucetComponent` now exposes the full token metadata of a fungible-faucet account: `tokenName()`, `tokenSupply()` (the amount minted so far, as a `Felt`), `description()`, `logoUri()`, and `externalLink()` — the optional descriptive fields return `undefined` when unset. These read the same on-chain `FungibleFaucet` component that already backed `symbol()` / `decimals()` / `maxSupply()`, so they work for both basic and network-style faucet accounts. In the 0.15 protocol the basic-vs-network distinction is a function of account configuration, not a separate component type, so a dedicated `NetworkFungibleFaucet` binding is unnecessary. ([#162](https://github.com/0xMiden/web-sdk/issues/162))

```ts
const faucet = BasicFungibleFaucetComponent.fromAccount(account);
faucet.tokenName();               // "DAG Token"
faucet.tokenSupply().toString();  // "0"
faucet.description();             // string | undefined
```

* [FEATURE][web,react] AggLayer bridge-out (B2AGG) note support. `client.transactions.bridge({ account, bridgeAccount, token, amount, destinationNetwork, destinationAddress })` bridges a fungible asset out to another network — emitting a single public B2AGG (Bridge-to-AggLayer) note that the bridge account consumes, burning the asset so it can be claimed at the destination Ethereum address on the AggLayer-assigned `destinationNetwork`. The lower-level builders are also exposed: `Note.createB2AggNote(sender, bridgeAccount, assets, destinationNetwork, destinationAddress)` and `client.newB2AggTransactionRequest(...)`. A new `EthAddress` class carries the 20-byte destination address (`EthAddress.fromHex("0x…")` / `EthAddress.fromBytes(bytes)`, with `toHex()` / `toBytes()`). The `@miden-sdk/react` `useBridge()` hook wraps the build-and-submit flow: `bridge({ from, bridgeAccount, assetId, amount, destinationNetwork, destinationAddress })`. Builds on the `miden-agglayer` re-export already present in the bundled `miden-client` — no new dependency. (closes [#173](https://github.com/0xMiden/web-sdk/issues/173))
* [FEATURE][web] Added `client.transactions.batch({ account, operations })` to `MidenClient` for atomic multi-tx batches against a single account. Operations are discriminated by `kind` (`"send" | "mint" | "consume" | "swap" | "execute" | "custom"`) and reuse the same options shape as their singular counterparts. Returns `{ blockNumber }`. Companion `submitBatch(account, requests, options?)` is the lower-level escape hatch for pre-built `TransactionRequest`s. Wraps the underlying WASM `submitNewTransactionBatch` so consumers don't have to call `.serialize()` themselves. ([web-sdk#31](https://github.com/0xMiden/web-sdk/pull/31), client [#2109](https://github.com/0xMiden/miden-client/pull/2109))

## 0.15.3 (2026-06-25)

### Fixes

* [FIX][web,react] The `@miden-sdk/miden-sdk` **Node entry** (resolved via the `node` export condition — Next.js / Remix server builds, Vitest, and any bundler that prefers `node`) now re-exports the full public class surface, matching the browser entry. It previously shipped a hand-curated subset, so importing a class the subset omitted — e.g. `BasicFungibleFaucetComponent`, `TransactionRequest`, `InputNoteRecord`, `NoteAttachmentScheme`, `Poseidon2` — or using a `@miden-sdk/react` hook that imports one (`useAssetMetadata`, `useCompile`) — failed under Node resolution with `"'X' is not exported from '@miden-sdk/miden-sdk'"`, even though the type declarations advertised it. The JS-layer helpers `CompilerResource` and `getWasmOrThrow` are now exported on Node too. The Node re-export list is generated from the native module and checked in CI, so it stays in lockstep with the surface. ([#206](https://github.com/0xMiden/web-sdk/pull/206))

## 0.15.2 (2026-06-22)

### Enhancements

* [FEATURE][web] `TransactionRequest.extendAdviceMap(adviceMap)` merges advice entries into an already-built request and returns a new request (last-write-wins on key collisions), and `TransactionRequest.adviceMap()` returns a copy of the request's advice map. This lets a signer/guardian flow inject advice (e.g. a signature) that only becomes available *after* the request object is constructed, without going back through the builder. ([#203](https://github.com/0xMiden/web-sdk/pull/203), closes [#202](https://github.com/0xMiden/web-sdk/issues/202))
* [FEATURE][web,react] PSWAP order-lineage tracking. The client persists a *lineage* per partially-fillable swap order — the chain of remainder notes a PSWAP leaves behind as it is filled round by round — keyed by a stable `orderId`. A new `pswap` resource on `MidenClient` exposes `pswap.lineages()`, `pswap.lineagesFor(creator)`, and `pswap.lineage(orderId)`, returning `PswapLineageRecord`s — `remainingOffered()` / `remainingRequested()` (the amounts still unfilled on the current tip), `currentDepth()`, `currentTipNoteId()`, and `state()` (`Active` / `FullyFilled` / `Reclaimed`) — plus `pswap.cancelByOrder(orderId)`, which reclaims the unfilled offered asset on the order's current tip (refused on a `FullyFilled` / `Reclaimed` order). Four React hooks expose the reads + cancel: `usePswapLineages`, `usePswapLineagesFor`, `usePswapLineage`, and `usePswapCancelByOrder`. ([#176](https://github.com/0xMiden/web-sdk/pull/176), companion: [0xMiden/miden-client#2231](https://github.com/0xMiden/miden-client/pull/2231))

### Changes

* [behavior][web] `applyTransaction(...)` now persists through the high-level client apply path, so registered transaction observers (e.g. PSWAP lineage tracking) fire when a transaction is applied — previously the split prove/submit/apply pipeline persisted the update without firing any. For transactions unrelated to a tracked order the observer pass is a no-op. ([#176](https://github.com/0xMiden/web-sdk/pull/176))

## 0.15.1 (2026-06-19)

### Changes

* [web,react] Bumped the bundled `miden-client` to `0.15.2`. Notes imported from the note transport layer now honor a sender-provided block hint (`after_block_num`) when present, falling back to the 20-block lookback window otherwise. The bump also makes miden-client's PSWAP chain-tracking APIs (`pswap_lineages`, `build_pswap_cancel_by_order`, …) and `send_private_note_with_block_hint` available in the bundled core for later exposure, and re-exports `miden-agglayer`. No web/React API changes. (companion: [0xMiden/miden-client#2231](https://github.com/0xMiden/miden-client/pull/2231), [0xMiden/miden-client#2262](https://github.com/0xMiden/miden-client/issues/2262), [0xMiden/miden-client#2253](https://github.com/0xMiden/miden-client/issues/2253))

## 0.15.0 (2026-06-12)

### Enhancements

* [FEATURE][web,react] The 0.14.x line's mobile/MT proving surface is available on the 0.15 series (forward-ported from `main`): `TransactionProver.newCallbackProver(jsFn)` (route prove to a native iOS/Android plugin; wire format matches `RemoteTransactionProver`), `ClientOptions.useWorker?: boolean` / `MidenConfig.useWorker` (opt out of the Web Worker shim — required for callback provers, whose closure cannot cross the worker boundary), `MidenClient._withInnerWebClient(fn)` with the depth-tracked re-entrancy fix, the multi-threaded WASM build at the `@miden-sdk/miden-sdk/mt` + `/mt/lazy` (and `@miden-sdk/react/mt` + `/mt/lazy`) subpaths, and the `miden-mobile-prover` C-ABI crate — now built against the 0.15 protocol, so its `TransactionInputs`/`ProvenTransaction` wire format requires a matching 0.15 SDK (native binaries built from 0.14 do not interoperate). ([#149](https://github.com/0xMiden/web-sdk/pull/149), [#152](https://github.com/0xMiden/web-sdk/pull/152), [#134](https://github.com/0xMiden/web-sdk/pull/134))
* [FEATURE][web] Added `BlockHeader.feeFaucetId()` — the account ID of the fungible faucet whose assets pay transaction verification fees, read from the block's on-chain fee parameters. This is the 0.15 spelling of the 0.14 line's `BlockHeader.nativeAssetId()` (the underlying protocol field was renamed `native_asset_id` → `fee_faucet_id`); consumers discovering the fee/native asset per network should migrate to the new name.

* [FEATURE][rust,cli,web] Added `get_network_note_status` to `NodeRpcClient` trait for querying the processing status of notes submitted to the network (pending, nullifier-inflight, discarded, nullifier-committed), along with attempt count and error details. Exposed as `miden-client network-note-status <note_id>` CLI command and `RpcClient.getNetworkNoteStatus()` in the web client. ([#1981](https://github.com/0xMiden/miden-client/pull/1981))
* [FEATURE][web,react] Added partial-swap (PSWAP) support: `transactions.pswapCreate / pswapConsume / pswapCancel` on `MidenClient` (and matching `preview()` operations) plus three React hooks `usePswapCreate`, `usePswapConsume`, `usePswapCancel`. PSWAP notes can be filled by multiple consumers; each fill emits a payback note to the creator and, on a partial fill, a remainder PSWAP note carrying the unfilled amount. ([#159](https://github.com/0xMiden/web-sdk/pull/159)).
* [FEATURE][web] `RpcClient.getNotesById(...)` results expose the note's attachments via `FetchedNote.attachments`. On the 0.15 surface the node returns attachment content for both public and private fetched notes, so this is populated even when the note body itself is private. ([#172](https://github.com/0xMiden/web-sdk/pull/172), companion: [0xMiden/miden-client#2214](https://github.com/0xMiden/miden-client/pull/2214))
* [FEATURE][web] Added `NoteAttachment.toWords()` and `InputNoteRecord.attachments()` to read a note's attachment payload back out. On the 0.15 surface the attachment words live on the note record (not on `NoteMetadata`), so these invert `NoteAttachment.fromWord(scheme, word)` / `fromWords(scheme, words)`: `record.attachments()[0].toWords()` yields the `Word`s the attachment was built from. ([#172](https://github.com/0xMiden/web-sdk/pull/172), companion: [0xMiden/miden-client#2214](https://github.com/0xMiden/miden-client/pull/2214))

### Changes

* [BREAKING][param][web] `RpcClient.syncNotes(blockFrom, blockTo, noteTags)` — `blockTo` is now required, and `NoteSyncInfo.chainTip()` was removed (upstream RPC no longer returns it; use `client.syncState()`). ([#157](https://github.com/0xMiden/web-sdk/pull/157))
* [BREAKING][behavior][web] `newFaucet(...)` accounts are now built on `FungibleTokenMetadata` + `TokenPolicyManager`; `BasicFungibleFaucetComponent.fromAccount(...)` reads the new metadata slot, so faucets minted by prior SDK versions can't be introspected through it. ([#157](https://github.com/0xMiden/web-sdk/pull/157))
* [BREAKING][api][web,react] Account code mutability was removed (it no longer exists in protocol 0.15, where mutability is component-driven). `newWallet(...)` and `importPublicAccountFromSeed(...)` no longer take a `mutable` flag, and the React `useCreateWallet` / `useImportAccount` / `useSessionAccount` hooks dropped their `mutable` option. `accounts.create({ type })` no longer accepts the wallet/contract mutability values, and the `AccountType` const now exposes only `FungibleFaucet` / `NonFungibleFaucet` (a wallet is the default, a contract is any `create()` call that passes `components`). ([#171](https://github.com/0xMiden/web-sdk/pull/171))
* [BREAKING][api][web,react] Migrated `miden-client-web` and `miden-idxdb-store` to the miden-client 0.15 protocol surface. User-visible changes: `AccountStorageMode.network()` was removed (the 0.15 chain has no separate network-account flag — the `"network"` value is no longer a valid `StorageMode`); the `AccountType` enum (previously `{ FungibleFaucet, NonFungibleFaucet, RegularAccountImmutableCode, RegularAccountUpdatableCode }`) narrowed to `{ Private, Public }` (the faucet / regular and updatable / immutable distinctions moved off the on-chain id, so `AccountId.isFaucet()` / `.isNetwork()` / `.isRegularAccount()` were removed from `AccountId` — faucet detection now lives on `Account` as `Account.isFaucet()` / `Account.isRegularAccount()`, derived from the account's component interface — while `Account.isNetwork()` / `Account.isUpdatable()` and the `AccountStorageMode.network()` constructor were removed outright); `Felt` and `Word` constructors now throw on inputs at or beyond the field modulus instead of asserting; `RpcClient.getNoteScriptByRoot(...)` returns `NoteScript | undefined` instead of throwing on unknown roots; `InputNoteRecord.id()` returns `NoteId | undefined` for partial / metadata-less notes; the `NoteAttachmentKind { Word, Array }` dispatch and per-variant `NoteAttachment.newWord` / `.newArray` / `.asWord` / `.asArray` accessors plus the `NoteMetadata.attachment()` getter were removed — attachments are always word-vector-shaped on the new surface (`NoteAttachment.fromWord(scheme, word)` / `fromWords(scheme, words)`); `RpcClient.getAccountProof(...)` keeps the same JS signature but is wired onto the new `get_account(GetAccountRequest...)` upstream API; `FetchedNote` exposes `noteId` / `metadata` directly (the synthetic `header` getter was removed — a `NoteHeader` can no longer be reconstructed from header-shaped fields alone for private notes). React hooks: `useCreateWallet({ storageMode })` and `useCreateFaucet({ storageMode })` drop the `"network"` storage-mode option to match the new surface. `MidenClient.newFaucet(...)` is rebuilt on the 0.15 `FungibleFaucet` component plus a `TokenPolicyManager` that registers `AllowAll` mint and burn policies (transfer policies are intentionally omitted so minted assets carry no callback flag); `non_fungible = true` still fails fast, as non-fungible faucets remain unsupported. `WebClient.importNoteFile(...)` (the resource-layer `notes.import(...)`) now resolves to a hex `string` — the note-id hex, or the details-commitment hex for a details-only file — rather than a `NoteId` object; pass it to `NoteId.fromHex(...)` if a `NoteId` instance is required. `NoteAttachmentScheme.asU32()` was removed (the scheme is now u16-backed). On `idxdb-store`'s `JsStateSyncUpdate`, the `committedNoteIds` field was renamed `committedNoteTagSources` and now carries details-commitment hex rather than note-id hex. ([#172](https://github.com/0xMiden/web-sdk/pull/172), companion: [0xMiden/miden-client#2214](https://github.com/0xMiden/miden-client/pull/2214))
* [CHANGE][web] `miden-client` and `miden-client-sqlite-store` are now consumed from crates.io at the final `0.15.0` release instead of a `next`-branch snapshot, resolving `miden-protocol` / `miden-standards` to `0.15.3`. Inherited upstream behavior fixes include paginated draining of private note transport responses, a durable relay outbox for `sendPrivateNote`, and MMR response verification during sync. ([#171](https://github.com/0xMiden/web-sdk/pull/171), upstream: [miden-client v0.15.0](https://github.com/0xMiden/miden-client/releases/tag/v0.15.0))
* [CHANGE][web] WASM client errors now carry a stable, machine-readable `code` property for the `ClientError` variants JS callers branch on (`code_from_error` in `crates/web-client/src/lib.rs`), currently `ACCOUNT_NOT_FOUND_ON_CHAIN` and `ACCOUNT_ALREADY_TRACKED`. This lets consumers detect specific errors without matching on the (changeable) message string. The worker shim already forwards `code`, so it survives both the direct and Web Worker dispatch paths.

### Fixes

* [FIX][web] `AssetVault.getBalance(faucetId)` and `FungibleAssetDelta.amount(faucetId)` now match fungible assets by faucet id regardless of the asset's `AssetCallbackFlag`, so balances and deltas of callback-bearing assets (e.g. agglayer / B2AGG) are reported instead of silently reading as zero / absent. ([#171](https://github.com/0xMiden/web-sdk/pull/171))
* [FIX][web] **Direct-path (no-worker) client calls are serialized again.** The `main`→`next` unification (#177) dropped the `_serializeWasmCall` chain from the proxy fallback methods (`getAccount`, `getAccounts`, `getTransactions`, …), the five transaction methods (`executeTransaction`, `proveTransaction`, `applyTransaction`, `submitNewTransaction`, `submitNewTransactionWithProver`) and the three sync methods (`syncState`, `syncChain`, `syncNoteTransport`) — every direct-path call ran raw on the WASM client, which holds its internal `RefCell` across the call's awaits. Two overlapping calls panicked with `RefCell already borrowed`, **poisoning the WASM instance**: later calls throw `Unreachable code should not be executed`, and in-flight promises can stay pending forever. Consumers on `useWorker: false` (Capacitor/WKWebView apps, callback-prover hosts — e.g. miden-wallet on mobile, where the front-end's balance polling overlaps wallet-creation syncs) hit this deterministically at boot. All direct-path calls now route through the serialization chain exactly as on `main` and `0.14.x`; `SYNC_METHODS` stay raw-bound by design. Found chasing the mobile leg of [#180](https://github.com/0xMiden/web-sdk/issues/180); covered by a burst-concurrency regression test that hangs/panics on the unfixed build.
* [FIX][web] **`proveTransaction(result, prover)` with an explicit prover works on a bare `WebClient`.** Proving with a supplied prover is a pure computation over the `TransactionResult` and touches no client state, but the binding still demanded an initialized client and threw `Client not initialized` when `createClient()` had never run. Prover-only hosts rely on the bare-client pattern — e.g. a `chrome.offscreen` document that initializes a rayon pool in its own WASM instance and proves transactions shipped over from an extension service worker. The explicit-prover path now proves directly (and no longer holds the inner-client lock for the duration of the prove); only the default-prover fallback requires an initialized client. Part of the [#180](https://github.com/0xMiden/web-sdk/issues/180) investigation.
* [FIX][web] **A failed method-worker `INIT` no longer hangs every subsequent call forever.** Worker-forwarded methods await the wrapper's `ready` promise, but `ready` only ever *resolved* — an INIT failure (e.g. `createClient`'s eager genesis fetch hitting an unreachable or version-mismatched RPC endpoint) was posted without a `requestId`, matched no pending request, and was dropped, leaving `ready` pending and every method call awaiting it indefinitely with no error. `ready` now rejects with the underlying worker error, so queued and future calls fail loudly with the real cause. This was the wallet leg of [#180](https://github.com/0xMiden/web-sdk/issues/180): an extension offscreen document constructed a bare worker-shim client, its INIT defaulted to the testnet endpoint, the 0.15 client got version-rejected by the 0.14 node, and the prove call hung silently for minutes.
* [FIX][react] `MidenProvider` no longer crashes the consumer tree on the `/lazy` entries when a `prover` is configured. The default prover was resolved in a render-time `useMemo`, constructing WASM objects (`TransactionProver`) before the module had initialized — on the lazy entries (no import-time top-level await) this threw `Cannot read properties of undefined (reading '__wbindgen_malloc')` into the nearest error boundary at first render. The prover now resolves once the client is ready. Latent on alphas ≤ .4, where the react `/lazy` build accidentally bundled the eager SDK; exposed by the variant-rewrite fix in 0.15.0-alpha.5. ([#179](https://github.com/0xMiden/web-sdk/pull/179))
* [FIX][web] **Mock-client proving now uses the multi-threaded pool.** The worker shim's `INIT_MOCK` path never called `initThreadPool` inside the method worker's WASM instance (unlike the real `INIT` path), so every prove on a mock client — including the integration suite — silently ran single-threaded even on the `/mt` build with a cross-origin-isolated page. `numThreads` is now plumbed through `INIT_MOCK` exactly like `INIT`; a mock mint prove drops from ~23s to ~5s on a 10-core machine. The gap predates 0.15 (reproduced on `0.14.11`). Investigation notes are in [#180](https://github.com/0xMiden/web-sdk/issues/180).
* [FIX][react] `readNoteAttachment(record)` decodes attachment payloads again. It reads `record.attachments()[0].toWords()` and flattens the words back into the `bigint[]` packed by `createNoteAttachment` (an all-zero placeholder still decodes to `null`). It had regressed to always returning `null` during the 0.15 migration. ([#172](https://github.com/0xMiden/web-sdk/pull/172))
* [FIX][web] IndexedDB input notes are now keyed by their details commitment instead of their note id, matching the SQLite store. A partial (metadata-less) note that is later completed with its note id now updates the same row instead of creating a duplicate. ([#172](https://github.com/0xMiden/web-sdk/pull/172), companion: [0xMiden/miden-client#2214](https://github.com/0xMiden/miden-client/pull/2214))
* [FIX][web] `miden-idxdb-store` now preserves the fungible-asset `AssetCallbackFlag` when replaying a public-account vault delta during sync. Dropping it made the recomputed vault root diverge from the transaction kernel's (a `ConflictingRoots` error) for callback-bearing assets (e.g. agglayer / B2AGG). Mirrors the SQLite-store fix in [0xMiden/miden-client#2225](https://github.com/0xMiden/miden-client/pull/2225). ([#172](https://github.com/0xMiden/web-sdk/pull/172))
* [FIX][web] `AccountVaultDelta.addedFungibleAssets()` / `removedFungibleAssets()` now preserve a fungible asset's `AssetCallbackFlag` when rebuilding it from a vault-delta entry, instead of dropping it. The flag is part of the asset's vault-key and value encoding, so callback-bearing assets (e.g. agglayer-minted) were reported without their flag; ordinary assets use the disabled flag where preserving it is a no-op. Companion to the `miden-idxdb-store` sync fix above; mirrors [0xMiden/miden-client#2225](https://github.com/0xMiden/miden-client/pull/2225). ([#174](https://github.com/0xMiden/web-sdk/pull/174))
* [FIX][react] **`MidenProvider` no longer errors out on a fresh wallet when used with `MidenFiSignerProvider`.** When a signer supplies `accountConfig.importAccountId`, `initializeSignerAccount` (`packages/react-sdk/src/utils/signerAccount.ts`) takes a fast path that calls `client.importAccountById(...)`. For a brand-new wallet the account isn't registered on-chain yet, so the call rejects (`miden-client`'s `ClientError::AccountNotFoundOnChain`). The fast path previously rethrew everything except an "already being tracked" message, so this surfaced as an init error and `MidenProvider` rendered its `errorComponent` instead of children — making the whole dApp unusable. That's a catch-22: registering the account on-chain requires building a first transaction, which requires a working dApp. The fast path now tolerates a fresh, not-yet-registered account (detected via the typed `ACCOUNT_NOT_FOUND_ON_CHAIN` error `code` rather than message text), still calls `syncState()`, and returns the account ID, so the provider becomes ready; genuine errors (e.g. real network failures) still propagate. The local client keeps no record of the account until it is registered on-chain and a subsequent `importAccountById(...)` (e.g. on a later provider initialization) succeeds — `syncState()` only refreshes already-tracked accounts, so it does not import the account by ID. Until then `useAccount(accountId)` returns `null`, which is the correct fresh state. Reported in `0xMiden/wallet-adapter#86`. ([#166](https://github.com/0xMiden/web-sdk/pull/166))

## 0.14.11 (2026-06-09)

### Fixes

* [FIX][web] **`JsAccountUpdate` / `JsStorageMapEntry` / `JsStorageSlot` / `JsVaultAsset` no longer crash under Next.js 16.2 dev-mode console patches.** These four wasm-bindgen structs were declared with `#[wasm_bindgen(inspectable)]`, which made the JS bridge auto-emit a `toJSON()` method that reads every `pub` field through a WASM round-trip (`wasm.__wbg_get_<class>_<field>(this.__wbg_ptr)`). Next.js 16.2's dev-mode `clientFileLogger.log` path runs every non-primitive `console.*` argument through `safe-stable-stringify`, which invokes `toJSON()` automatically — firing 11 WASM getter calls per `console.log(update)`. If the underlying pointer had been freed or another WASM call was in flight, the resulting `"null pointer passed to rust"` trap propagated out of the user's `console.log` call site and crashed the caller (originally surfaced by the Lumina team). Dropping `inspectable` on these four structs (none of the other `inspectable` usages in the SDK have public fields, so they were never affected) skips the auto-generated `toJSON()`; `JSON.stringify` and `safe-stable-stringify` now fall back to `{}` (the wasm-bindgen wrapper has no own enumerable data — it's all behind the `__wbg_ptr`). Field access via the named getters is unchanged. Fixes [`miden-client#2183`](https://github.com/0xMiden/miden-client/issues/2183).
* [FIX][web] Fixed `_withInnerWebClient` re-entrant deadlock. Calling any proxied async wasm method on the `inner` client inside the callback — `inner.getInputNote(...)`, `inner.executeTransaction(...)`, `inner.submitProvenTransaction(...)`, `inner.applyTransaction(...)`, etc. — enqueued onto the same `_serializeWasmCall` chain that `_withInnerWebClient` itself had already claimed for the callback, so the inner call would wait for the outer to settle while the outer awaited the inner — classic re-entrant-lock deadlock with no timeout. `_serializeWasmCall` now runs its callback inline when `_withInnerLockDepth > 0` (set/cleared by `_withInnerWebClient` around `await fn(inner)`), so inner calls "borrow" the already-held chain slot instead of trying to re-acquire it; external callers still queue behind the outer slot. This was the load-bearing bug behind the Miden Wallet's `proveLocallyViaOffscreen` consume path hanging indefinitely with local proving enabled on Chrome MV3 (`generateTransaction:consume` reached "acquired tx lock; calling midenClient dispatch" then never logged another marker), which surfaced to users as a "cannot reach the miden node" connectivity banner via downstream `withWasmClientLock` timeouts in the SW's `SyncManager`. SAFETY CONTRACT: re-entrancy assumes the caller holds an external mutex preventing concurrent access via other code paths during `fn` — the wallet's own `withWasmClientLock` discipline satisfies this. See the docstring on `_withInnerWebClient` for details.

## 0.14.10 (2026-05-19)

### Changes

* [CHORE][web] Bumped `miden-client` to `0.14.9` and `miden-vm` crates to `0.22.4`.

## 0.14.9 (2026-05-13)

### Features

* [FEATURE][web] Added `TransactionProver.newCallbackProver(jsFn)` — a JS-callable prover variant whose `prove()` dispatches to a `Function` returning `Promise<Uint8Array>`. Wire format matches `RemoteTransactionProver` (`tx_inputs.to_bytes()` in, `ProvenTransaction::read_from_bytes(..)` out), so a JS-side bridge (e.g. a Capacitor / Tauri / Electron native-prover plugin) slots in behind the existing dispatcher unchanged ([#149](https://github.com/0xMiden/web-sdk/pull/149)).
* [FEATURE][web] Added `ClientOptions.useWorker?: boolean` (default `true`) — opt out of the WebClient's Web Worker shim. The shim serialises the prover via `TransactionProver.serialize()` (format `"local"` / `"remote|{endpoint}"`), which has no encoding for the callback variant — the closure is silently dropped and the worker spawns its own in-process WASM prover. Setting `useWorker: false` skips the shim so the JS function reaches `wasmWebClient.proveTransactionWithProver(...)` with the closure intact. Required for any consumer passing a `newCallbackProver` ([#149](https://github.com/0xMiden/web-sdk/pull/149)).
* [FEATURE][react] Added `MidenConfig.useWorker?: boolean` — mirrors the new `ClientOptions.useWorker` on the React `<MidenProvider>`, plumbed through to both `WebClient.createClient` and `WebClient.createClientWithExternalKeystore` ([#149](https://github.com/0xMiden/web-sdk/pull/149)).

## 0.14.6 (TBA)

### Features

* [FEATURE][web] **Optional multi-threaded WASM proving via dual-build subpaths.** The package now ships TWO WASM artifacts: a single-threaded build at the default subpaths (`@miden-sdk/miden-sdk`, `@miden-sdk/miden-sdk/lazy`) that loads in any browser context, and a multi-threaded build at the new `@miden-sdk/miden-sdk/mt` and `@miden-sdk/miden-sdk/mt/lazy` subpaths that uses wasm-bindgen-rayon for ~3–5× faster proving on cross-origin-isolated pages. Default (ST) behavior is unchanged from v0.14.2 — existing consumers keep working in non-COI contexts with no migration needed. Consumers who want the speedup opt in by importing the `/mt` subpath; they're then responsible for running on a page with `SharedArrayBuffer` + `crossOriginIsolated` (COOP=`same-origin` + COEP=`require-corp` HTTP headers, or the equivalent in a Chrome extension manifest). The MT build re-exports `initThreadPool(n)` which consumers must `await` once before any prove, sized to `navigator.hardwareConcurrency`. PR CI builds ST only via the `MIDEN_FAST_BUILD` flag for ~15-min validation; release CI builds both for the published artifact.
* [FEATURE][web] Added `MidenClient._withInnerWebClient(fn)` escape hatch that runs `fn` with exclusive access to the proxied JS WebClient. Lets framework wrappers split the bundled prove pipeline — for example, dispatching the prove step to a `chrome.offscreen` document or a Web Worker while keeping execute / submit / apply on the main `MidenClient` — without re-implementing the resource-based surface from scratch. The callback runs inside `_serializeWasmCall`, so the WASM RefCell is held for the duration of `fn` and concurrent SDK calls queue safely. Marked private (`_` prefix) and may iterate; pin the SDK version if you depend on it.
* [FEATURE][web] Added `"custom"` operation to `preview()` so users can dry-run any pre-built `TransactionRequest`, not just send/mint/consume/swap ([#2052](https://github.com/0xMiden/miden-client/pull/2052)).

### Fixes

* [FIX][react] Fixed `useConsume({ notes: [hexString] })` crashing with `null pointer passed to rust`. Surfaced when consuming notes against accounts built with `withNoAuthComponent()` ([#138](https://github.com/0xMiden/web-sdk/pull/138)).
* [FIX][react] Fixed `useMultiSend` crashing with `null pointer passed to rust` whenever any recipient used `NoteType.Private`. The `NoteArray` constructor was moving each output's `Note` handle, leaving it unusable for the post-commit `sendPrivateNote` delivery loop ([#138](https://github.com/0xMiden/web-sdk/pull/138)).
* [FIX][react] Fixed `transactionId` (and `txId`) in hook return values being `"[object Object]"` instead of a hex string. `useTransaction`, `useConsume`, `useMint`, `useSwap`, `useSend`, and `useMultiSend` were calling `.toString()` on the WASM `TransactionId` — which has no `toString` binding and so fell through to `Object.prototype.toString`. Switched all six hooks to `.toHex()`, the actual exposed method. The unit-test mock used to mirror the bug (its `.toString()` returned the hex), masking the regression; the mock now matches real WASM behavior so a future regression would fail the suite ([#83](https://github.com/0xMiden/web-sdk/issues/83)).

### Chores

* [CHORE][ci] Auto-cut a GitHub release when a `patch release`-labeled PR merges to `main`. Mirrors the existing `next`-branch flow: once the release publishes, `publish-web-sdk.yml` ships every package whose version actually changed to the `latest` dist-tag with provenance.

## 0.14.2 (2026-04-15)

### Features

* [FEATURE][web] Added `compile.noteScript({ code, libraries? })` to `MidenClient`, filling the gap left on the resource-based surface for note-script compilation. Mirrors the existing `compile.txScript` shape ([#2044](https://github.com/0xMiden/miden-client/pull/2044)).
* [FEATURE][web] Exported the `CompilerResource` class so framework wrappers (e.g. React hooks) can instantiate the compile surface over a `WasmWebClient` proxy without wrapping the full `MidenClient`. The third constructor argument is now optional ([#2044](https://github.com/0xMiden/miden-client/pull/2044)).

### Fixes

* [FIX][web] Fixed `syncState` deterministically failing with `mmr peaks are invalid: number of one bits in leaves is N which does not equal peak length M` after importing a private note whose inclusion block pre-dates the wallet's current sync height. `get_and_store_authenticated_block` was overwriting the correct historical peaks (written by `applyStateSync`) with peaks from the caller's current `PartialMmr` forest, so subsequent reads at the same block hit the `InvalidPeaks` validation. The IndexedDB `insertBlockHeader` now uses add-if-not-exists semantics, matching the SQLite store's `INSERT OR IGNORE` in `insert_block_header_tx` ([#2039](https://github.com/0xMiden/miden-client/pull/2039)).
* [FIX][web] Fixed WASM worker loading under webpack 5 / Next.js consumers. v0.14.1's single classic worker rewrote `import.meta.url` → `self.location.href` (needed for Safari/WKWebView cold-start performance), which webpack's asset tracer cannot follow — consumers hit a 404 on `miden_client_web.wasm` and the SDK silently fell back to a main-thread mode that hung on `sync()`. The SDK now ships BOTH variants (`web-client-methods-worker.js` classic for Safari, `web-client-methods-worker.module.js` ES module for webpack/Vite/Parcel) and `WebClient` picks at runtime via UA detection, configurable via the new `WebClient.workerMode` (`"auto"` / `"module"` / `"classic"`) static. No consumer config changes needed for auto ([#2046](https://github.com/0xMiden/miden-client/issues/2046)).

## 0.14.1 (2026-04-14)

### Fixes

* [FIX][web] Fixed `syncState` failure ("inconsistent partial mmr: tracked leaf at position N has no value in nodes") caused by skipping authentication node collection for blocks already tracked from the MMR delta during large catch-up syncs. Authentication nodes are now always collected for note-relevant blocks regardless of prior tracking state. ([#1997](https://github.com/0xMiden/miden-client/pull/1997)).
* [FIX][web] Fixed `transactions.send({ returnNote: true })` throwing `expected instance of NoteArray`. The JS wrapper was still building `OutputNoteArray` after the WASM binding for `withOwnOutputNotes` switched to `NoteArray` ([#2011](https://github.com/0xMiden/miden-client/issues/2011)).

## 0.14.0 (2026-04-07)

### Enhancements

* [FEATURE][web] Added `StorageView` JS wrapper over WASM `AccountStorage`. `account.storage()` now returns a `StorageView` that makes `getItem()` work intuitively for both Value and StorageMap slots. WASM primitives are unchanged; the raw `AccountStorage` is accessible via `.raw` ([#1955](https://github.com/0xMiden/miden-client/pull/1955)).
* [FEATURE][web] Added `wordToBigInt()` utility export for losslessly converting a `Word`'s first felt to a `BigInt`. `StorageResult.toString()` is BigInt-backed, and `valueOf()` returns a JS number for values fitting in `Number.MAX_SAFE_INTEGER` and throws `RangeError` for larger u64 values — use `.toBigInt()` for exact access ([#1955](https://github.com/0xMiden/miden-client/pull/1955)).
* [FEATURE][web] WebClient now automatically syncs state before account creation when the client has never been synced, preventing a slow full-chain scan on the next sync (#1704).
* [FEATURE][web] Added `getAccountProof` method to the web client's `RpcClient`, allowing lightweight retrieval of account header, storage slot values, and code via a single RPC call. Refactored the `NodeRpcClient::get_account_proof` signature to allow requesting just private account proofs ([#1794](https://github.com/0xMiden/miden-client/pull/1794), [#1814](https://github.com/0xMiden/miden-client/pull/1814)).
* [BREAKING][removal][web] Removed `addAccountSecretKeyToWebStore`, `getAccountAuthByPubKeyCommitment`, `getPublicKeyCommitmentsOfAccount`, and `getAccountByKeyCommitment` from `WebClient`. Use the new `client.keystore` sub-object instead (e.g. `client.keystore.insert()`, `client.keystore.get()`, `client.keystore.getCommitments()`, `client.keystore.getAccountId()` + `client.getAccount()`). ([#1947](https://github.com/0xMiden/miden-client/pull/1947)).

### Changes

* [BREAKING][arch][web] Replaced the `WebClient` class with a new `MidenClient` resource-based API as the primary web SDK entry point. `WebClient` is still available as `WasmWebClient` for low-level access but is no longer part of the public API. All documentation has been updated to use `MidenClient`. Migration: replace `WebClient.createClient(rpcUrl, noteTransportUrl, seed, storeName)` with `MidenClient.create({ rpcUrl, noteTransportUrl, seed, storeName })`, and replace direct method calls (e.g. `client.newWallet(...)`, `client.submitNewTransaction(...)`, `client.getAccounts()`) with resource methods (e.g. `client.accounts.create()`, `client.transactions.send(...)`, `client.accounts.list()`). ([#1762](https://github.com/0xMiden/miden-client/pull/1762)).
* [BREAKING][type][web] `AccountId.fromHex()` now returns `Result` (throws on invalid hex) instead of silently panicking via `unwrap()`. ([#1762](https://github.com/0xMiden/miden-client/pull/1762)).
* [BREAKING][type][web] `AuthSecretKey.getRpoFalcon512SecretKeyAsFelts()` and `getEcdsaK256KeccakSecretKeyAsFelts()` now return `Result<Vec<Felt>, JsValue>` instead of panicking on key type mismatch ([#1833](https://github.com/0xMiden/miden-client/pull/1833)).

### Features

* [FEATURE][web] New `MidenClient` class with resource-based API (`client.accounts`, `client.transactions`, `client.notes`, `client.tags`, `client.settings`). Provides high-level transaction helpers (`send`, `mint`, `consume`, `swap`, `consumeAll`), transaction dry-runs via `preview()`, confirmation polling via `waitFor()`, and flexible account/note references that accept hex strings, bech32 strings, or WASM objects interchangeably (`AccountRef`, `NoteInput` types). Factory methods: `MidenClient.create()`, `MidenClient.createTestnet()`, `MidenClient.createMock()`. ([#1762](https://github.com/0xMiden/miden-client/pull/1762))
* [FEATURE][web] Added `TransactionId.fromHex()` static constructor for creating transaction IDs from hex strings. ([#1762](https://github.com/0xMiden/miden-client/pull/1762))
* [FEATURE][web] Added standalone tree-shakeable note utilities (`createP2IDNote`, `createP2IDENote`, `buildSwapTag`) usable without a client instance. ([#1762](https://github.com/0xMiden/miden-client/pull/1762))
* [FEATURE][web] SDK ergonomics: `accounts.getOrImport(ref)` convenience method, `accounts.import()` accepts full `AccountRef`, `transactions.send()` return type changed to `SendResult` with optional `returnNote`, notes API simplified (`listAvailable` returns `InputNoteRecord[]`, `consume` accepts `Note` objects), `MidenClient.create()` accepts rpcUrl/proverUrl shorthands.
* [BREAKING][FEATURE][web] Custom contract support: `accounts.create()` with `ImmutableContract`/`MutableContract` types, new `client.compile` resource (`compile.component()`, `compile.txScript()` with `"dynamic"`/`"static"` linking), and `transactions.execute({ account, script, foreignAccounts? })` for custom script execution with FPI. `transactions.send()` return type changed. ([#1828](https://github.com/0xMiden/miden-client/pull/1828))
* [FEATURE][web] Account import improvements: `accounts.getOrImport(ref)` convenience method, and `accounts.import()` now accepts full `AccountRef` (string, `AccountId`, `Account`, `AccountHeader`) in addition to `{ file }` and `{ seed }` forms. ([#1828](https://github.com/0xMiden/miden-client/pull/1828))
* [FEATURE][web] Added `AccountId.fromPrefixSuffix(prefix, suffix)` constructor for building an `AccountId` from its two felt components, useful when prefix/suffix are stored separately in storage maps. ([#1889](https://github.com/0xMiden/miden-client/pull/1889))
* [FEATURE][web] Added `TransactionRequestBuilder.withExpirationDelta()` for expiring manual transaction requests ([#1904](https://github.com/0xMiden/miden-client/pull/1904))
* [FEATURE][web] Added `accounts.insert({ account, overwrite? })` to `MidenClient` for inserting pre-built `Account` objects into the local store. Enables external signer integrations that build accounts via `AccountBuilder` with custom auth commitments ([#1922](https://github.com/0xMiden/miden-client/pull/1922)).
* [FEATURE][web] Exposed `executeProgram` (view call) to the JS side, allowing local execution of a transaction script against an account and inspection of the 16-element stack output without submitting to the network. Added `AdviceInputs` constructor and reverse `From` conversions. ([#1859](https://github.com/0xMiden/miden-client/issues/1859))
* [FEATURE][web] Added `client.keystore` sub-object API for managing secret keys. Methods: `insert(accountId, secretKey)`, `get(pubKeyCommitment)`, `remove(pubKeyCommitment)`, `getCommitments(accountId)`, `getAccountId(pubKeyCommitment)`. Also available on `MidenClient` as a resource (`client.keystore`). ([#1947](https://github.com/0xMiden/miden-client/pull/1947))

### Fixes

* [FIX][web] Replaced `.unwrap()` panics with proper `Result` returns in `MerklePath.computeRoot()`, `NoteExecutionHint.fromParts()`, `NoteExecutionHint.canBeConsumed()`, `NoteStorage` constructor, and `TransactionStatus.discarded()` WASM bindings ([#1870](https://github.com/0xMiden/miden-client/pull/1870)).
* [FIX][web] Fixed the error `TypeError: parameter 1 is not of type 'ArrayBuffer'` when re-initializing a client with an imported database. `Uint8Array` fields (e.g. the client version setting) were exported as plain arrays and not restored to `Uint8Array` on import, causing `TextDecoder.decode()` to fail. Export now tags `Uint8Array` values for correct round-trip. ([#1952](https://github.com/0xMiden/miden-client/pull/1952))

## 0.13.4 (2026-03-23)

* [FIX][rust,web] Fixed storage map slots with duplicate roots losing their entries after a store round-trip, which corrupted the storage commitment ([#1915](https://github.com/0xMiden/miden-client/pull/1915)).

## 0.13.3 (2026-03-16)

* [FIX][rust,web] Fixed `sync_state()` invoking the external signer (e.g. wallet extension) during note consumability checks, causing repeated confirmation popups on every sync cycle. `NoteScreener` no longer attaches the `TransactionAuthenticator` when trial-executing consume transactions; accounts requiring auth now return `ConsumableWithAuthorization` instead ([#1905](https://github.com/0xMiden/miden-client/pull/1905)).
* [FIX][web] Fixed `PrematureCommitError` crash during `syncState()` by moving all IndexedDB writes into a single Dexie transaction instead of spawning competing inner transactions ([#1876](https://github.com/0xMiden/miden-client/pull/1876)).
* [FEATURE][web] Exposed `getAccountProof` in the `RpcClient`, accepting optional `AccountStorageRequirements` and block number parameters to fetch specific storage maps without full account reconstruction ([#1917](https://github.com/0xMiden/miden-client/pull/1917)).
* [FEATURE][web] Exposed `syncStorageMaps` in the `RpcClient` for paginated retrieval of large storage maps ([#1917](https://github.com/0xMiden/miden-client/pull/1917)).

## 0.13.2 (2026-02-26)

* [FIX][web] Added missing `attachment()` getter to `NoteMetadata` WASM binding ([#1810](https://github.com/0xMiden/miden-client/pull/1810)).
* [FIX][web] Fixed transaction execution failures after reopening a browser extension by always persisting MMR authentication nodes during sync, even for blocks with no relevant notes. Previously, closing and reopening the extension lost in-memory MMR state and the store was missing nodes needed for Merkle authentication paths. Also surfaces a distinct `PartialBlockchainNodeNotFound` error instead of a confusing deserialization crash when nodes are missing ([#1789](https://github.com/0xMiden/miden-client/pull/1789)).

## 0.13.1 (2026-02-13)

* [FEATURE][web] Added `setupLogging(level)` and `logLevel` parameter on `createClient` to route Rust tracing output to the browser console with configurable verbosity ([#1669](https://github.com/0xMiden/miden-client/pull/1669)).
* [FEATURE][web] Added 3-layer concurrency safety for WASM access: in-tab async lock, cross-tab IndexedDB lock, and auto-sync on cross-tab state changes ([#1784](https://github.com/0xMiden/miden-client/pull/1784)).
