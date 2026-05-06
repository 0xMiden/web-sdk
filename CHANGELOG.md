# Changelog

## 0.14.4 (TBA)

### Features

* [FEATURE][web] **Optional multi-threaded WASM proving via dual-build subpaths.** The package now ships TWO WASM artifacts: a single-threaded build at the default subpaths (`@miden-sdk/miden-sdk`, `@miden-sdk/miden-sdk/lazy`) that loads in any browser context, and a multi-threaded build at the new `@miden-sdk/miden-sdk/mt` and `@miden-sdk/miden-sdk/mt/lazy` subpaths that uses wasm-bindgen-rayon for ~3–5× faster proving on cross-origin-isolated pages. Default (ST) behavior is unchanged from v0.14.2 — existing consumers keep working in non-COI contexts with no migration needed. Consumers who want the speedup opt in by importing the `/mt` subpath; they're then responsible for running on a page with `SharedArrayBuffer` + `crossOriginIsolated` (COOP=`same-origin` + COEP=`require-corp` HTTP headers, or the equivalent in a Chrome extension manifest). The MT build re-exports `initThreadPool(n)` which consumers must `await` once before any prove, sized to `navigator.hardwareConcurrency`. PR CI builds ST only via the `MIDEN_FAST_BUILD` flag for ~15-min validation; release CI builds both for the published artifact.
* [FEATURE][web] Added `MidenClient._getInnerWebClient()` escape hatch returning the underlying `WasmWebClient` instance. Lets framework wrappers split the bundled prove pipeline — for example, dispatching the prove step to a `chrome.offscreen` document or a Web Worker while keeping execute / submit / apply on the main `MidenClient` — without re-implementing the resource-based surface from scratch. Marked private (`_` prefix) and may iterate; pin the SDK version if you depend on it.
* [FEATURE][web] Added `"custom"` operation to `preview()` so users can dry-run any pre-built `TransactionRequest`, not just send/mint/consume/swap ([#2052](https://github.com/0xMiden/miden-client/pull/2052)).

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
