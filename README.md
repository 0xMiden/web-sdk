<div align="center">

# Miden Web SDK

**The browser- and JavaScript-native SDK for the [Miden network](https://miden.xyz).**

WASM-powered client, React hooks, and Vite tooling — sign, send, and prove transactions from a tab.

[![CI](https://github.com/0xMiden/web-sdk/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/0xMiden/web-sdk/actions/workflows/test.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/0xMiden/web-sdk/badges/coverage.json)](https://github.com/0xMiden/web-sdk/actions/workflows/test.yml?query=branch%3Amain)
[![npm: @miden-sdk/miden-sdk](https://img.shields.io/npm/v/@miden-sdk/miden-sdk?label=%40miden-sdk%2Fmiden-sdk&color=cb3837)](https://www.npmjs.com/package/@miden-sdk/miden-sdk)
[![npm: @miden-sdk/react](https://img.shields.io/npm/v/@miden-sdk/react?label=%40miden-sdk%2Freact&color=61dafb)](https://www.npmjs.com/package/@miden-sdk/react)
[![Rust 1.93](https://img.shields.io/badge/rust-1.93-orange?logo=rust)](rust-toolchain.toml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

## What's in here

This repo packages everything you need to interact with Miden from a browser, a Web Worker, or a React app:

| Package | Purpose | Install | Docs |
|---|---|---|---|
| **[`@miden-sdk/miden-sdk`](https://docs.miden.xyz/builder/tools/clients/web-client/)** | The Rust client compiled to WASM, with TypeScript bindings. The brains of the operation — accounts, notes, transactions, proving, RPC. | `pnpm add @miden-sdk/miden-sdk` | [Web Client docs ↗](https://docs.miden.xyz/builder/tools/clients/web-client/) |
| **[`@miden-sdk/react`](https://docs.miden.xyz/builder/tools/clients/react-sdk/)** | React hooks (`useAccount`, `useNotes`, `useSend`, `useConsume`, ...) over the WASM client. Signer-agnostic — pluggable with MidenFi, Para, Turnkey. | `pnpm add @miden-sdk/react` | [React SDK docs ↗](https://docs.miden.xyz/builder/tools/clients/react-sdk/) |
| **`@miden-sdk/vite-plugin`** | Drop-in Vite plugin that handles WASM dedup, the worker-context node polyfills, and a few footguns we're tired of stepping on. | `pnpm add -D @miden-sdk/vite-plugin` | — |
| **`miden-idxdb-store`** *(Rust crate)* | The IndexedDB-backed store the WASM client uses for persisting accounts, notes, MMR data, and sync state. Published to crates.io for Rust consumers building their own browser clients. | `cargo add miden-idxdb-store` | — |

Everything is published from this monorepo, in lockstep with the upstream Rust [`miden-client`](https://github.com/0xMiden/miden-client).

---

## Documentation

- **[Web Client](https://docs.miden.xyz/builder/tools/clients/web-client/)** — full API reference for `@miden-sdk/miden-sdk`: `MidenClient`, accounts, notes, transactions, sync, prover.
- **[React SDK](https://docs.miden.xyz/builder/tools/clients/react-sdk/)** — every hook, with prop tables, return shapes, and copy-pasteable examples.
- **[`miden-client` crate](https://docs.rs/miden-client)** — the upstream Rust client these bind to.
- **[Network docs](https://docs.miden.xyz)** — protocol, accounts model, note semantics, mainnet/testnet endpoints.

---

## Quick start

### Vanilla JavaScript

```ts
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.create({
  endpoint: "https://rpc.testnet.miden.xyz",
});

const account = await client.accounts.create({ storage: "public" });
console.log("New account:", account.id().toBech32());

await client.syncState();
```

### React

```tsx
import { MidenProvider, useAccount, useSend } from "@miden-sdk/react";

function App() {
  return (
    <MidenProvider config={{ endpoint: "https://rpc.testnet.miden.xyz" }}>
      <Wallet senderId="mtst1q...sender" />
    </MidenProvider>
  );
}

function Wallet({ senderId }: { senderId: string }) {
  const { account, isLoading } = useAccount(senderId);
  const { send, isLoading: sending, stage, error } = useSend();

  const handleSend = async () => {
    const result = await send({
      from: senderId,
      to: "mtst1q...recipient",
      assetId: "mtst1q...faucet",
      amount: 100n,
    });
    console.log("Tx:", result.transactionId);
  };

  if (isLoading || !account) return <p>Loading…</p>;
  return (
    <button onClick={handleSend} disabled={sending}>
      {sending ? stage : `Send from ${account.id().toBech32()}`}
      {error && <span> — {error.message}</span>}
    </button>
  );
}
```

### Vite app setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

export default defineConfig({
  plugins: [midenVitePlugin()],
});
```

---

## Eager vs lazy entry points

The SDK ships with two parallel entry points so you can trade WASM init time against bundle reach:

| Specifier | When it loads WASM | Use this when |
|---|---|---|
| `@miden-sdk/miden-sdk` | At import (top-level await) | Server-rendered apps where the user will definitely use the SDK |
| `@miden-sdk/miden-sdk/lazy` | Deferred until first method call | Apps where most users never touch crypto (multi-megabyte WASM stays uncached until needed) |

The same split applies to `@miden-sdk/react`. The choice cascades: if you use `@miden-sdk/react/lazy`, it pulls `@miden-sdk/miden-sdk/lazy` automatically; the eager variant pulls eager.

---

## Architecture

```mermaid
%%{init: {'theme':'base', 'themeVariables': {
  'primaryColor':'#1e293b',
  'primaryTextColor':'#f8fafc',
  'primaryBorderColor':'#475569',
  'lineColor':'#94a3b8',
  'secondaryColor':'#1e293b',
  'tertiaryColor':'#0b1220',
  'fontSize':'15px'
}}}%%
flowchart TB
  classDef app      fill:#1e293b,stroke:#64748b,stroke-width:2px,color:#f8fafc
  classDef hooks    fill:#7c3aed,stroke:#a78bfa,stroke-width:2px,color:#f8fafc
  classDef wasm     fill:#db2777,stroke:#f472b6,stroke-width:2px,color:#f8fafc
  classDef store    fill:#0d9488,stroke:#5eead4,stroke-width:2px,color:#f8fafc
  classDef network  fill:#0284c7,stroke:#7dd3fc,stroke-width:2px,color:#f8fafc
  classDef chain    fill:#475569,stroke:#cbd5e1,stroke-width:2px,color:#f8fafc,stroke-dasharray:6 4

  subgraph Browser["Browser tab / Web Worker"]
    direction TB
    App["Your dApp"]:::app
    ReactSDK["@miden-sdk/react"]:::hooks
    WasmSDK["@miden-sdk/miden-sdk<br/>(WASM client + prover)"]:::wasm
    IDB[("miden-idxdb-store<br/>(IndexedDB)")]:::store

    App --> ReactSDK
    ReactSDK --> WasmSDK
    WasmSDK <--> IDB
  end

  RPC["gRPC-web"]:::network
  Node["Miden node"]:::network
  Chain[("Miden chain")]:::chain

  WasmSDK -- "submit / sync" --> RPC
  RPC --> Node
  Node --> Chain

  style Browser fill:#0b1220,stroke:#1e293b,stroke-width:2px,color:#f8fafc
```

- **`miden-idxdb-store`** persists everything the client needs to survive a tab reload — accounts, notes, the partial MMR, sync state, key material.
- **`@miden-sdk/miden-sdk`** wraps the upstream Rust [`miden-client`](https://github.com/0xMiden/miden-client) crate as a `wasm32-unknown-unknown` library with `wasm-bindgen` JS bindings. All the proving, signing, and tx execution lives here.
- **`@miden-sdk/react`** is a thin layer on top: React hooks that call into the WASM client and a pluggable `SignerContext` so the same code works with MidenFi, Para, Turnkey, or your own signer.
- **`@miden-sdk/vite-plugin`** smooths over the bundler-side WASM ergonomics (worker-context polyfills, COOP/COEP headers, dedup of the WASM module across imports).

---

## Examples

| Example | What it shows | Path |
|---|---|---|
| **Wallet** | Full flow — signer choice (MidenFi / Para / Turnkey via `MultiSignerProvider`), account creation, sync, send, consume | [`packages/react-sdk/examples/wallet`](packages/react-sdk/examples/wallet) |

Run locally:

```bash
# From the repo root: install workspace + build the React SDK.
pnpm install
pnpm --filter @miden-sdk/react run build

# The example is intentionally OUTSIDE the workspace; --ignore-workspace
# tells pnpm to treat it as a standalone project.
cd packages/react-sdk/examples/wallet
pnpm install --ignore-workspace
pnpm dev
```

---

## Bundler & runtime support

| Bundler / runtime | Status | Notes |
|---|---|---|
| **Vite** | First-class | `@miden-sdk/vite-plugin` covers WASM dedup, polyfills, COOP/COEP. Tested against Vite 5+. |
| **Webpack 5** | Supported | Use the module-worker variant; webpack auto-handles the `import.meta.url` worker pattern. |
| **Next.js (App Router)** | Supported | Mark client components with `"use client"`. SSR will skip WASM init; the lazy entry point is recommended. |
| **Browser (Chromium ≥ 88)** | Supported | Required: WASM threads (`SharedArrayBuffer`), so cross-origin isolation headers are mandatory in production. |
| **Browser (Safari ≥ 16.4)** | Supported | The plugin auto-applies the classic-Worker + TLA-free WASM glue needed by WKWebView. |
| **Browser (Firefox ≥ 108)** | Supported | Same constraints as Chromium. |
| **Node.js** | Not yet | Tracked separately; the Rust client has a Node.js binding in flight via napi-rs. |

The published WASM artifact targets `wasm32-unknown-unknown` with `+atomics +bulk-memory +mutable-globals` enabled.

---

## Versioning

Every package in this repo (`@miden-sdk/miden-sdk`, `@miden-sdk/react`, `@miden-sdk/vite-plugin`, plus the Rust `miden-idxdb-store` crate) ships on the **same major.minor** as the upstream `miden-client` they bind to. Patch versions are independent — a fix in the React hooks does not need a WASM bump.

A repo-wide `scripts/check-react-sdk-sync.js` enforces that React peer ranges and example dependencies pin to the exact patch version of the WASM client they were built against, so `npm install` resolves to a coherent set without surprises.

---

## Development

```bash
# Once
rustup target add wasm32-unknown-unknown
npm install -g pnpm@9     # or: corepack enable && corepack prepare pnpm@9 --activate
pnpm install              # installs the entire workspace

# Build everything
make build-wasm                                    # WASM client only
make build-web-client                              # WASM + JS bindings + dist
make build-react-sdk                               # WASM + React layer

# Lint + format
make clippy-wasm                                   # Rust lints (WASM target)
make format                                        # Cargo fmt + prettier
make typos-check                                   # Spellcheck

# Test
make test-react-sdk                                # Vitest unit tests
make integration-test-web-client                   # Playwright integration (chromium)
```

The CI workflow runs all of the above on every PR; pushes to `main` and `next` additionally save build caches (sccache + Swatinem/rust-cache) so subsequent PRs warm-start.

### Project layout

```
web-sdk/
├── crates/
│   ├── idxdb-store/       # Rust IndexedDB store (miden-idxdb-store on crates.io)
│   └── web-client/        # WASM + JS bindings (@miden-sdk/miden-sdk on npm)
└── packages/
    ├── react-sdk/         # @miden-sdk/react
    │   └── examples/
    │       └── wallet/    # Cross-signer example app
    └── vite-plugin/       # @miden-sdk/vite-plugin
```

---

## Releasing

Two long-lived branches:
- **`main`** — released to npm under the `latest` tag. Stable.
- **`next`** — pre-release integration. Released to npm under the `next` tag when a PR carries the `patch release` label.

The publish workflow gates the WASM artifact with a 25 MB upper-bound check — if `wasm-opt` ever silently fails (the rollup plugin swallows errors), the bloated binary never reaches npm.

---

## Contributing

We welcome PRs. Before opening one:

1. Read [CLAUDE.md](CLAUDE.md) for repo-specific conventions and tooling notes.
2. Run `make lint test` locally — CI runs the same suite, but local feedback is faster.
3. For changes that touch the public API surface (hooks, WASM bindings, plugin options), include or update the type tests in `crates/web-client/scripts/check-*-types.js`.

The upstream Rust SDK lives at [`0xMiden/miden-client`](https://github.com/0xMiden/miden-client); changes that touch shared types or the gRPC schema usually need a coordinated PR there first.

---

## License

[MIT](LICENSE) © Miden contributors

<div align="center">
  <sub>Built with Rust 1.93, wasm-bindgen, and a healthy distrust of top-level await.</sub>
</div>
