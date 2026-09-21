---
name: wasm-bridge
description: Enforce conventions for the Rust<->JavaScript WASM boundary in the web-sdk repo (crate miden-client-web at crates/web-client, split out of miden-client). Use when exposing Rust methods to JS via the #[js_export] proc-macro, creating newtype wrappers, handling errors across the boundary with JsErr, bridging JS Promises to Rust Futures, working on the Web Worker shim or its message vocabulary, or layering the public MidenClient resource API on top of the WASM-bound WebClient.
---

# WASM Bridge Patterns (web-client / miden-client-web)

The web client lives in the dedicated **web-sdk** repo
(`github.com/0xMiden/web-sdk`), split out of `miden-client`. The Rust<->JS
boundary crate is `crates/web-client` (cargo package `miden-client-web`,
`crate-type = ["cdylib"]`). The whole Rust inventory, with the crate types that
explain what each one is for:

| Path | Package | `crate-type` | Role |
|---|---|---|---|
| `crates/web-client` | `miden-client-web` | `cdylib` | the Rust<->JS boundary; this skill |
| `crates/idxdb-store` | `miden-idxdb-store` | `cdylib`, `rlib` | the IndexedDB store (`rlib` so web-client can depend on it) |
| `crates/js-export-macro` | `js-export-macro` | `proc-macro = true` | the `#[js_export]` proc-macro |
| `crates/mobile-prover` | `miden-mobile-prover` | `cdylib`, `staticlib` | native C-ABI prover for iOS/Android Capacitor plugins (`staticlib` for iOS, `cdylib` for Android) |
| `tools/strip-masp-debug` | `strip-masp-debug` | binary (default) | strips MASM debug metadata from release WASM |

The crate dual-targets two binding technologies from one Rust source:
- **browser** (the `browser` feature) via `wasm_bindgen`, error type `JsValue`
- **Node.js** (the `nodejs` feature) via `napi` / `napi-derive`, error type
  `napi::Error`

A platform abstraction layer in `crates/web-client/src/platform.rs` provides
type aliases and helpers so most code is written once. Key aliases:

- `JsErr`: the platform error type (`wasm_bindgen::JsValue` on browser,
  `napi::Error` on nodejs). `from_str_err(msg: &str) -> JsErr` builds one from a
  string, and `from_str_err_with_code(msg: &str, code: &str) -> JsErr` builds one
  carrying a stable machine-readable `code` (see
  [Error Handling](#error-handling-across-the-boundary)).
- `JsU64`: `u64` on browser, `napi::bindgen_prelude::BigInt` on nodejs; both
  surface as a JS `BigInt`. Convert with `js_u64_to_u64` / `u64_to_js_u64`.
- `JsBytes`: `js_sys::Uint8Array` on browser, `napi::bindgen_prelude::Buffer`
  on nodejs. Convert with `bytes_to_js` / `js_to_bytes` (`js_to_bytes` is
  platform-agnostic; only `bytes_to_js` splits).
- `AsyncCell<T>`: interior mutability, `RefCell` on browser,
  `tokio::sync::Mutex` on nodejs; `.lock().await` yields a `DerefMut` guard.
  The browser branch additionally exposes a **synchronous** shared borrow,
  `.borrow() -> std::cell::Ref<'_, T>` (`platform.rs:107-111`). It exists for
  `#[wasm_bindgen(getter)]` members, which cannot be async, and it is sound
  only because that branch is single-threaded. There is no nodejs equivalent,
  so a method that needs it is browser-only by construction.
- `maybe_wrap_send`: a pass-through on browser (`platform.rs:176-180`); on
  nodejs it wraps the future in an `AssertSend` newtype carrying
  `unsafe impl<F> Send for AssertSend<F>` so napi's multi-threaded tokio
  runtime accepts it (`platform.rs:187-202`). The assertion is sound because
  the concrete types behind the trait objects (`SqliteStore`, `GrpcClient`,
  `FilesystemKeyStore`) are all `Send + Sync`; only the `dyn Trait` bounds lack
  `Send`. Box a client future and wrap it with `maybe_wrap_send` before
  `.await` in any dual-platform method - `new_transactions.rs` does this at
  every call site.
- `ClientAuth`: the platform keystore type the inner client is generic over.
  `WebClient` holds an `AsyncCell<Option<Client<ClientAuth>>>`, so write
  `Client<ClientAuth>` rather than naming a concrete keystore, and reach the
  keystore itself through `self.get_keystore().await`.

## Exposing Rust Methods to JavaScript

### Method Annotation - `#[js_export]`

The public API is exposed with the custom `#[js_export]` proc-macro from the
`js-export-macro` crate, **not** raw `#[wasm_bindgen]`. `#[js_export]` generates
the dual `wasm_bindgen` (browser) and `napi` (Node.js) annotations from one
attribute, forwarding `constructor` / `js_name` / `getter`. When a signature
contains `JsU64`, the macro splits the impl per platform, replacing `JsU64` with
`u64` (browser) or `BigInt` (nodejs), so `JsU64` is resolved by the macro and
does not need to be imported in the annotated module. Raw `#[wasm_bindgen]` is
reserved for browser-only members (e.g. synchronous getters that cannot be async).

Apply `#[js_export]` to the struct/enum/impl block, and `#[js_export(js_name =
"camelCase")]` to each method to map snake_case Rust to camelCase JS:

```rust
use js_export_macro::js_export;

use crate::models::account_header::AccountHeader;
use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    #[js_export(js_name = "getAccounts")]
    pub async fn get_accounts(&self) -> Result<Vec<AccountHeader>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized"))?;

        let result = client
            .get_account_headers()
            .await
            .map_err(|err| js_error_with_context(err, "failed to get accounts"))?;

        Ok(result.into_iter().map(|(header, _)| header.into()).collect())
    }
}
```

Rules:
- Annotate with `#[js_export]` (struct/impl) and `#[js_export(js_name = ...)]`
  (methods). Use `#[js_export(constructor)]` for constructors,
  `#[js_export(getter)]` for getters. Use raw `#[wasm_bindgen]` only for
  browser-only items.
- Methods take `&self` (the inner client is behind an `AsyncCell`/lock, so no
  `&mut self`). Acquire the client with `let mut guard =
  self.get_mut_inner().await;` then `let client = guard.as_mut().ok_or_else(||
  from_str_err("Client not initialized"))?;`. `get_mut_inner` returns a
  `DerefMut` guard over `Option<Client<ClientAuth>>`.
- Return `Result<T, JsErr>`, never `Result<T, JsValue>` directly, and never
  panic across the boundary.
- Use `.map_err(|err| js_error_with_context(err, "context"))` for all fallible
  client calls.
- Convert return types via `.into()` (implement `From` on wrapper types).

## Error Handling Across the Boundary

### js_error_with_context

Use the `js_error_with_context` helper (in `crates/web-client/src/lib.rs`) to
chain error sources and attach hints. It returns `JsErr` and splits per
platform; the browser branch additionally attaches a stable machine-readable
`code`:

```rust
pub(crate) fn js_error_with_context<T>(err: T, context: &str) -> JsErr
where
    T: Error + 'static,
{
    let error_message = build_error_chain(context, &err);
    let help = hint_from_error(&err);

    #[cfg(feature = "browser")]
    {
        let js_error: JsValue = JsError::new(&error_message).into();
        if let Some(help) = help {
            let _ = Reflect::set(&js_error, &JsValue::from_str("help"), &JsValue::from_str(&help));
        }
        // Stable, machine-readable code for the ClientError variants JS callers
        // branch on, so they don't depend on (changeable) message text.
        if let Some(code) = code_from_error(&err) {
            let _ = Reflect::set(&js_error, &JsValue::from_str("code"), &JsValue::from_str(code));
        }
        js_error
    }

    #[cfg(feature = "nodejs")]
    {
        let message = match help {
            Some(help) => format!("{error_message} [help: {help}]"),
            None => error_message,
        };
        napi::Error::from_reason(message)
    }
}
```

This:
1. Chains all error sources into one message via `build_error_chain(context,
   &err)` (walks `err.source()`, writing `context: err1: err2: ...`).
2. Extracts an `ErrorHint` from `ClientError` via `hint_from_error` if available.
3. Browser path: attaches `help` (the hint) and `code` (from `code_from_error`,
   which maps the few `ClientError` variants JS callers branch on, e.g.
   `ACCOUNT_NOT_FOUND_ON_CHAIN`, `ACCOUNT_ALREADY_TRACKED`) as properties on the
   JS `Error` via `Reflect::set`.
4. Node.js path: returns `napi::Error::from_reason(...)` with the help inlined
   into the message.

### The named error codes

JS callers branch on a `code`, never on message text, so the vocabulary is a
public contract. Two primitives produce one, and between them they emit exactly
four codes today:

| Code | Produced by | Raised when |
|---|---|---|
| `ACCOUNT_NOT_FOUND_ON_CHAIN` | `code_from_error` (`lib.rs:672-682`) | `ClientError::AccountNotFoundOnChain` |
| `ACCOUNT_ALREADY_TRACKED` | `code_from_error` | `ClientError::AccountAlreadyTracked` |
| `TRANSACTION_ALREADY_AUTHORIZED` | `from_str_err_with_code` | `executeForSummary` / `executeForSummaryAt` produced no summary because the transaction was already fully authorized (`new_transactions.rs:611`, `:649`) |
| `INVALID_CHAIN_ANCHOR` | `from_str_err_with_code` | `ClientError::ChainAnchorError`, routed through `map_anchor_err` (`new_transactions.rs:910`) |

`code_from_error` recurses through `err.source()`, so a code survives being
wrapped. It maps typed `ClientError` variants only, and is reachable **only**
from inside `js_error_with_context`.

### Adding a new machine-readable code

For an error you construct yourself, use
`from_str_err_with_code(msg, "SOME_CODE")` from `platform.rs:33-51` rather than
`from_str_err` plus a hand-rolled `Reflect::set`: it is the only helper that
sets a code on both platforms. The browser branch attaches a real `code`
property; napi's error `code` is its fixed `Status` enum (always
`GenericFailure` here), so the nodejs branch prefixes the message as
`"<CODE>: <message>"` instead. Consumers must handle both spellings. Treat a
published code as API and keep the two branches in step. The worker shim's
`serializeError` forwards both `code` and `help` across the worker boundary
(`js/workers/web-client-methods-worker.js:29-42`).

### Error Pattern in Every Method

```rust
client
    .some_operation()
    .await
    .map_err(|err| js_error_with_context(err, "failed to <describe operation>"))?;
```

The context string should be lowercase and describe the failed operation. For
the not-initialized guard, build the error with `from_str_err("Client not
initialized")` (the platform helper), not `JsValue::from_str(...)`.

## Newtype Wrappers

### Pattern

Wrap native Miden types in thin newtypes for JS exposure, annotated with
`#[js_export]`. Fallible construction returns `Result<Self, JsErr>`:

```rust
use js_export_macro::js_export;
use miden_client::{Felt as NativeFelt, Word as NativeWord};
use crate::platform::{JsBytes, JsErr, from_str_err, js_u64_to_u64, u64_to_js_u64};

#[derive(Clone)]
#[js_export]
pub struct Word(NativeWord);

#[js_export]
impl Word {
    #[js_export(constructor)]
    pub fn new(u64_vec: Vec<JsU64>) -> Result<Word, JsErr> {
        if u64_vec.len() != 4 {
            return Err(from_str_err(&format!(
                "Word requires exactly 4 elements, got {}",
                u64_vec.len()
            )));
        }
        let fixed_array_u64: [u64; 4] = u64_vec
            .into_iter()
            .map(js_u64_to_u64)
            .collect::<Vec<u64>>()
            .try_into()
            .expect("length checked above");
        let native_felt_vec: [NativeFelt; 4] = fixed_array_u64
            .iter()
            .map(|&v| NativeFelt::new(v)) // fallible: rejects non-canonical input
            .collect::<Result<Vec<NativeFelt>, _>>()
            .map_err(|err| from_str_err(&format!("invalid field element: {err}")))?
            .try_into()
            .expect("length checked above");
        Ok(Word(native_felt_vec.into()))
    }

    #[js_export(js_name = "fromHex")]
    pub fn from_hex(hex: String) -> Result<Word, JsErr> {
        let native_word = NativeWord::try_from(hex.as_str())
            .map_err(|err| from_str_err(&format!("Error instantiating Word from hex: {err}")))?;
        Ok(Word(native_word))
    }
}
```

Notes:
- `JsU64` (BigInt-aware) is used for numeric inputs, not `u64`, so full 64-bit
  precision survives the JS `Number`/`BigInt` boundary. The `#[js_export]` macro
  rewrites `JsU64` per platform, so it is referenced unqualified and is not
  imported alongside the `js_u64_to_u64` / `u64_to_js_u64` converters.
- Constructors that can fail (length checks, fallible `Felt::new`) return
  `Result<_, JsErr>`; do not paper over failures with `.unwrap()`.
- `from_hex` takes `String` (not `&str`) and returns `Result<Word, JsErr>`.

### `Felt` on the JS side vs. the Rust side

The Rust `Felt` newtype (`crates/web-client/src/models/felt.rs:10-37`) is
`Felt(NativeFelt)` with `pub fn new(value: JsU64) -> Result<Felt, JsErr>`,
`as_int() -> JsU64` and `to_string() -> String`. On the JS side that surfaces
as a class taking a single **`BigInt`** - not a number, and not an array:

```javascript
const felt = new Felt(42n);        // BigInt argument; throws on non-canonical values
const value = felt.asInt();        // BigInt back out
const felts = word.toFelts();      // Felt[] from a Word
const word = Word.newFromFelts([f0, f1, f2, f3]);
```

**Passing a JS `Number` where a `JsU64` is expected is a boundary bug**, not a
convenience. Every `JsU64` parameter and return is a `BigInt` in JS on both
platforms, and a `Number` silently loses precision above 2^53 on the browser
side while failing outright against napi's `BigInt`.

### Required Conversions and Accessors

Implement the `From` conversions, and put the internal `as_native` accessor in a
**plain** `impl` block (not under `#[js_export]`, since it is `pub(crate)`):

```rust
impl Word {
    pub(crate) fn as_native(&self) -> &NativeWord {
        &self.0
    }
}

// Native -> Wrapper (by value and by ref)
impl From<NativeWord> for Word {
    fn from(native_word: NativeWord) -> Self { Word(native_word) }
}
impl From<&NativeWord> for Word {
    fn from(native_word: &NativeWord) -> Self { Word(*native_word) }
}

// Wrapper -> Native (by value and by ref)
impl From<Word> for NativeWord {
    fn from(word: Word) -> Self { word.0 }
}
impl From<&Word> for NativeWord {
    fn from(word: &Word) -> Self { word.0 }
}
```

For wrapper newtypes that must be accepted as by-value or `Vec<T>` parameters on
the Node.js side, also invoke `impl_napi_from_value!(Word);` (defined in
`crates/web-client/src/miden_array.rs`; a no-op under the `browser` feature). It
bridges napi-rs v3's missing `FromNapiValue` for `#[napi]` class types.

### Factory Methods

Provide `fromHex()`-style constructors that return `Result<Self, JsErr>` for
user-facing types.

### Keeping the JS API stable across an upstream rename

When an upstream Rust API is renamed or its semantics change, keep the JS name
and adapt inside the wrapper rather than breaking JS callers.
`crates/web-client/src/models/account_builder.rs` is the model:

- `AccountBuilder::build()` calls upstream `build_with_schema_commitment()`
  (`account_builder.rs:100-112`), so the default JS `build()` merges the
  storage-schema-commitment component. `buildWithoutSchemaCommitment()` is
  exposed for the legacy behaviour (`:115-127`).
- `withAuthComponent` is a **back-compat shim**: its body is
  `self.0 = self.0.clone().with_component(account_component)`
  (`account_builder.rs:80-86`). Upstream removed `with_auth_component` and now
  identifies the auth component by its `@auth_script` MASM attribute, so
  forwarding to the plain `with_component` is correct - not a shortcut. Keep
  the JS method; do not "clean it up" into a direct `with_component` call at
  the call sites.
- `accountType()` and `storageMode()` are last-write-wins on the same
  underlying 2-way flag, because protocol 0.15 collapsed `AccountStorageMode`
  and `AccountType` into one. `accountType()` is kept purely for JS-surface
  back-compat (`account_builder.rs:53-72`).

When an upstream type is **added** rather than replaced, wrap both and keep
them. `models/account_patch/{mod,storage,vault}.rs` wrap `AccountPatch` /
`AccountStoragePatch` / `AccountVaultPatch` (the absolute post-transaction
state), while `models/account_delta/` survives because
`TransactionSummary.accountDelta()` still returns an `AccountDelta`
(`models/transaction_summary.rs:35-37`). Both directories coexist
deliberately - do not delete one as "superseded".

> **Only the vault half of `AccountDelta` is relative.** Its doc comment
> (`models/account_delta/mod.rs:10-16`) is explicit: `storage` is an
> `AccountStoragePatch` holding the **absolute** final values of changed
> storage slots ("storage changes have identical semantics in the delta and
> patch models"), and only `vault` is an `AccountVaultDelta` carrying relative
> changes. `account_delta/` has no `storage.rs`; it imports
> `crate::models::account_patch::storage::AccountStoragePatch` directly. Do not
> describe `AccountDelta` as wholly relative, and do not add a parallel
> storage-delta type.

## Data Transfer Objects

For complex data that crosses the WASM boundary, use a dual-platform
`getter_with_clone` / `napi(object)` struct (gated with `cfg_attr`), and map
field names with browser-side `js_name`:

```rust
#[cfg_attr(feature = "browser", wasm_bindgen(getter_with_clone, inspectable))]
#[cfg_attr(feature = "nodejs", napi(object))]
#[derive(Clone)]
pub struct StorageMapEntry {
    #[cfg_attr(feature = "browser", wasm_bindgen(js_name = "root"))]
    pub root: String,
    #[cfg_attr(feature = "browser", wasm_bindgen(js_name = "key"))]
    pub key: String,
    #[cfg_attr(feature = "browser", wasm_bindgen(js_name = "value"))]
    pub value: String,
}
```

Rules:
- Use the dual-platform `#[cfg_attr(feature = "browser", wasm_bindgen(...))]` +
  `#[cfg_attr(feature = "nodejs", napi(object))]` form, never a bare
  `#[wasm_bindgen(getter_with_clone)]`.
- `getter_with_clone` auto-generates JS getters; `inspectable` improves console
  inspection. `inspectable` can also stand alone (without `getter_with_clone`)
  on an opaque wrapper class, again via the dual form `#[cfg_attr(feature =
  "browser", wasm_bindgen(inspectable))]` + `#[cfg_attr(feature = "nodejs",
  napi)]` (note: bare `napi`, not `napi(object)`, for a class that wraps a
  native handle rather than a plain-data object).
- Field names: snake_case in Rust, camelCase via browser-side `js_name`.
- Serialize complex values to hex strings or `JsBytes`/`Vec<u8>` where needed.

## Promise Handling (idxdb-store pattern)

When calling JS functions from Rust that return Promises (the IndexedDB store,
in `crates/idxdb-store`), use these helpers (`crates/idxdb-store/src/promise.rs`):

```rust
/// Awaits a JavaScript Promise and returns the raw JsValue.
pub(crate) async fn await_js_value(promise: Promise, ctx: &str) -> Result<JsValue, StoreError> {
    JsFuture::from(promise)
        .await
        .map_err(|js_error| StoreError::DatabaseError(format!("{ctx}: {js_error:?}")))
}

/// Awaits a JavaScript Promise and deserializes into T.
pub(crate) async fn await_js<T>(promise: Promise, ctx: &str) -> Result<T, StoreError>
where
    T: DeserializeOwned,
{
    let js_value = await_js_value(promise, ctx).await?;
    from_value(js_value)
        .map_err(|err| StoreError::DatabaseError(format!("failed to deserialize ({ctx}): {err:?}")))
}

/// Awaits a JavaScript Promise and discards the result.
pub(crate) async fn await_ok(promise: Promise, ctx: &str) -> Result<(), StoreError> {
    let _ = await_js_value(promise, ctx).await?;
    Ok(())
}
```

Rules:
- Always provide a context string describing what the await is for.
- Use `await_js::<T>()` when you need to deserialize the result.
- Use `await_ok()` when you only care about success/failure.
- Use `serde_wasm_bindgen::from_value()` for deserialization, not `serde_json`.
  (`Promise` is imported via `wasm_bindgen_futures::js_sys::Promise`.)

## Importing JS Functions from Rust

Declare external JS functions with `#[wasm_bindgen(module = "...")]` (browser /
idxdb-store side):

```rust
#[wasm_bindgen(module = "/src/js/utils.js")]
extern "C" {
    #[wasm_bindgen(js_name = logWebStoreError)]
    fn log_web_store_error(error: JsValue, error_context: alloc::string::String);
}

#[wasm_bindgen(module = "/src/js/schema.js")]
extern "C" {
    /// Opens the database and registers it in the JS registry.
    #[wasm_bindgen(js_name = openDatabase)]
    fn open_database(network: &str, client_version: &str) -> js_sys::Promise;
}
```

Rules:
- Module path is relative to the crate root.
- Function names are snake_case in Rust, mapped via `js_name`.
- Return `js_sys::Promise` for async operations.
- Pass simple types across the boundary: `&str`, `JsValue`, `Vec<u8>`, `u32`.

## JS Wrapper Layer

Two **client** layers sit under `crates/web-client/js/`, alongside supporting
modules that are not themselves a client layer (`asyncLock.js`, `webLock.js`,
`syncLock.js`, `observability.js`, `storageView.js`, `standalone.js`,
`eager.js`, `wasm.js`, `utils.js`, `constants.js`, plus the `workers/` shim and
the `node/` napi compat layer). The two layers are:

1. **`WebClient`** (`js/index.js`): the WASM-bound class re-exported as
   `WasmWebClient` (`export { WebClient as WasmWebClient, MockWebClient as
   MockWasmWebClient, MockWebClient, withSyncLock }`). It wraps the `WebClient`
   Rust struct and adds JS-side concerns:
   - `_serializeWasmCall` queue that linearizes WASM calls (the inner client is
     behind a lock, so the JS side must not interleave async calls).
   - The sync family - `syncState()`, `syncChain()` and `syncNoteTransport()`,
     on both `WebClient` and `MockWebClient`, so six call sites - is wrapped in
     the exported `withSyncLock(dbId, methodId, fn)` helper (`js/syncLock.js`,
     Web Locks via `navigator.locks`, feature-detected with `hasWebLocks`) to
     coalesce concurrent syncs and serialize them across tabs:
     `return await withSyncLock(dbId, methodId, async () =>
     this._serializeWasmCall(...))`.
   - method-classification sets (`SYNC_METHODS`, `READ_METHODS`,
     `WRITE_METHODS`) consumed by the proxy and enforced by
     `scripts/check-method-classification.js`. (`SYNC_METHODS` is a historical
     misnomer; it groups methods safe to bind raw.)
2. **`MidenClient`** (`js/client.js`): the public, resource-based wrapper that
   owns a `WebClient` instance and exposes typed sub-objects: `client.accounts`,
   `client.transactions`, `client.notes`, `client.tags`, `client.settings`,
   `client.compile` (a `CompilerResource`, hence the property is `compile`
   though the file is `compiler.js`), `client.keystore`, and `client.pswap`
   (`PswapResource`, the partial-swap flows). Each resource lives under
   `js/resources/<name>.js`.

`MidenClient` is **not** a Proxy and has no passthrough: a WASM method that no
resource surfaces is reachable only on `WasmWebClient`. `pruneAccountHistory`
is one such method. Adding a method to `index.js`'s classification sets does
not make it appear on `MidenClient`.

`index.js` injects the WASM constructor and the `getWasm` initializer into
`MidenClient` via static fields to break the import cycle:

```javascript
MidenClient._WasmWebClient = WebClient;
MidenClient._MockWasmWebClient = MockWebClient;
MidenClient._getWasmOrThrow = getWasmOrThrow;
```

There is **no** `safe-arrays.js` module. The wasm-bindgen array wrappers are
generated by the `declare_js_miden_arrays!` macro (defined in
`crates/web-client/src/miden_array.rs:41`, invoked in
`crates/web-client/src/models/mod.rs:134-146`), which produces **twelve**
types, in this order: `AccountArray`, `AccountIdArray`, `ForeignAccountArray`,
`NoteRecipientArray`, `NoteArray`, `OutputNoteArray`, `StorageSlotArray`,
`TransactionScriptInputPairArray`, `FeltArray`,
`NoteAndArgsArray`, `NoteDetailsAndTagArray`, `NoteIdAndArgsArray`. Count them
from the macro invocation rather than from any list, including this one - the
set grows.

Their constructor **consumes** its elements. To keep an element usable
afterwards, construct the array empty and `push` by reference instead of
passing elements to the constructor:

```javascript
// NoteArray constructor consumes its elements; use push(&note) to keep
// `note` valid so it can be returned to the caller.
const ownOutputs = new wasm.NoteArray();
ownOutputs.push(note);
```

**Adding a new array wrapper takes three coordinated edits**, because on
Node.js the array wrappers are JS polyfills rather than napi classes, and the
re-export generator cannot discover them:

1. `crates/web-client/src/models/mod.rs` - a new
   `(crate::models::foo::Foo) -> FooArray` line in `declare_js_miden_arrays!`
2. `crates/web-client/js/node/napi-compat.js` - add `"FooArray"` to the
   `names` list in `makeArrayPolyfills()`
3. `crates/web-client/js/node-index.js` - a hand-written
   `export const FooArray = _reexport("FooArray");` in the section above the
   generated block (`pnpm --filter @miden-sdk/miden-sdk gen:node-reexports`
   regenerates only the block below it, and CI's `check:node-reexports` keeps
   that part in lockstep with napi)

Miss step 2 or 3 and the browser build is fine while Node.js fails at import.

### Node entry re-exports and name shadowing

`js/node-index.js` is generated by `crates/web-client/scripts/gen-node-reexports.js`
and CI-checked by `check:node-reexports`. Three names are excluded from
generation - `const MANUAL = new Set(["WebClient", "AccountType", "AuthScheme"])`
(`gen-node-reexports.js:36`) - because plain-JS frozen-object enum consts
shadow the napi classes:

- `WebClient` is re-exported wrapped, as `WasmWebClient`.
- `AccountType` and `AuthScheme` are shadowed by `Object.freeze({...})` consts,
  and for `AuthScheme` the napi class is re-exported **by hand** under the
  non-colliding alias `AuthSchemeNative`
  (`export const AuthSchemeNative = _reexport("AuthScheme")`,
  `js/node-index.js:137`).

The browser entry has the same five frozen consts - `AccountType`,
`AuthScheme`, `NoteVisibility`, `StorageMode`, `Linking`
(`js/index.js:22-47`) - but exposes **no** `AuthSchemeNative` alias, so a
browser consumer who needs the numeric enum has to reach into the wasm
namespace directly.

When you add a JS-side enum const, check whether it collides with a generated
class name and update the generator's `MANUAL` set.

### The Web Worker shim

A Web Worker is spawned **by default**: the `WebClient` constructor takes
`useWorker = true` (`js/index.js:434`), and the shim engages whenever
`this.useWorker && typeof Worker !== "undefined"` (`:450`). The worker runs the
WASM off the main thread. Two knobs govern it:

- **`WebClient.workerMode`** - a static, default `"auto"`, with values
  `"auto" | "module" | "classic"` (`js/index.js:360`). `_shouldUseClassicWorker()`
  (`:368-385`) sniffs `navigator.userAgent`: `Chrome/` or `Chromium/` picks
  module; `AppleWebKit` without either (Safari desktop and iOS, a Capacitor
  WKWebView host) picks classic, because module workers cold-start very slowly
  there; anything else (Firefox, jsdom, node without `navigator`) picks module.
  `"module"` forces the `.module.js` ES-module worker, which webpack 5 /
  Next.js consumers need so the asset tracer can see the WASM URL. `"classic"`
  forces the `.js` classic-script worker. **Set it before the first
  `WebClient.createClient(...)` call** - it is read at construction.
- **`ClientOptions.useWorker: false`** - skips the shim entirely and calls the
  wasm-bindgen `WebClient` on the current thread. **Required for callback
  provers**: the worker boundary serializes the prover with
  `TransactionProver.serialize()`, a format that has no encoding for
  `newCallbackProver(jsFn)` and **silently downgrades it to `"local"`**, so the
  callback never fires (`js/index.js:410-418`). Native iOS/Android plug-in
  provers in Capacitor apps, and any other JS-side prover bridge, therefore
  need `useWorker: false`. It is also the right choice in single-WebView native
  shells (Capacitor, Tauri, Electron preload).

`lastAuthError()` is likewise meaningful **only** with `useWorker: false`: the
sign callback fires against the worker's WASM keystore while the accessor reads
the main-thread instance, which never signed, so under the shim it returns
`null` (`js/client.js:376-381`). On the Node.js binding it always returns
`null`. Consumers that need the signal already require `useWorker: false` for
the callback to be reachable at all.

#### The worker-URL duplication is load-bearing

Both `new Worker(new URL("...", import.meta.url), ...)` call sites in
`js/index.js:467-483` are spelled out literally, and the duplication is
deliberate. **Webpack 5's new-worker detector is purely syntactic**: it only
triggers a proper worker sub-compilation - with asset and chunk tracing into
the Cargo glue and the sibling WASM - when it sees that exact pattern inline.
Hoisting either URL into a variable downgrades detection to a plain "copy file
as asset", and the worker's `await import("./Cargo-*.js")` then 404s because
webpack never emitted a chunk for it. Do not refactor the duplication away, and
do not build the URL from a helper.

#### Message vocabulary and the MT init path

The worker entry is `js/workers/web-client-methods-worker.js`; its message
vocabulary lives in `js/constants.js`, as three frozen objects:

- `WorkerAction`: `INIT`, `INIT_MOCK`, `INIT_THREAD_POOL`, `CALL_METHOD`,
  `EXECUTE_CALLBACK`.
- `CallbackType`: `GET_KEY`, `INSERT_KEY`, `SIGN` - the three keystore
  callbacks the worker hands back to the main thread.
- `MethodName`: the worker-forwarded methods, each with a `_MOCK` twin where
  one exists (`CREATE_CLIENT`, `APPLY_TRANSACTION`, `EXECUTE_TRANSACTION`,
  `EXECUTE_TRANSACTION_AT`, `PROVE_TRANSACTION`, `SUBMIT_NEW_TRANSACTION`,
  `SUBMIT_NEW_TRANSACTION_WITH_PROVER`, `SYNC_STATE`, `SYNC_CHAIN`,
  `SYNC_NOTE_TRANSPORT`).

On the MT build, **rayon's thread pool is initialized inside the worker's own
WASM instance**, not the main thread's. Both the `INIT` and `INIT_MOCK` handlers
call `await wasm.initThreadPool(numThreads)` when `numThreads > 1` and the
export exists (`web-client-methods-worker.js:476-482`, `:525-531`). This is not
redundancy: every prove call runs in the worker, so a pool initialized only in
main-thread WASM does not parallelize anything - `par_iter()` / `par_chunks()`
in miden-crypto and p3-maybe-rayon see `rayon::current_num_threads() == 1` and
fall through to sequential code despite the parallel features being on. If you
add a new init path, plumb `numThreads` through it too.

### `_withInnerWebClient(fn)` - the `@internal` escape hatch

`MidenClient._withInnerWebClient(fn)` (`js/client.js:102-116`) runs `fn` with
exclusive access to the proxied JS `WebClient`, so `fn` can reach lower-level
methods the resource surface does not expose (`executeTransaction`,
`proveTransaction[WithProver]`, `submitProvenTransaction`, `applyTransaction`,
`newSendTransactionRequest`, `newConsumeTransactionRequest`, ...). It exists for
splitting the bundled execute -> prove -> submit -> apply pipeline across
contexts - an MV3 extension that executes in its service worker, proves in a
`chrome.offscreen` document where wasm-bindgen-rayon can spawn a real thread
pool, then submits and applies back in the SW.

The callback runs inside `_serializeWasmCall`, so the WASM borrow is held for
the duration of `fn` and concurrent SDK calls queue behind it. While `fn` runs,
the underlying client's `_withInnerLockDepth` counter is bumped so that
`_serializeWasmCall` invocations made **by** `fn` (or by any proxy-dispatched
method it calls) run **inline** instead of enqueuing behind the outer slot -
which is itself awaiting `fn`. Without the counter that is a textbook
re-entrant-lock deadlock.

> **Safety contract.** Callers MUST hold their own external mutex preventing
> concurrent access to the same client instance during `fn`. The chain still
> serializes against external callers - they queue behind the outer slot - but
> if an external task runs during one of `fn`'s awaits and calls into the SDK,
> it sees `_withInnerLockDepth > 0` and runs **inline**, racing wasm-bindgen's
> borrow check. The method is `@internal` and the proxied client's shape is not
> part of the documented public API, so pin the SDK version if you depend on it.
> (The consumer-facing statement of this contract lives in the shipped
> `web-client-usage` skill; the mechanism lives here.)

### Adding a method

When extending the SDK, choose the layer based on whether the work is
**Rust-side** or **glue/shape**:

- **Rust-side logic** (new RPC call, new transaction request type, storage
  access): expose a method on the WASM `WebClient` impl with `#[js_export(js_name
  = "camelCase")]`, then surface it from the matching resource in
  `js/resources/`. Update the method-classification sets in `index.js` so the
  linter (`scripts/check-method-classification.js`) accepts it.
- **JS-side ergonomics** (option-bag normalization, account-ref resolution, type
  coercion): keep the work in the resource module and call the existing WASM
  method.

### Debug metadata is stripped from production builds

Production WASM builds strip the debug metadata of the Miden packages embedded
in the binary (MASM source spans and `assert.err` message text), which is most
of why the published binaries are roughly 30% smaller. A failed VM assertion
therefore reports its error **code** with no human-readable message. The strip
runs through `scripts/wasm-opt-with-masp-strip.sh`, a `WASM_OPT_BIN` shim wired
in `rollup.config.js` that runs `strip-masp-debug` over the input and then
delegates to the real `wasm-opt`.

When you are debugging a VM abort, build with `MIDEN_WEB_DEV=true` (or
`pnpm --filter @miden-sdk/miden-sdk run build-dev`), which keeps full
diagnostics. Don't design an error path that depends on assertion message text
being readable in a released build, and don't write a test that asserts on it
unless the test builds in dev mode.

Resource methods follow this shape:

```javascript
// crates/web-client/js/resources/accounts.js
async get(ref) {
  this.#client.assertNotTerminated();
  const wasm = await this.#getWasm();
  const id = resolveAccountRef(ref, wasm);   // accepts string | AccountId | Account | AccountHeader
  const account = await this.#inner.getAccount(id);
  return account ?? null;
}
```

Rules:

- Always call `this.#client.assertNotTerminated()` at entry. Late callbacks on
  a torn-down client otherwise panic with "null pointer passed to rust".
- Resolve account/note/storage refs through the helpers in
  `crates/web-client/js/utils.js` (`resolveAccountRef`, `resolveAddress`,
  `resolveNoteType`, `resolveStorageMode`, `resolveAuthScheme`,
  `resolveNoteIdHex`, `resolveTransactionIdHex`, `hashSeed`), imported from a
  resource as `../utils.js`, so callers can pass any natural form (hex, bech32
  address, WASM type). (There is no `utils.js` inside `js/resources/`: that
  directory holds only the eight resource files: accounts, compiler, keystore,
  notes, pswap, settings, tags, transactions.)
- Return WASM-owned objects (e.g. `Account`, `AccountHeader`) directly when
  callers will use them again. Wrapping them in plain JS DTOs forces another
  WASM round-trip and breaks identity for code that compares by reference.
