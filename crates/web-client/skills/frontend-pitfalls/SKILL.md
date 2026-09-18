---
name: frontend-pitfalls
description: Critical pitfalls and safety rules for Miden frontend development. Covers per-hook readiness, non-atomic client sequences, COOP/COEP headers, BigInt boundaries, Bech32 network inference, IndexedDB state loss including the minor-version store wipe, auto-sync side effects, Vite configuration, React rendering race conditions, the Web Worker shim and callback-prover downgrade, structured error codes, eager vs lazy entry points, the fee note now included in outputNotes(), the removed expiredBefore filter, sendPrivate block hints, block-pinned foreign-account inputs, and transaction preview authorization. Use when reviewing, debugging, or writing Miden frontend code, or when upgrading from 0.15 to 0.16.
---

# Miden Frontend Pitfalls

## FP1: Readiness Is Per Hook, and `loadingComponent` Is Not a Gate (CRITICAL)

Three different things happen before WASM is ready, and only one of them is a crash:

- **Query hooks are safe and self-heal.** `useAccounts()` and friends return empty and
  refetch themselves once readiness flips, because their effects are keyed on `isReady`.
  Rendering one early is not a bug, and a test asserting "empty forever" asserts something
  the hook does not do.
- **Mutation hooks are safe to render** and throw only when you invoke the action.
- **`useMidenClient()` throws on render** with "Miden client is not ready". This is the
  only one that breaks a first paint.

**`loadingComponent` does not hold children back.** It renders only while
`isInitializing` is true, and the store's initial state is `isInitializing: false`, so the
very first render reaches your children even when you pass one. Treat it as presentation,
not as a readiness boundary.

```tsx
// WRONG - loadingComponent is not a gate; App still renders on the first pass
<MidenProvider config={{ rpcUrl: "testnet" }} loadingComponent={<p>Loading…</p>}>
  <App />
</MidenProvider>

// CORRECT - gate on isReady wherever you need the client
function App() {
  const { isReady } = useMiden();
  if (!isReady) return <p>Loading…</p>;
  return <WalletView />;   // safe to call useMidenClient() below here
}
```

## FP2: Sequences Are Not Atomic (the client already serializes single calls) (HIGH)

**A single concurrent call is safe.** Every method except the documented `SYNC_METHODS`
is forwarded through a per-instance promise chain, so two overlapping calls queue rather
than racing. The source is explicit that an unserialized fallback "panics with 'RefCell
already borrowed' and poisons the instance", which is precisely why the chain exists. So
`sync(); await send({...})` does not crash.

What actually breaks is a **sequence you intended to be atomic**. The chain serializes each
call, not your group of them, so another caller can interleave between your steps and act
on state you were midway through changing.

```tsx
// FINE - each call queues behind the other, no crash
sync();
await send({ ... });

// WRONG - read-then-write with a gap another caller can slip into
const height = await client.getSyncHeight();
await doSomethingThatAssumes(height);   // height may be stale by now

// CORRECT - take the lock around the whole sequence
const { runExclusive } = useMiden();
await runExclusive(async () => {
  const height = await client.getSyncHeight();
  await doSomethingThatAssumes(height);
});
```

Built-in hooks already wrap their own sequences. Reach for `runExclusive` when you compose
several raw `useMidenClient()` calls that depend on each other, or mix manual client calls
with hook mutations.

## FP3: COOP/COEP Headers - Only for the Multi-Threaded (MT) Build (HIGH)

COOP/COEP cross-origin-isolation is **not** a universal requirement. The web SDK ships four entry points along two axes (eager/lazy × ST/MT), and the isolation requirement depends entirely on the threading model:

- The **default** `@miden-sdk/react` (and `@miden-sdk/react/lazy`) and the **default** `@miden-sdk/miden-sdk` (and `/lazy`) are **single-threaded (ST)**. They ship single-threaded WASM that "loads in any browser context" with **no COOP/COEP requirement**. This is why the SDK's shipped example wallet runs full Miden client code (`MidenProvider`) importing the default `@miden-sdk/react` while using the bare `midenVitePlugin()` with no cross-origin isolation - ST simply does not need it.
- Only the **multi-threaded (MT)** variants - `@miden-sdk/react/mt`, `@miden-sdk/react/mt/lazy`, `@miden-sdk/miden-sdk/mt`, `@miden-sdk/miden-sdk/mt/lazy` (wasm-bindgen-rayon, ~3-5× faster local proving) - **require** the page to be cross-origin-isolated (`self.crossOriginIsolated === true`). Without `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`, the browser refuses to construct `WebAssembly.Memory({ shared: true })` and the MT WASM fails to instantiate at module load.

So: pick ST (the default) and you need no headers at all; opt into MT only if you do local proving on a host whose headers you control.

If you DO opt into the MT build, enable isolation via the Vite plugin explicitly on any route that runs the MT client:

```ts
// in your app's vite.config.ts - only needed for the MT build
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

export default defineConfig({
  plugins: [react(), midenVitePlugin({ crossOriginIsolation: true })],
});
```

Do not rely on the plugin's own default - `@miden-sdk/vite-plugin` defaults `crossOriginIsolation` to `false`. For MT you must pass `true` explicitly. For ST (the default build) leaving it `false` is correct - the example wallet uses bare `midenVitePlugin()` precisely because it is ST, and because `same-origin` COOP would nullify `window.opener` in the Para OAuth popups it pairs with via `paraVitePlugin()`.

For MT, COOP/COEP must also be set on the production server - the plugin covers only the Vite dev and preview servers, not your real production host. See `vite-wasm-setup` for per-host configs (Nginx, Vercel, Cloudflare).

**Gotcha (when isolation is on)**: Cross-origin-isolation breaks third-party iframes, external scripts without CORS, and OAuth popups. If a route must host those and cannot satisfy isolation, stay on the default ST subpaths (they need no isolation) or, if you genuinely need MT elsewhere, use `Cross-Origin-Embedder-Policy: credentialless` for weaker isolation that still allows most cross-origin resources, or scope the headers to only the MT routes. Do not enable isolation globally as a convenience.

## FP4: BigInt at the Low-Level WASM Boundary (HIGH)

The React SDK hooks (`useSend`, `useCreateFaucet`, `useMultiSend`, …) accept `bigint | number` for amounts and coerce to `bigint` internally - `SendOptions.amount` and `CreateFaucetOptions.maxSupply` are both typed `bigint | number`, and `useCreateFaucet` calls `BigInt(options.maxSupply)` before forwarding. So `number` does NOT fail at the hook layer.

**Nor does it fail at the high-level `MidenClient` resource API.** `SendOptions.amount` and `MintOptions.amount` on `client.transactions`, `FaucetCreateOptions.maxSupply` on `client.accounts.create`, and the swap / PSWAP amounts are all declared `number | bigint` in `api-types.d.ts`, and the resource impls coerce with `BigInt(...)` before crossing into WASM.

Strict `bigint` applies only at the **low-level request constructors** on `WasmWebClient` - `newSendTransactionRequest`, `newMintTransactionRequest`, `newSwapTransactionRequest`, … - whose Rust signatures take a `JsU64` with no coercion.

```tsx
// FINE at the React-SDK hook layer - number is coerced
await send({ from, to, assetId, amount: 1000 });
await createFaucet({ maxSupply: 1000000, ... });

// ALSO FINE - pass bigint directly (preferred; avoids precision loss above 2^53)
await send({ from, to, assetId, amount: 1000n });
await createFaucet({ maxSupply: BigInt(1000000), ... });

// REQUIRED at the low-level WasmWebClient request constructors - bigint only.
// (sender, target, faucetId, noteType, amount, recallHeight?, timelockHeight?)
await client.newSendTransactionRequest(fromId, toId, faucetId, noteType, 1000n);

// CORRECT - use parseAssetAmount for user input (decimal string → bigint)
import { parseAssetAmount } from "@miden-sdk/react";
const amount = parseAssetAmount(inputValue, 8);           // string → bigint
```

Prefer `bigint` everywhere anyway: a `number` above `2^53` loses precision before it ever reaches the coercion, so large supplies/amounts must be `bigint` or a decimal string parsed via `parseAssetAmount`.

**Gotcha**: `JSON.stringify` cannot serialize `bigint`. Use a custom replacer or convert to string first.

## FP5: Bech32 Network Mismatch (HIGH)

Bech32-encoded account IDs include the network. A devnet address on testnet points to a different or nonexistent account.

```tsx
// WRONG - hardcoding a bech32 address used across networks
const ADMIN = "mtst1qy35..."; // this is network-specific! (mtst testnet, mdev devnet)

// CORRECT - use hex format for cross-network compatibility
const ADMIN = "0x1234567890abcdef";

// CORRECT (React SDK) - derive bech32 per network
account.bech32id();          // installed on Account.prototype by @miden-sdk/react
toBech32AccountId(hexOrId);  // exported helper, same network inference

// CORRECT (raw SDK) - @miden-sdk/miden-sdk has no bech32id
accountId.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
AccountId.fromBech32("mtst1...");
```

`bech32id()` is **not** SDK API: `@miden-sdk/react` patches it onto `Account.prototype` at startup. Calling it on an `Account` obtained straight from `@miden-sdk/miden-sdk`, without the React SDK loaded, is a `TypeError`.

Both hex and bech32 formats work in all hooks. Prefer hex for constants, bech32 for display.

**Gotcha: the HRP is inferred from your `rpcUrl` string, not from the chain.** `bech32id()` (and `toBech32AccountId()`) read the *resolved* `rpcUrl` out of the store, lowercase it, and look for substrings in this order: `devnet` or `mdev` -> devnet, `mainnet` -> mainnet, `testnet` or `mtst` -> testnet. **Anything matching none of them falls back to testnet**, as does an unset `rpcUrl`.

`MidenConfig.rpcUrl` resolves only the shorthands `"testnet"`, `"devnet"` and `"localhost"` / `"local"` to concrete URLs and passes any other value through verbatim. So:

- A private or self-hosted RPC endpoint whose hostname contains none of those substrings silently renders `mtst1...` addresses for a network that is not testnet.
- `"localhost"` resolves to `http://localhost:57291`, which also contains none of them, so a local node renders testnet-prefixed addresses too.

If you run a custom or local network, do not treat `bech32id()` output as authoritative - key off hex, and render bech32 only where you control the network mapping yourself.

## FP6: Auto-Sync Side Effects (MEDIUM)

Default `autoSyncInterval` is 15000ms (15 seconds). Each sync triggers re-renders in useAccounts, useAccount, useNotes, etc.

```tsx
// PROBLEM - form resets every 15 seconds because parent re-renders
<MidenProvider config={{ rpcUrl: "testnet" }}>
  <SendForm />  {/* re-renders on every sync */}
</MidenProvider>

// SOLUTION 1 - preferred: use stable keys and memoization
const MemoizedForm = React.memo(SendForm);

// SOLUTION 2 - pause sync for the duration of a sensitive interaction
const { pauseSync, resumeSync, isPaused } = useSyncControl();

// SOLUTION 3 - last resort: disable auto-sync entirely and drive it yourself
<MidenProvider config={{ rpcUrl: "testnet", autoSyncInterval: 0 }}>
```

**Prefer `useSyncControl()` over `autoSyncInterval: 0` for transient stability.** It flips a store flag that only the auto-sync interval consults, so **manual `useSyncState().sync()` still works while paused** and you do not have to rebuild your own sync loop. It is also the right lever during long local proving, where a sync would otherwise compete for the WASM queue. `autoSyncInterval: 0` is a construction-time decision you cannot undo without remounting the provider (any value `<= 0` disables the interval).

## FP7: IndexedDB State Loss, Including From Your Own SDK Upgrade (HIGH)

The client persists accounts, keys, notes and transaction history in IndexedDB. There are **two** distinct ways to lose all of it, and the second one is under your control:

1. **The user or the browser deletes it** - "Clear site data", private browsing, storage pressure.
2. **An SDK version bump deletes it.** On open, `ensureClientVersion` compares the running client version against the one stored in the database. If both parse as semver and the running version's **major or minor is higher** than the stored one, the store is closed, `delete()`d and reopened **empty**. A version that does not parse as semver on either side forces the same reset. Same-major-minor (a patch bump) and downgrades are preserved and handled by Dexie migrations; the major/minor nuke is deliberate, tied to network resets.

**Upgrading the SDK across a minor version destroys every locally-stored account, key and note on every user's device.** Nothing prompts, nothing warns, and the user's wallet is simply gone on next load. This is the single most consequential item on this page: it turns a routine dependency bump into data loss for your whole userbase.

Mitigations:

- **Ship export/import before you ship the bump**, not with it. Users need a build that can back up while their data still exists. The surface is `useExportStore()` / `useImportStore()` in `@miden-sdk/react`, backed by the standalone `exportStore(storeName)` / `importStore(storeName, dump)` from `@miden-sdk/miden-sdk`. Per-object export/import also exists on the high-level client (`accounts.export` / `accounts.import`, `notes.export` / `notes.import`).
- Warn users that clearing browser data deletes their wallet.
- Consider external signers (Para, Turnkey, wallet adapters) for production - the key material lives outside the browser store, so only cached chain state is lost.
- Each signer identity gets its own database (`MidenClientDB_<storeName>`), so `SignerContextValue.storeName` must be unique per user.

Verify before relying on this: `crates/idxdb-store/src/ts/schema.ts`, `ensureClientVersion`.

## FP8: Vite Configuration Requirements (MEDIUM)

The `@miden-sdk/vite-plugin` package handles all Miden-specific Vite config. The recommended pattern for any new Miden app is:

```ts
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

export default defineConfig({
  // ST (default build): bare plugin is enough - no isolation needed
  plugins: [react(), midenVitePlugin()],

  // MT build only: opt into cross-origin isolation
  // plugins: [react(), midenVitePlugin({ crossOriginIsolation: true })],
});
```

`midenVitePlugin()` handles WASM loading (esnext build target, top-level await), pre-bundling exclusion (`optimizeDeps.exclude`), package deduplication, a gRPC-web RPC proxy, and - when `crossOriginIsolation: true` is passed - emits the COOP `same-origin` + COEP `require-corp` headers the **MT** build requires for `SharedArrayBuffer` on both the dev `server` and the `preview` server.

It accepts **four** options, all with source defaults that work for the ST build:

| Option | Source default | Purpose |
|--------|----------------|---------|
| `wasmPackages` | `["@miden-sdk/miden-sdk"]` | Packages to alias, dedupe, and exclude from pre-bundling |
| `crossOriginIsolation` | `false` | Emit COOP `same-origin` + COEP `require-corp` on the dev **and** preview servers. Set `true` only when importing the MT variants (`/mt`, `/mt/lazy`) |
| `rpcProxyTarget` | `"https://rpc.testnet.miden.io"` | gRPC-web dev-proxy target; `false` disables the proxy. Only applied when `command === "serve"` |
| `rpcProxyPath` | `"/rpc.Api"` | Path prefix the proxy intercepts |

For the **default single-threaded build**, leave `crossOriginIsolation` at its `false` default - the ST WASM loads in any browser context and needs no headers. Pass `crossOriginIsolation: true` **only** when you opt into the multi-threaded variants for local proving; without the headers the MT WASM can't construct shared memory and fails to instantiate. The shipped example wallet uses bare `midenVitePlugin()` because it is ST (and because isolation would break the Para OAuth popups it pairs with via `paraVitePlugin()`) - see FP3. For an MT production deployment, set the same COOP/COEP headers at your real production host - the plugin only injects them into the Vite dev and preview servers. See `vite-wasm-setup` for host-specific configs.

## FP9: React StrictMode Double-Init (LOW)

React StrictMode double-invokes effects in development (since React 18; the React SDK's peer dep is `react >= 18.0.0`). MidenProvider guards against this, but direct low-level `createClient()` calls will initialize twice.

Naming: `@miden-sdk/miden-sdk` exposes a high-level `MidenClient` wrapper class (the recommended entry point) and a low-level client re-exported as `WasmWebClient` - an `@internal` export used mainly by integration tests, whose type declaration explicitly says "Use MidenClient instead." (The class is named `WebClient` in source and re-exported under the alias `WasmWebClient`.) The React SDK does its own low-level init by importing that internal client locally as `WebClient` (`import { WasmWebClient as WebClient } from "@miden-sdk/miden-sdk"`). For manual low-level setup you would call `WasmWebClient.createClient(...)`, but prefer `MidenProvider` (or the high-level `MidenClient`) so init is guarded.

```tsx
// WRONG - manual low-level client creation in useEffect
useEffect(() => {
  const client = await WasmWebClient.createClient(url); // called twice in dev
}, []);

// CORRECT - always use MidenProvider
<MidenProvider config={{ rpcUrl: "testnet" }}>
```

If you genuinely need the low-level constructors, these are the current signatures. Note the trailing `observability` bag, and that there is **no debug-mode argument** anywhere (nor a `ClientOptions.debugMode`):

```ts
WasmWebClient.createClient(
  rpcUrl, noteTransportUrl, seed, network,
  logLevel, useWorker = true, observability
): Promise<WebClient>

WasmWebClient.createClientWithExternalKeystore(
  rpcUrl, noteTransportUrl, seed, storeName,
  getKeyCb, insertKeyCb, signCb,
  logLevel, useWorker = true, observability
): Promise<WebClient>
```

`observability` is `{ observer?: (observation: object) => void, observeSensitive?: boolean }`. The fourth positional argument is the store name in both; `createClient` documents it as `network` and `createClientWithExternalKeystore` as `storeName`, but it is the same slot and the same meaning - set it when several clients share one browser.

## FP10: outputNotes() Includes the Fee Note (CRITICAL - fails silently)

On any chain whose verification base fee is non-zero, `outputNotes()` returns one more note than the transaction created: the fee note. Nothing throws. Code that reads `getNote(0)`, counts `numNotes()`, or iterates the list is looking at a list one longer than it expects. This is the one 0.16 change that fails silently rather than loudly.

```tsx
// WRONG - index 0 may be the fee note, and numNotes() is one too many
const note = executed.outputNotes().getNote(0);
const count = executed.outputNotes().numNotes();

// CORRECT on ExecutedTransaction - split accessors exist.
// userOutputNotes() returns a plain OutputNote[]; feeNote() returns
// OutputNote | undefined (undefined when the transaction paid no fee).
const note = executed.userOutputNotes()[0];
const count = executed.userOutputNotes().length;
const fee = executed.feeNote();
```

`TransactionRecord` and `TransactionSummary` have **no** split accessor: both expose only `outputNotes(): OutputNotes`. If you read it on either, filter or account for the extra note yourself. The fee note is identified by its note script root, not by the `0xfee` note tag (which is a plain `u32` any caller-supplied note can carry).

## FP11: transactions.list({ expiredBefore }) Now Throws (HIGH)

`TransactionFilter.expiredBefore()` and the `{ expiredBefore: number }` query shape were removed in 0.16; expiry is decided during state sync instead. TypeScript callers get a type error, JavaScript callers get a throw.

It throws rather than falling through because the unrecognised-shape fallback is `TransactionFilter.all()` - a caller asking for the expired subset in order to discard or retry it would otherwise silently receive *every* stored transaction, which is the wrong direction to fail.

```tsx
// WRONG - throws
await client.transactions.list({ expiredBefore: height });

// CORRECT - list uncommitted, then compare expiry yourself
const txs = await client.transactions.list({ status: "uncommitted" });
const expired = txs.filter((t) => t.expirationBlockNum() < height);
```

It throws only where the filter was actually applied: a query that also carries `status` or `ids` is served by those, and an undefined `expiredBefore` still means "no filter".

## FP12: sendPrivate Requires scanAfterBlockNum, and Overshooting Drops Delivery (HIGH)

`client.notes.sendPrivate({ note, to })` now requires an explicit `scanAfterBlockNum` - the block the recipient scans **forward** from for the note's on-chain commitment. The SDK no longer infers it from the current sync height, because that inference silently dropped delivery once the sender had synced past the note (for example when relaying *after* waiting for the transaction to commit).

The value must be at or below the commitment block. A hint above it is never scanned back to and the recipient simply never receives the note - no error, on either side.

```tsx
// CORRECT for an arbitrary note - pin the chain tip at submission time
await client.notes.sendPrivate({ note, to, scanAfterBlockNum: tipAtSubmit });

// BETTER for one of this client's own output notes - the block is derived for you
await client.notes.sendPrivateOutput({ noteId, to });
```

Related: `notes.fetchPrivate({ mode: "all" })` is gone. `fetchPrivate()` takes no arguments and always fetches incrementally from the stored cursor; historical notes for a newly tracked tag are backfilled by `sync()`, so after adding a tag just sync.

## FP13: Foreign-Account Inputs Are Pinned to One Block (HIGH)

`client.transactions.foreignAccountInputs(accounts, blockNum)` (0.16.1) fetches each foreign account's state and inclusion witness so you can supply it instead of having it fetched at execution time. Each witness opens against the account tree of `blockNum` alone.

**Do not sync between fetching these and executing.** The results are valid only for a transaction whose reference block is exactly `blockNum` - the anchor's block when executing against a `ChainAnchor`, or the sync height at execution time otherwise. Execution fails naming the account and the block. With auto-sync on a 15 s timer (FP6), a fetch-then-execute gap is easy to open by accident; capture a `ChainAnchor` or disable auto-sync across the window.

```tsx
const inputs = await client.transactions.foreignAccountInputs(
  [ForeignAccount.public(id, storageRequirements)],
  anchor.blockNum() // a method, not a property
);
// re-declare them so nothing is fetched at execution time
const accounts = inputs.map((i) => ForeignAccount.prefetched(i));
```

Second trap: **only the accounts you name are fetched.** This does not discover the accounts a transaction loads on its own, such as faucets whose asset callbacks it triggers. Each returned `AccountInputs` entry serializes on its own (`entry.serialize()`), which is how you ship prefetched state to another client.

## FP14: transactions.preview Rejects When Already Authorized (MEDIUM)

`transactions.preview(...)` returns a `TransactionSummary` **only while authorization is pending** - when the account's auth procedure aborts with the unauthorized event, for example a multisig below its signing threshold. That payload is what out-of-band signing flows need.

If the transaction is already fully authorized it executes successfully, no summary is produced, and the call rejects with an error carrying `code: "TRANSACTION_ALREADY_AUTHORIZED"` (on Node.js the code prefixes the error message). Submit it with `transactions.execute(...)` instead. Earlier versions synthesized a summary from the executed transaction on success, so this is a behavior change, not just a new error: `preview` is not a general dry run.

## FP15: useAccounts().faucets Is Always Empty (MEDIUM)

`useAccounts()` returns `{ accounts, wallets, faucets, isLoading, error, refetch }`, but `wallets` is an alias of `accounts` and `faucets` is a hardcoded empty array. Filtering faucets through that field silently yields nothing.

```tsx
// WRONG - always []
const { faucets } = useAccounts();

// CORRECT - classify from the account list yourself
const { accounts } = useAccounts();
const faucets = accounts.filter((a) => a.isFaucet());
```

## FP16: The Web Worker Shim Silently Downgrades Callback Provers (HIGH - fails silently)

`useWorker` defaults to **`true`**: the client spawns a Web Worker and dispatches WASM calls to it, keeping the main thread responsive. That is the right default in browsers and extensions - but the worker boundary serializes the prover argument via `TransactionProver.serialize()`, and **that format has no encoding for `newCallbackProver(jsFn)`, so it silently downgrades to the local prover.** Your callback never fires, the transaction still proves, and nothing errors.

```tsx
import { TransactionProver } from "@miden-sdk/miden-sdk";

// WRONG - the worker serializes this prover, loses the callback, proves locally
const prover = TransactionProver.newCallbackProver(nativeProveFn);
<MidenProvider config={{ rpcUrl: "testnet" }}>

// CORRECT - opt out of the worker so the prover handle reaches WASM intact
<MidenProvider config={{ rpcUrl: "testnet", useWorker: false }}>
```

Set `useWorker: false` when:

- You pass a prover built with `TransactionProver.newCallbackProver(jsFn)` - a native iOS/Android prover behind a Capacitor plugin, or any other JS-side prover bridge.
- You are embedding in a single-WebView native shell (Capacitor host, Tauri, Electron preload), where the UI thread is not competing with WASM anyway.

`MidenConfig.useWorker` is forwarded to both `createClient` and `createClientWithExternalKeystore`.

Two companions to the same boundary:

- **`lastAuthError()` returns `null` under the worker.** The sign callback fires against the worker's WASM keystore while the accessor reads the main-thread instance, which never signed. It is meaningful only with `useWorker: false` - which is not a real constraint, since a JS sign callback needs that setting to be reachable at all. On the Node binding it always returns `null`, because signing goes through the filesystem keystore rather than a JS callback.
- **`usePreview()` runs the VM on the main thread regardless.** It is not offloaded to the worker (matching the client's unanchored `executeForSummary`), so it blocks the UI for its whole duration and queues other client calls behind it. Budget for that in a confirmation flow; do not assume the worker is absorbing it.

Verify: `crates/web-client/js/index.js`, `crates/web-client/js/client.js`, `packages/react-sdk/src/hooks/usePreview.ts`.

## FP17: Branch on `error.code`, Never on Message Text (MEDIUM)

Errors carry machine-readable codes; message strings are not a stable API.

- Assigned by the React SDK (`MidenError`, the closed `MidenErrorCode` union): `WASM_CLASS_MISMATCH`, `WASM_POINTER_CONSUMED`, `WASM_NOT_INITIALIZED`, `WASM_SYNC_REQUIRED`, `SEND_BUSY`, `OPERATION_BUSY`, `STALE_CLIENT`, `UNKNOWN`.
- Assigned by the Rust client and thrown out of WASM (`WasmErrorCode`): `INVALID_CHAIN_ANCHOR`, `TRANSACTION_ALREADY_AUTHORIZED`. This list is deliberately **not** exhaustive of what the client can emit - `CodedError.code` carries a `(string & {})` arm so codes from a newer client stay assignable. Handle the ones you care about and fall through on the rest.

```tsx
import type { CodedError } from "@miden-sdk/react";

try {
  await preview({ ... });
} catch (e) {
  const err = e as CodedError;
  if (err.code === "TRANSACTION_ALREADY_AUTHORIZED") {
    await execute({ ... }); // nothing to authorize - just submit it
  }
}
```

**Gotcha - on Node the code prefixes the message** (`"INVALID_CHAIN_ANCHOR: …"`) instead of being a property, because the napi bindings cannot attach one. Code written as `err.code === …` works in the browser and silently never matches under Node.

**`WASM_CLASS_MISMATCH` almost always means multiple copies of `@miden-sdk/miden-sdk` are bundled**, not that you passed the wrong type. The code is raised from a raw message matching `_assertClass` or `expected instance of`, which is what an object built by one copy looks like when handed to another. Its own message says so and names the fix: `resolve.dedupe` + `optimizeDeps.exclude` for the package - which `midenVitePlugin()` already does (FP8). Pin `@miden-sdk/miden-sdk` and `@miden-sdk/react` to the same exact version too, rather than to ranges that can drift apart.

## FP18: The Eager Entry Hangs Under Capacitor and SSR (MEDIUM)

The default browser entry (`@miden-sdk/miden-sdk`, `@miden-sdk/react`) awaits WASM at **module top level**, which is why any wasm-bindgen constructor is safe to call on the next line with no readiness gate. That top-level await is a liability in two hosts:

- **Capacitor / WKWebView**: the `capacitor://localhost` scheme handler hangs module evaluation on top-level await indefinitely. Verified empirically - the same TLA in a dApp-browser WKWebView over vanilla HTTPS resolves in under 100 ms, so it is the custom scheme, not WKWebView itself.
- **Next.js / SSR**: top-level await blocks server-side module evaluation.

Import `@miden-sdk/miden-sdk/lazy` (or `@miden-sdk/react/lazy`) there. Identical API surface, no top-level await; callers await `MidenClient.ready()` before touching wasm-bindgen types. Under `@miden-sdk/react` the provider's `isReady` already is that gate, so a lazy entry costs you nothing extra.

Verify: `crates/web-client/js/eager.js`.

## Removed or Changed in 0.16 (check these first when upgrading from 0.15)

- `ClientOptions.debugMode` removed; `WasmWebClient.createClient*` no longer take a trailing `debugMode` argument.
- `FungibleAsset.withCallbacks(flag)` removed. The flag is an immutable property of the issuing faucet's account id; `FungibleAsset.callbacks()` still reports it.
- `TransactionSummary.salt()` replaced by `userParams()` (the seven user-defined field elements the summary commitment binds).
- `ExecutedTransaction.accountDelta()` and `TransactionStoreUpdate.accountDelta()` replaced by `accountPatch()`, exposing the absolute-valued `AccountPatch` / `AccountStoragePatch` / `AccountVaultPatch`. `TransactionSummary.accountDelta()` remains relative. `AccountStorageDelta` was removed.
- `AccountComponent.createNetworkAuth` renamed to `createNetworkAuthComponents(NoteScriptFee[], feeFaucetId)`, which returns an **array**. Add every returned component to the builder with `AccountBuilder.withComponent`.
- MASM: note scripts calling `basic_wallet::add_assets_to_account` must switch to `basic_wallet::move_note_assets_to_account` (a stale script fails to compile with `undefined item 'add_assets_to_account'`). Account-component procedures now require `@account_procedure`, and transaction scripts use `@transaction_script pub proc main`.
- `newConsumeTransactionRequest` is async and takes the consuming account as a second argument. `newPswapConsumeTransactionRequest` and `newPswapCancelTransactionRequest` are async too (parameters unchanged). Code going through `client.transactions.consume(...)` / `consumeAll(...)` or the `useConsume` hook is unaffected.
- `TransactionProver.newLocalProver()` now produces Poseidon2 proofs, matching the client's own default prover instead of the prover crate's Blake3 default. Expect local proving to take roughly 1.6-2.6x longer. This is an alignment, not a regression - do not go hunting for a performance bug.
- Transaction submissions encrypt their private inputs. Nodes that unseal them reject plaintext submissions and older nodes reject sealed ones, so **client and node must be upgraded together**.
- `ClientOptions.observer` / `observeSensitive` are new and construction-only. Only the literal boolean `true` enables `observeSensitive` (a truthy `"true"` from an env var reads as off), the resolved value is sealed non-writable, and enabling it logs a one-time console warning. When off, the `sensitive` key is **absent** from the observation, so `"sensitive" in observation` distinguishes "not enabled" from "enabled with nothing to report".

## Quick Reference

| # | Pitfall | Severity | One-Line Rule |
|---|---------|----------|---------------|
| FP1 | Readiness is per hook | CRITICAL | Query hooks self-heal when `isReady` flips; `useMidenClient()` throws on render, so gate that one. `loadingComponent` is not a gate |
| FP2 | Sequences are not atomic | HIGH | Single calls already serialize; wrap multi-call sequences in `runExclusive()` |
| FP3 | COOP/COEP | HIGH | Default ST build needs no headers; required ONLY for the `/mt` build |
| FP4 | BigInt | HIGH | Hooks and the high-level `MidenClient` coerce `number`; strict `bigint` only at the low-level request constructors |
| FP5 | Bech32 mismatch | HIGH | Match network in rpcUrl and addresses; the HRP is inferred from the `rpcUrl` string and falls back to testnet |
| FP6 | Auto-sync | MEDIUM | Default 15000ms; prefer `useSyncControl()` over `autoSyncInterval: 0` |
| FP7 | IndexedDB loss | HIGH | A minor SDK bump wipes the store - ship `useExportStore`/`useImportStore` BEFORE upgrading |
| FP8 | Vite config | MEDIUM | `midenVitePlugin()` has four options; bare call is right for ST, `crossOriginIsolation: true` only for `/mt` |
| FP9 | StrictMode | LOW | Use MidenProvider, not manual `WasmWebClient.createClient()`; there is no debug-mode argument |
| FP10 | Fee note in `outputNotes()` | CRITICAL | The list is one longer on a fee-charging chain; use `userOutputNotes()` / `feeNote()` on `ExecutedTransaction`, filter manually elsewhere |
| FP11 | `expiredBefore` removed | HIGH | `transactions.list({ expiredBefore })` throws; use `{ status: "uncommitted" }` + `expirationBlockNum()` |
| FP12 | `sendPrivate` block hint | HIGH | Pass `scanAfterBlockNum` at or below the commitment block, or prefer `sendPrivateOutput` |
| FP13 | Foreign-account inputs | HIGH | Pinned to one block; do not sync between fetching and executing |
| FP14 | `preview` already authorized | MEDIUM | Summary only while auth is pending; otherwise rejects `TRANSACTION_ALREADY_AUTHORIZED` |
| FP15 | `useAccounts().faucets` | MEDIUM | Always empty; classify from `accounts` with `isFaucet()` |
| FP16 | Worker shim | HIGH | `useWorker` defaults `true` and silently downgrades a callback prover - set `false` when you supply one |
| FP17 | Error handling | MEDIUM | Branch on `error.code`, never message text; `WASM_CLASS_MISMATCH` means two copies of the core |
| FP18 | Eager entry | MEDIUM | Use `/lazy` under Capacitor and SSR - top-level await hangs there |
