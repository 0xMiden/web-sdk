# @miden-sdk/vite-plugin

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
`node_modules` unprompted, so point yours at it with `npm create @miden-sdk@latest`,
or paste this into your project's root `AGENTS.md` or `CLAUDE.md` by hand:

```markdown
<!-- BEGIN:miden-agent-rules -->
## Miden

This project uses the Miden web SDK. Your training data is likely out of date —
Miden is pre-1.0 and its API changes between minor versions.

Before writing or reviewing Miden code, read the version-matched guide for the
package you are touching:

- `node_modules/@miden-sdk/miden-sdk/AGENTS.md` — core client
- `node_modules/@miden-sdk/react/AGENTS.md` — React hooks
- `node_modules/@miden-sdk/vite-plugin/AGENTS.md` — bundler setup

Each one indexes task-specific skills in its package's `skills/` directory.
Read the relevant skill before implementing, not after.
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
  crossOriginIsolation: true,                      // default
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
- **Default:** `true`
- Adds `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers to the dev server. Required for `SharedArrayBuffer` (used by WASM workers).

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
