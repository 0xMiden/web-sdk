# @miden-sdk/vite-plugin

## Start here

```bash
npm create @miden-sdk@latest
```

Run that once in your project. Miden is pre-1.0 and its API moves between minor
versions, so an AI coding agent working from training data will write code for a
version you are not on. Every `@miden-sdk/*` package ships an `AGENTS.md` and
task-scoped `skills/` inside its tarball, matched to the exact version in your
lockfile - this command is what points your agent at them, by writing the
pointers into your own `AGENTS.md` and `CLAUDE.md`. It is idempotent, so re-run
it after an upgrade.

Prefer to wire it up by hand? The block to paste is [below](#for-ai-coding-agents).

Starting from nothing rather than adding to an existing app?
[`0xMiden/agentic-template`](https://github.com/0xMiden/agentic-template)
scaffolds the whole stack with this already done.

Vite plugin for Miden dApps. Automates WASM deduplication, cross-origin isolation headers, and gRPC-web proxy configuration.

## Installation

```bash
npm install @miden-sdk/vite-plugin --save-dev
# or
pnpm add @miden-sdk/vite-plugin --dev
```

## For AI coding agents

This package ships `AGENTS.md` and a `skills/vite-wasm-setup/` guide inside the
tarball, version-matched to the code you installed. Agents do not read
`node_modules` unprompted, so paste this into your project's root `AGENTS.md`
or `CLAUDE.md`:

```markdown
<!-- BEGIN:miden-agent-rules -->
## Miden

This project uses the Miden web SDK. Your training data is likely out of date:
Miden is pre-1.0 and its API changes between minor versions.

Before writing or reviewing Miden code, read the version-matched guide that
ships inside the package you are touching:

- `node_modules/@miden-sdk/<package>/AGENTS.md`, for any `@miden-sdk/*` package
  you import. Start with `miden-sdk` (core client), `react` (hooks) and
  `vite-plugin` (bundler setup).

Each guide indexes task-specific skills in that package's `skills/` directory.
Read the relevant skill before implementing, not after.

These files ship in the published tarball, so they describe the exact version
you have installed. The version is in the same directory's `package.json`; if a
guide disagrees with what you expected, the guide is right and your assumption
is stale.
<!-- END:miden-agent-rules -->
```

## Usage

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

export default defineConfig({
  plugins: [
    midenVitePlugin(), // zero-config: all defaults
    react(),
  ],
});
```

### With Options

```typescript
midenVitePlugin({
  rpcProxyTarget: "https://rpc.testnet.miden.io", // default
  rpcProxyPath: "/rpc.Api",                        // default
  crossOriginIsolation: false,                     // default
  wasmPackages: ["@miden-sdk/miden-sdk"],           // default
});
```

## What It Does

| Config | Purpose |
|--------|---------|
| `resolve.alias` | Force single copy of WASM module (avoids class identity issues) |
| `resolve.dedupe` | Vite deduplication hint |
| `resolve.preserveSymlinks` | Monorepo/symlink support |
| `optimizeDeps.exclude` | Don't pre-bundle WASM packages |
| `server.headers` (COOP/COEP) | SharedArrayBuffer for WASM workers |
| `server.proxy` | gRPC-web CORS bypass in dev |
| `build.target: "esnext"` | Top-level await for WASM |
| `worker.format: "es"` | ES module workers for WASM |

## Options

### `wasmPackages`
- **Type:** `string[]`
- **Default:** `["@miden-sdk/miden-sdk"]`
- Packages to deduplicate and exclude from pre-bundling.

### `crossOriginIsolation`
- **Type:** `boolean`
- **Default:** `false`
- Adds `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers to the dev server. Required for `SharedArrayBuffer`, which the multi-threaded build's WASM workers need, so turn it on when you import from `@miden-sdk/miden-sdk/mt`. It is off by default because the headers change how the whole page behaves: once they are set, third-party embeds, images and scripts served without the matching CORS headers stop loading, and the breakage usually shows up far from this config.

### `rpcProxyTarget`
- **Type:** `string | false`
- **Default:** `"https://rpc.testnet.miden.io"`
- gRPC-web proxy target URL for the dev server. Set to `false` to disable.

### `rpcProxyPath`
- **Type:** `string`
- **Default:** `"/rpc.Api"`
- Path prefix for gRPC-web proxy requests.

## Requirements

- Vite 5.x or 6.x

## License

MIT
