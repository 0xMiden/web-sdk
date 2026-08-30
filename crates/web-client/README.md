# @miden-sdk/miden-sdk

## Overview

The `@miden-sdk/miden-sdk` is a comprehensive software development toolkit (SDK) for interacting with the Miden blockchain and virtual machine from within a web application. It provides developers with everything needed to:

- Interact with the Miden chain (e.g. syncing accounts, submitting transactions)
- Create and manage Miden transactions
- Run the Miden VM to execute programs
- Generate zero-knowledge proofs using the Miden Prover (with support for delegated proving)
- Integrate Miden capabilities seamlessly into browser-based environments

Whether you're building a wallet, dApp, or other blockchain-integrated application, this SDK provides the core functionality to bridge your frontend with Miden's powerful ZK architecture.

> **Note:** This README provides a high-level overview of the web client SDK.
> For more detailed documentation, API references, and usage examples, see the documentation [here](../../docs/src/web-client) (TBD).

### SDK Structure and Build Process

This SDK is published as an NPM package, built from the `web-client` crate. The `web-client` crate is a Rust crate targeting WebAssembly (WASM), and it uses `wasm-bindgen` to generate JavaScript bindings. It depends on the lower-level `rust-client` crate, which implements the core functionality for interacting with the Miden chain.

Both a `Cargo.toml` and a `package.json` are present in the `web-client` directory to support Rust compilation and NPM packaging respectively.

The build process is powered by a custom `rollup.config.js` file, which orchestrates three main steps:

1. **WASM Module Build**: Compiles the `web-client` Rust crate into a WASM module using `@wasm-tool/rollup-plugin-rust`, enabling WebAssembly features such as atomics and bulk memory operations.

2. **Worker Build**: Bundles a dedicated web worker file that enables off-main-thread execution for computationally intensive functions.

3. **Main Entry Point Build**: Bundles the top-level JavaScript module (`index.js`) which serves as the main API surface for consumers of the SDK. This module also imports `wasm.js`, which
   provides a function to load the wasm module in an async way. Since there's a [known issue](https://github.com/wasm-tool/rollup-plugin-rust?tab=readme-ov-file#usage-with-vite)
   with vite, there's a check to avoid loading the wasm module when SSR is enabled.

This setup allows the SDK to be seamlessly consumed in JavaScript environments, particularly in web applications.

## Installation

### Stable Version

A non-stable version of the SDK is also maintained, which tracks the `next` branch of the Miden client repository (essentially the development branch). To install the pre-release version, run:

```javascript
npm i @miden-sdk/miden-sdk
```

Or using Yarn:

```javascript
pnpm add @miden-sdk/miden-sdk
```

### Pre-release ("next") Version

A non-stable version is also maintained. To install the pre-release version, run:

```javascript
npm i @miden-sdk/miden-sdk@next
```

Or with Yarn:

```javascript
pnpm add @miden-sdk/miden-sdk@next
```

> **Note:** The `next` version of the SDK must be used in conjunction with a locally running Miden node built from the `next` branch of the `miden-node` repository. This is necessary because the public testnet runs the stable `main` branch, which may not be compatible with the latest development features in `next`. Instructions to run a local node can be found [here](https://github.com/0xMiden/miden-node/tree/next) on the `next` branch of the `miden-node` repository. Additionally, if you plan to leverage delegated proving in your application, you may need to run a local prover (see [Remote prover instructions](https://github.com/0xMiden/miden-node/tree/next/bin/remote-prover)).

## Entry Points: Eager / Lazy × ST / MT

The SDK ships **four** entry points with an identical public API. They vary along two orthogonal axes:

- **WASM init timing** — _eager_ awaits at module load (top-level `await`); _lazy_ leaves init to an explicit `MidenClient.ready()` or first awaiting SDK method.
- **WASM threading model** — _ST_ (single-threaded) loads in any browser context; _MT_ (multi-threaded, `wasm-bindgen-rayon`) parallelizes proving across hardware threads but **requires the page to be cross-origin-isolated**.

| Import path                         | Timing | Threading | When WASM initializes                | Hosting requirement                    |
| ----------------------------------- | ------ | --------- | ------------------------------------ | -------------------------------------- |
| `@miden-sdk/miden-sdk`              | eager  | ST        | At module evaluation (TLA)           | None — works anywhere                  |
| `@miden-sdk/miden-sdk/lazy`         | lazy   | ST        | On `ready()` / first `await`         | None — works anywhere                  |
| `@miden-sdk/miden-sdk/mt`           | eager  | **MT**    | At module evaluation (TLA)           | Cross-origin isolation (see below)     |
| `@miden-sdk/miden-sdk/mt/lazy`      | lazy   | **MT**    | On `ready()` / first `await`         | Cross-origin isolation (see below)     |

The default subpaths (`/`, `/lazy`) ship the single-threaded WASM and load in any browser context. The `/mt` family enables wasm-bindgen-rayon, which gives ~3–5× faster `proveTransactionWithProver` on commodity laptops at the cost of a hard hosting requirement.

### Threading model — when to pick `/mt`

The MT build can ONLY load on a page where `self.crossOriginIsolated === true`, i.e. the host has set:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without those response headers, the browser refuses to construct `WebAssembly.Memory({ shared: true })` and the `/mt` WASM fails to instantiate at module load. The default ST subpaths don't depend on shared memory and have no such requirement.

Pick MT when:

- Your dApp does local (non-delegated) proving and you control the hosting headers.
- You're shipping the SDK inside a Chrome extension or other host whose manifest already sets COOP/COEP.

Pick ST when:

- You don't control the response headers (third-party host, CDN that won't set them).
- You're using delegated proving exclusively — the network round-trip dwarfs any local-prove speedup.
- You're targeting Capacitor / native WebViews — they don't expose cross-origin isolation by default.

### Setting cross-origin isolation headers

If you import `/mt` or `/mt/lazy`, the page hosting the SDK must respond with the COOP/COEP headers above. Common setups:

**Vite dev server**

```ts
// vite.config.ts
export default {
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
};
```

**Next.js**

```js
// next.config.mjs
export default {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};
```

**Express / generic Node**

```js
app.use((_, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});
```

**Chrome / Firefox extension manifests (MV3)**

```json
{
  "cross_origin_opener_policy": { "value": "same-origin" },
  "cross_origin_embedder_policy": { "value": "require-corp" }
}
```

**Caveat — COEP side effects.** `require-corp` blocks any cross-origin resource (images, fonts, iframes, scripts) that doesn't carry `Cross-Origin-Resource-Policy: cross-origin` or appropriate CORS. If your page loads remote avatars, embeds YouTube, pulls fonts from Google, etc., those break unless you serve them from same-origin or add the right headers. This is a deployment decision; opt in only when you understand the resource graph.

If you cannot set these headers (CDN, hosting provider that doesn't allow header injection), the COI service-worker shim pattern (`gzuidhof/coi-serviceworker`) lets a small same-origin SW intercept fetches and re-inject the headers on the way back. We don't bundle this with the SDK because installing a service worker into a consumer's app is intrusive — adopt it deliberately if you need it.

### `initThreadPool(n)` — required once for MT

Every MT entry re-exports `initThreadPool` from wasm-bindgen-rayon. **Consumers must `await` it once before any prove call** (typically at app startup, or just before the first transaction):

```ts
import { MidenClient, initThreadPool } from "@miden-sdk/miden-sdk/mt/lazy";

await MidenClient.ready();
await initThreadPool(navigator.hardwareConcurrency); // size to physical threads
```

Without this call, the rayon global thread pool spawns zero workers on `wasm32` and every `par_iter(...)` falls through to a sequential loop — i.e. you've shipped multi-threaded WASM that runs single-threaded. The ST entries don't expose `initThreadPool` (no thread pool to bring up).

### Timing model — eager vs lazy

The eager entries await WASM at module top level via a small shim, so once an `import` statement resolves, any wasm-bindgen constructor (`new Felt(…)`, `AccountId.fromHex(…)`, `TransactionProver.newLocalProver()`, etc.) is safe to call synchronously on the next line. No `await MidenClient.ready()` is required.

The lazy entries do not run any top-level await. This matters in two environments that hang on TLA:

- **Next.js / SSR** — TLA blocks server-side module evaluation.
- **Capacitor WKWebView hosts (Miden Wallet iOS/Android)** — the custom `capacitor://localhost` scheme handler interacts poorly with TLA in the main WebView. Verified empirically: the same TLA in a dApp WebView (vanilla HTTPS) resolves in <100ms, but hangs indefinitely in the Capacitor host.

On a lazy entry, callers are responsible for awaiting initialization before calling any bare wasm-bindgen constructor. Every async SDK method (`client.accounts.create()`, `client.transactions.send()`, etc.) awaits internally, so you only need to gate on readiness when you're constructing wasm-bindgen types yourself.

### Eager usage (default)

```typescript
// Bundlers resolve `@miden-sdk/miden-sdk` to `./dist/eager.js`.
// The `import` statement awaits WASM; everything below is safe to call sync.
import { MidenClient, AccountId, Felt } from "@miden-sdk/miden-sdk";

const id = AccountId.fromHex("0x…"); // sync, WASM is already initialized
const felt = new Felt(42n); // sync

const client = await MidenClient.createTestnet();
```

### Lazy usage (`/lazy`)

```typescript
import { MidenClient, AccountId, Felt } from "@miden-sdk/miden-sdk/lazy";

// Gate any bare wasm-bindgen constructor behind ready():
await MidenClient.ready();
const id = AccountId.fromHex("0x…"); // safe after ready()
const felt = new Felt(42n);

// SDK methods that are already async await internally — no ready() needed:
const client = await MidenClient.createTestnet(); // implicitly initializes WASM
await client.sync();
```

`MidenClient.ready()` is idempotent and safe to call from multiple places — concurrent callers share the same in-flight promise, and post-init callers resolve immediately from a cached module. `MidenProvider`, tutorial helpers, and application code can all call it without any coordination.

### Multi-threaded usage (`/mt` or `/mt/lazy`)

The MT entries enable wasm-bindgen-rayon for ~3–5× faster `proveTransactionWithProver` on hardware-multi-threaded machines. Same shape as ST, plus `initThreadPool` once at startup:

```typescript
// Use the lazy MT entry for environments that hang on TLA (Next.js, Capacitor):
import { MidenClient, initThreadPool } from "@miden-sdk/miden-sdk/mt/lazy";

await MidenClient.ready();
await initThreadPool(navigator.hardwareConcurrency); // bring up the rayon pool ONCE

const client = await MidenClient.createTestnet();
// All subsequent prove calls dispatch across threads automatically.
```

Or eager:

```typescript
import { MidenClient, initThreadPool } from "@miden-sdk/miden-sdk/mt";

await initThreadPool(navigator.hardwareConcurrency);
const client = await MidenClient.createTestnet();
```

Reminder: the `/mt` entries fail to load on pages without cross-origin isolation. See "Setting cross-origin isolation headers" above. If `self.crossOriginIsolated === false` at the time of import, you'll see a `WebAssembly.Memory: shared memory requires crossOriginIsolated` (or similar) thrown out of `__wbg_init`.

### Next.js example

```tsx
// app/page.tsx
"use client";

import { useEffect, useState } from "react";
import { MidenClient } from "@miden-sdk/miden-sdk/lazy";

export default function Page() {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await MidenClient.ready(); // optional here — createTestnet awaits internally
      const client = await MidenClient.createTestnet();
      const syncHeight = await client.getSyncHeight();
      if (!cancelled) setHeight(syncHeight);
      client.terminate();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <div>Height: {height ?? "…"}</div>;
}
```

### Capacitor / React Native WebView

Use `/lazy` from anywhere inside a Capacitor iOS/Android host (the main WKWebView). TLA hangs the custom scheme handler; the `MidenClient.ready()` gate is the replacement.

### Framework adapters

`@miden-sdk/react` imports from `/lazy` internally and manages readiness via `isReady`. You can still import wasm-bindgen types from either entry in your own code; see the React SDK README for the recommended pattern.

## Building and Testing the Web Client

If you're interested in contributing to the web client and need to build it locally, you can do so via:

```
pnpm install
pnpm build
```

This will:

- Install all JavaScript dependencies,
- Compile the Rust code to WebAssembly,
- Generate the JavaScript bindings via wasm-bindgen,
- And bundle the SDK into the dist/ directory using Rollup.

To run integration tests after building, use:

```
pnpm test
```

This runs a suite of integration tests to verify the SDK’s functionality in a web context.

### Building the npm package

Follow the steps below to produce the contents that get published to npm (`dist/` plus the license file). All commands are executed from `crates/web-client`.

1. **Install prerequisites**
   - Install the Rust toolchain version specified in `rust-toolchain.toml`.
   - Install Node.js ≥18 and Yarn.
2. **Install dependencies**
   ```bash
   pnpm install
   ```
   This installs both the JavaScript tooling and the `@wasm-tool/rollup-plugin-rust` dependency that compiles the Rust crate.
3. **Build the package**
   ```bash
   pnpm build
   ```
   The `build` script (see `package.json`) performs the following:
   - Removes the previous `dist/` directory (`rimraf dist`).
   - Runs `npm run build-rust-client-js`, which builds the `idxdb-store` TypeScript helper that the SDK imports.
   - Invokes Rollup with `RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\""` so the Rust `getrandom` crate targets browser entropy and so that atomics/bulk-memory WebAssembly features are enabled.
   - Copies the generated TypeScript declarations from `js/types` into `dist/`.
   - Executes `node clean.js` to strip paths from the generated `.js` files, leaving only the artifacts needed on npm.
4. **Inspect the artifacts**
   - `dist/index.js` is the ESM entry point referenced by `"main"`/`"browser"`/`"exports"`.
   - `dist/index.d.ts` and the rest of the `.d.ts` files provide the TypeScript surface.
   Use `npm pack` if you want to preview the exact tarball that would be published.

> Tip: during development you can set `MIDEN_WEB_DEV=true` before running `pnpm build` (or run `npm run build-dev`) to skip the clean step and keep extra debugging metadata in the bundled output. This debugging metadata also includes debug symbols for the generated wasm binary

### Checking the generated TypeScript bindings

The script at `crates/web-client/scripts/check-bindgen-types.js` verifies that every type exported by the generated wasm bindings (`dist/crates/miden_client_web.d.ts`) is re-exported from the public declarations (`js/types/index.d.ts`). Run it after a build with:

```
pnpm check:wasm-types
```

`WebClient` is intentionally excluded because the wrapper defines its own implementation. If the check reports missing exports, update `js/types/index.d.ts` so consumers get the full generated surface.

## Usage

The following are just a few simple examples to get started. For more details, see the [Web Client docs](https://docs.miden.xyz/builder/tools/clients/web-client/).

### Quick Start

```typescript
import { MidenClient, AccountType } from "@miden-sdk/miden-sdk";

// 1. Create client (defaults to testnet, or use createTestnet()/createDevnet())
const client = await MidenClient.createDevnet();

// 2. Create a wallet and a token (faucet account)
const wallet = await client.accounts.create();
const dagToken = await client.accounts.create({
  type: AccountType.FungibleFaucet, symbol: "DAG", decimals: 8, maxSupply: 10_000_000n
});

// 3. Mint tokens
const mintTxId = await client.transactions.mint({ account: dagToken, to: wallet, amount: 1000n });
await client.transactions.waitFor(mintTxId.toHex());

// 4. Consume the minted note
await client.transactions.consumeAll({ account: wallet });

// 5. Send tokens to another address
await client.transactions.send({
  account: wallet,
  to: "0xBOB",
  token: dagToken,
  amount: 100n
});

// 6. Check balance
const balance = await client.accounts.getBalance(wallet, dagToken);
console.log(`Balance: ${balance}`); // 900n

// 7. Cleanup
client.terminate();
```

### Create a New Wallet

```typescript
import { MidenClient, AccountType, AuthScheme } from "@miden-sdk/miden-sdk";

const client = await MidenClient.create();

// Default wallet (private storage, mutable, Falcon auth)
const wallet = await client.accounts.create();

// Wallet with options
const wallet2 = await client.accounts.create({
  storage: "public",
  type: AccountType.ImmutableWallet,
  auth: AuthScheme.ECDSA,
  seed: "deterministic"
});

console.log(wallet.id().toString()); // account id as hex
console.log(wallet.isPublic()); // false
console.log(wallet.isPrivate()); // true
console.log(wallet.isFaucet()); // false
```

### Create a Faucet

```typescript
const faucet = await client.accounts.create({
  type: AccountType.FungibleFaucet,
  symbol: "DAG",
  decimals: 8,
  maxSupply: 10_000_000n
});

console.log(faucet.id().toString());
console.log(faucet.isFaucet()); // true
```

### Read Faucet Metadata

`BasicFungibleFaucetComponent` extracts the on-chain token metadata from a faucet account. The same
component backs both basic and network-style faucets, so it works for either:

```typescript
import { BasicFungibleFaucetComponent } from "@miden-sdk/miden-sdk";

const faucet = BasicFungibleFaucetComponent.fromAccount(account);

faucet.symbol().toString();       // "DAG"
faucet.tokenName();               // "DAG Token"
faucet.decimals();                // 8
faucet.maxSupply().toString();    // "10000000"
faucet.tokenSupply().toString();  // amount minted so far, e.g. "0"
faucet.description();             // string | undefined
faucet.logoUri();                 // string | undefined
faucet.externalLink();            // string | undefined
```

### Send Tokens

```typescript
const txId = await client.transactions.send({
  account: wallet,
  to: "0xBOB",
  token: dagToken,
  amount: 100n
});
```

### Consume Notes

```typescript
// Sync state to discover new notes
await client.sync();

// Consume all available notes for an account
const result = await client.transactions.consumeAll({ account: wallet });
console.log(`Consumed ${result.consumed} notes, ${result.remaining} remaining`);
```

### Check Balance

```typescript
const balance = await client.accounts.getBalance(wallet, dagToken);
console.log(`Balance: ${balance}`);
```

### Batch Operations

Submit multiple operations against a single account as one atomic batch — every transaction in the batch lands together or none does. Each operation builds its own `TransactionRequest` internally; you don't have to assemble or serialize them yourself.

```typescript
const { blockNumber } = await client.transactions.batch({
  account: wallet,
  operations: [
    { kind: "send", to: alice, token: dagToken, amount: 50n, type: "public" },
    { kind: "send", to: bob,   token: dagToken, amount: 30n, type: "public" },
    { kind: "consume", notes: pendingNotes },
  ],
  waitForConfirmation: true,
});
console.log(`Batch landed in block ${blockNumber}`);
```

Operations are discriminated by `kind`: `"send"`, `"mint"`, `"consume"`, `"swap"`, `"execute"`, and `"custom"` (escape hatch for a pre-built `TransactionRequest`). The shape of each operation mirrors the singular options object (`SendOptions`, `MintOptions`, …) minus the `account` field, which is set once at the batch level.

V1 supports only same-account batches — every operation must execute against the `account` passed at the top level. Mixing accounts in one batch is not supported.

For callers that already hold pre-built `TransactionRequest`s, `submitBatch` skips the high-level builders:

```typescript
const { blockNumber } = await client.transactions.submitBatch(wallet, [
  request1,
  request2,
]);
```

The V1 batch primitive returns only the block number — there are no per-tx ids in the result. `waitForConfirmation` polls local sync height until it reaches `blockNumber` (rather than per-tx polling like singular `send` / `consume`).

### Manual Transaction Lifecycle

`client.transactions.submit(account, request)` runs execute → prove → submit → apply in one call. To drive the stages yourself — benchmarking each step or handling errors per stage — `executeRequest` returns a staged handle you advance one step at a time. Each stage carries its own context, so you never re-thread the result or block number:

```typescript
const executed = await client.transactions.executeRequest(wallet, request); // local only
const proven = await executed.prove(); // optional { prover } override
const submitted = await proven.submit(); // network; submitted.blockNumber
await submitted.apply(); // persist + fire observers
```

Nothing is persisted until `apply` runs — stopping after `submit()` leaves the local store unaware of the transaction until the next sync. `submitted.waitForConfirmation()` blocks until the transaction commits on-chain.

To submit a proof produced somewhere that shares nothing with this client (a detached prover), pass it back in with `client.transactions.submitProven(proof, result)`, which returns the same submitted handle.

### Partial-Swap (PSWAP) Orders

A partial-swap note offers one asset for another and can be filled by multiple
counterparties over time — each partial fill pays the creator and leaves a
remainder note carrying the unfilled balance. The client tracks that chain as a
**lineage** keyed by a stable `orderId`, advancing it round by round as fills
are discovered on sync.

```typescript
// Offer 100 of token A for 25 of token B.
await client.transactions.pswapCreate({
  account: wallet,
  offer: { token: aToken, amount: 100n },
  request: { token: bToken, amount: 25n }
});
await client.sync();

// The order is tracked as a lineage keyed by a stable order id.
const [lineage] = await client.pswap.lineagesFor(wallet);
const orderId = lineage.orderId();
console.log(lineage.remainingOffered().toString()); // unfilled offered balance

// A counterparty fills part of the order:
//   client.transactions.pswapConsume({ account, note, fillAmount });
// On the next sync the lineage advances, and `remainingOffered()` shrinks.

// Reclaim the unfilled remainder on the current tip, by stable order id.
// `waitForConfirmation` blocks until the cancel commits AND a sync brings
// the consumed-note update down; without it, the call resolves at submit
// time and `pswap.lineage(orderId)` still reads `Active` until the next
// sync. The lineage only transitions to `Reclaimed` once the chain sees
// the cancel land.
await client.pswap.cancelByOrder({ orderId, waitForConfirmation: true });
```

`client.pswap.lineages()` returns every order this client created;
`client.pswap.lineage(orderId)` returns one order's lineage, or `null` if it is
not tracked.

### Bridge out (AggLayer)

`client.transactions.bridge(...)` bridges a fungible asset out to another network via the AggLayer. It emits a single public B2AGG note that the bridge account consumes, burning the asset so it can be claimed at the destination Ethereum address on the AggLayer-assigned network.

```typescript
await client.transactions.bridge({
  account: wallet, // sender (executes the transaction)
  bridgeAccount: bridge, // consumes the note and burns the asset
  token: dagToken, // faucet of the asset being bridged
  amount: 100n,
  destinationNetwork: 1, // AggLayer-assigned network id
  destinationAddress: "0x000000000000000000000000000000000000dEaD"
});
```

The 20-byte destination is also available as an `EthAddress` (`EthAddress.fromHex("0x…")`) for the lower-level builders `Note.createB2AggNote(...)` and `client.newB2AggTransactionRequest(...)`.

### Network Notes

A network note is a Public note carrying a `NetworkAccountTarget` attachment; a public network account auto-consumes it once the note lands on-chain — no manual `consume` call needed on the target side.

```typescript
const { txId, note } = await client.transactions.createNetworkNote({
  account: senderId,
  target: networkAccountId,
  script: myNoteScript, // or: recipient: myRecipient
  waitForConfirmation: true,
});
console.log(note.isNetworkNote()); // true
```

Provide exactly one of `script` or `recipient`. Notes are always Public — the attachment, not the tag, is what a network account matches on. The standalone `buildNetworkNote(opts)` builds the same note without submitting.

To create the receiving account, build a **public** account carrying the network-account auth component — its note-script allowlist tells the node which notes the account may auto-consume:

```typescript
const auth = AccountComponent.createNetworkAuth([myNoteScript.root()]);
const { account } = new AccountBuilder(seed)
  .storageMode(AccountStorageMode.public())
  .withComponent(myComponent)
  .withAuthComponent(auth)
  .build();
```

The allowlist must be non-empty. Transaction scripts are forbidden unless allowlisted via the optional second argument (`TransactionScript.root()`); the component bumps the nonce itself, so the account deploys via a scriptless transaction. Readback: `account.isNetworkAccount()` and `account.networkNoteAllowlist()`.

### Cleanup

When you're finished using a MidenClient instance, call `terminate()` to release its Web Worker:

```typescript
client.terminate();

// Or use explicit resource management:
{
  using client = await MidenClient.create();
  // ... use client ...
} // client.terminate() called automatically
```

## Observability

The client reports every operation it runs — name, outcome, how long it took — to a callback you register when you construct it:

```typescript
import { MidenClient, type MidenObservation } from "@miden-sdk/miden-sdk";

const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: (o: MidenObservation) => {
    console.log(o.op, o.outcome, Math.round(o.durationMs));
  },
});
```

`observer` is a field on `ClientOptions`, so it works on `create`, `createTestnet`, and `createDevnet` alike.

**The SDK never transports an observation.** It hands the object to your callback and forgets about it. There is no telemetry dependency in `@miden-sdk/miden-sdk` — not a direct one, not a peer, not an optional one — and the module that delivers observations has no egress primitive in it and imports nothing at all. Both halves are enforced on every CI run by `js/__tests__/no-telemetry-dependency.test.js`, which parses the module rather than grepping it: it asserts the module reaches for no global object, builds no code at runtime, constructs nothing, and calls nothing but your observer. Where the observations go is entirely your decision, made in your code.

If you'd rather not write that forwarding yourself, two opt-in binding packages do it for a vendor you already run — and they hand data to a client or tracer **you** construct and configure, so they are not a transport the SDK owns either:

| Package | Turns observations into |
|---|---|
| [`@miden-sdk/telemetry-sentry`](../../packages/telemetry-sentry) | `captureMessage` calls on a Sentry client you own |
| [`@miden-sdk/telemetry-otel`](../../packages/telemetry-otel) | spans on an OpenTelemetry tracer you own |

Neither package depends on its vendor, not even as a peer — both are typed against the shape they call, so you keep control of the version, the configuration and the lifecycle.

### What an observation contains

```typescript
interface MidenObservation {
  op: string;                             // "syncState", "proveTransaction", …
  outcome: "ok" | "error";
  durationMs: number;                     // wall time the caller waited
  sensitive?: MidenObservationSensitive;  // absent by default — see below
}
```

`op` is the name of the underlying client method, not the name of the high-level call you made. One call into a resource API usually produces **several** observations: `client.transactions.send(...)` runs execute → prove → submit → apply, so it reports `executeTransaction`, `proveTransaction`, `submitProvenTransaction`, and `applyTransaction` as four separate observations. Aggregate by `op` rather than assuming a one-to-one mapping with your own call sites.

`durationMs` is measured with `performance.now()` around the awaited call, so it is a fractional millisecond value, not an integer. Round it yourself if your backend wants integers.

Two properties are worth relying on:

- **Your observer cannot fail an operation.** It is invoked inside a `try`/`catch` that swallows everything it throws. A broken observer degrades to silence, never to a failed transaction.
- **Your observer cannot slow an operation down or change its shape.** It is called synchronously, after the operation has already settled, on the path that was going to resolve or reject anyway. Nothing is queued, batched, or deferred. Keep the callback cheap — it runs on the caller's critical path.

A mock client (`MidenClient.createMock()`) can neither register an observer nor enable the sensitive channel — `MockOptions` carries neither field, so nothing you pass to `createMock` reaches the sink. It is not silent, though: registration is process-wide (see below), so if a real client registered an observer earlier in the same process, a mock client's operations report to it as well. The three sync methods the mock overrides — `syncState`, `syncChain`, and `syncNoteTransport` — are the exception and emit nothing.

### The sink is process-wide, and there is one of it

Registration is global to the module, not scoped to the client instance. Constructing a second client with an `observer` **replaces** the first one's — both clients then report to the newest callback. If you need to fan out to more than one destination, do it inside your own callback.

There is no public way to unregister: `observer` is a construction-time option, and passing a non-function (including `null`) leaves any previously registered observer in place rather than clearing it. Register the sink you want for the life of the process.

### Sensitive detail — read this before enabling it

By default, the `sensitive` key is **absent from the observation object entirely**. Not `undefined`, not an empty object — absent, so `"sensitive" in observation` is a truthful test of whether the channel is on, and a consumer can distinguish "not enabled" from "enabled but nothing to report".

Passing `observeSensitive: true` at construction turns it on:

```typescript
const client = await MidenClient.create({
  rpcUrl: "testnet",
  observeSensitive: true, // discloses raw error text — read on before setting
  observer: (o) => myErrorReporter(o),
});
```

What that actually exposes:

```typescript
interface MidenObservationSensitive {
  errorMessage?: string; // verbatim error message, exactly as thrown
  errorStack?: string;   // verbatim stack trace
  accountId?: string;    // declared; not currently populated by the SDK
}
```

Be clear-eyed about what "verbatim" means. `errorMessage` is the untouched `error.message` coming out of the client and, below it, the Rust core — it is not classified, redacted, allow-listed, or truncated, and no filter stands between it and your observer. Whatever a failure happens to say about the account, note, or asset it was working on is what you receive, and error text is not a stable interface: a client upgrade can widen it without warning. `errorStack` is the untouched stack. Anything you would be uncomfortable seeing in your telemetry vendor's UI, in its search index, and in its retention window is something you should assume will end up there.

The rest of the shape, so you can plan around it:

- The channel is populated **only on failure**. A successful operation has no `sensitive` key even with the flag on, so this is not a way to see which accounts a user touched — only which ones produced errors.
- `accountId` is declared in the type but the SDK does not currently populate it. Do not write code that depends on it being present; treat it as reserved. (The OTel binding already reads it defensively, so it will start working if a later version fills it in.)
- The safe fields never carry any of this. `op` and `outcome` are drawn from a fixed vocabulary and `durationMs` is a number, so an observation with the channel off is fit to send anywhere.

The flag is deliberately hard to switch on by accident:

- **Only the literal boolean `true` enables it.** A truthy `"true"` from an environment variable, a query string, or a JSON round-trip reads as *off*. An ambiguous value is far likelier to be a wiring mistake than a decision to disclose user data, so it is read the safe way.
- **It is sealed at construction.** The resolved value is written once with `Object.defineProperty` as non-writable and non-configurable, so no later assignment — by your code, by a plugin, or by ours — can turn disclosure on for a client that was built without it. Enabling it has to be a deliberate, greppable act at one call site.
- **It is per-client, while the observer is global.** If you run one client with the flag and one without, observations from both arrive at the same callback and whether `sensitive` is present depends on which client ran that operation.
- **Enabling it logs a console warning**, once per process.

Leave it unset in any application with confidentiality obligations to its users. A wallet, for example, must never enable it.

Both binding packages then require the disclosure a *second* time — `includeSensitive: true` — and drop the channel by default even when the SDK supplies it. Leaving either end alone is enough to keep it out of your vendor.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
