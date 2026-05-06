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

The following are just a few simple examples to get started. For more details, see the [API Reference](../../docs/typedoc/web-client/README.md).

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

## License

This project is licensed under the MIT License - see the LICENSE file for details.
