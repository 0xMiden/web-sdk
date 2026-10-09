---
name: vite-wasm-setup
description: Guide to configuring Vite for Miden WASM applications. Covers the midenVitePlugin() setup, COOP/COEP headers, production deployment headers, TypeScript compatibility, and troubleshooting common Vite + WASM issues. Use when setting up a new Miden frontend, debugging build or runtime errors related to WASM or Vite configuration, or deploying to production.
---

# Vite + WASM Configuration for Miden

## Required `vite.config.ts`

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

export default defineConfig({
  plugins: [react(), midenVitePlugin()],
});
```

**Vite 5 or 6.** `@miden-sdk/vite-plugin` declares `peerDependencies.vite: "^5.0.0 || ^6.0.0"`. A fresh `npm create vite` scaffold is on Vite 7 and will not satisfy that peer, so pin Vite to 6 for now, and read the plugin's own `peerDependencies` before assuming a newer major works.

`midenVitePlugin` is exported both as a named export and as the default export, so `import midenVitePlugin from "@miden-sdk/vite-plugin"` works too. It declares `enforce: "pre"`, so its `config` hook runs ahead of other plugins'.

`midenVitePlugin()` works with no options for the common case: the default `@miden-sdk/miden-sdk` / `@miden-sdk/react` imports ship **single-threaded (ST)** WASM that loads in any browser context, so the default client runs with no cross-origin isolation. The plugin's `crossOriginIsolation` option defaults to `false` for the same reason, and the in-repo example wallet app (`packages/react-sdk/examples/wallet/vite.config.ts` in `0xMiden/web-sdk`) calls `midenVitePlugin()` bare. Don't reach for `crossOriginIsolation: true` unless you have actually opted into the multi-threaded build (see below).

It composes with other Miden plugins: the same example config runs `midenVitePlugin()` alongside `paraVitePlugin()` from `@miden-sdk/para-react/vite` when the Para signer is in play.

Pass `crossOriginIsolation: true` **only** if you import the **multi-threaded (MT)** WASM variant: `@miden-sdk/miden-sdk/mt` (or `/mt/lazy`) and `@miden-sdk/react/mt` (or `/mt/lazy`). The MT build uses `wasm-bindgen-rayon` and `SharedArrayBuffer` / `WebAssembly.Memory({ shared: true })` for ~3-5x faster local proving, which the browser only constructs when the page is cross-origin-isolated (COOP `same-origin` + COEP `require-corp`). On the default ST imports those headers are unnecessary.

Cross-origin isolation is what the browser needs. It is not something you then have to
bootstrap by hand on the default path.

**Do not add a main-thread `initThreadPool` call to a worker-backed client.** With the
default `useWorker !== false`, the SDK runs every prove inside its own Worker, and that
Worker brings up its own rayon pool: the client passes `navigator.hardwareConcurrency` to
it when the page is cross-origin-isolated, and the Worker calls `initThreadPool` before
constructing its `WebClient`. rayon's global pool is per WASM instance, and the Worker's
instance is not the page's, so a call you make on the main thread initializes a pool that
no prove ever runs on. It is not harmful, it is simply inert, which is worse to debug than
an error.

Call it yourself in exactly one case: a direct MT client on the current thread, which means
`useWorker: false` or an environment with no Worker support. Then the pool has to come up
in the same realm as the client.

```typescript
import { MidenClient, initThreadPool } from "@miden-sdk/miden-sdk/mt/lazy";

await MidenClient.ready();
await initThreadPool(navigator.hardwareConcurrency); // same realm as the direct MT client
const client = await MidenClient.create({ useWorker: false, feeFaucetId: FEE_FAUCET });
```

The ST entries don't expose `initThreadPool`, because there is no pool to bring up.

If your app must host third-party iframes, OAuth popups, or other cross-origin resources that don't emit `require-corp`, stay on the default ST imports and leave `crossOriginIsolation: false` (the default). You keep a fully working Miden client and only forgo MT-accelerated local proving on that route. Enabling `crossOriginIsolation: true` also breaks OAuth-popup flows (e.g. Para), because `same-origin` COOP nullifies `window.opener` in popups. If you genuinely need both MT proving and cross-origin resources, embed the latter via `credentialless` COEP as a workaround (see the Gotchas section below).

## Eager vs lazy entry points

Orthogonal to ST vs MT, each threading variant ships an **eager** and a **lazy** entry, so there are four in all. The eager entry (`@miden-sdk/miden-sdk`, `@miden-sdk/miden-sdk/mt`) loads the WASM at import, using top-level `await`. The lazy entry (`/lazy`, `/mt/lazy`) defers it to the first `await MidenClient.ready()` or the first awaited SDK method.

Use the eager entry for an ordinary Vite browser bundle, where top-level await is fine. Use the lazy entry wherever it is not: server-side rendering (Next.js, Remix, SvelteKit) and Capacitor WKWebView hosts. `@miden-sdk/react` splits the same way, and `@miden-sdk/react/lazy` pulls `@miden-sdk/miden-sdk/lazy`. The APIs are identical; only the initialization timing differs.

## What midenVitePlugin() Handles

`@miden-sdk/vite-plugin` abstracts Miden-specific Vite configuration. It implements only the `config` and `configResolved` hooks, and it does **not** register a `.wasm` module loader, because Vite's built-in handling does the actual `.wasm` import. What the plugin sets up:

- **WASM and React dedup / single copy** - `resolve.alias` (exact-match regex, so subpath imports like `/lazy` still resolve through the package's `exports` map), `resolve.dedupe` and `resolve.preserveSymlinks` force a single resolved copy of `@miden-sdk/miden-sdk` **and** of `react`, `react-dom`, `react/jsx-runtime` and `@miden-sdk/react` (avoids WASM class-identity issues across symlinked/monorepo setups). The alias replacement is resolved with `require.resolve` on the package's `package.json`, rather than joined onto `<root>/node_modules`, so it stays correct under pnpm and Yarn Plug'n'Play; a bare `node_modules` path is only the fallback when that throws. The dedupe list is re-applied in `configResolved`, after every other plugin's `config()` hook, so another plugin can't clobber it
- **optimizeDeps.exclude** - Excludes `@miden-sdk/miden-sdk` from pre-bundling (pre-bundling corrupts the WASM binary)
- **Top-level await** - Sets `build.target: "esnext"` for the production build, and `optimizeDeps.esbuildOptions.target: "esnext"` for dev pre-bundling when you haven't set one. Both are needed: the WASM SDK's initialization uses top-level `await`, and dev and build compile it through different pipelines
- **ES-module workers** - Sets `worker.format: "es"` and `worker.rollupOptions.output.format: "es"`, required for the WASM SDK's module workers
- **COOP/COEP headers (opt-in, MT only)** - `crossOriginIsolation` defaults to `false`. When set to `true`, emits `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` on **both** the Vite dev server and the Vite preview server (see Production Deployment Headers). Only needed to satisfy the cross-origin-isolation requirement of the MT WASM variant; the default ST build doesn't need these headers
- **gRPC-web dev proxy** - Proxies `rpcProxyPath` (default `/rpc.Api`) to `rpcProxyTarget` (default `https://rpc.testnet.miden.io`) during `vite` (serve) to bypass CORS in dev; set `rpcProxyTarget: false` to disable
- **React context dedup** - Externalizes `@miden-sdk/react` during esbuild pre-bundling so signer-provider React contexts share one identity

The two remaining options are rarely needed: `wasmPackages` (default `["@miden-sdk/miden-sdk"]`) is the list the alias, dedupe and `optimizeDeps.exclude` entries are generated from, and `rpcProxyPath` (default `"/rpc.Api"`) is the proxied path prefix.

You don't need to install or configure `vite-plugin-wasm`, `vite-plugin-top-level-await`, or dexie aliases manually.

## Required Dependencies

Two packages move together as the core SDK pair: `@miden-sdk/miden-sdk` (the WASM client) and `@miden-sdk/react` (the React hooks). They link against the same WASM ABI, but the binding contract is a **peer range, not an equal version string**. Read `@miden-sdk/react`'s `peerDependencies` on `@miden-sdk/miden-sdk` in your installed copy rather than assuming the two numbers match: on the 0.16 line they don't, since react-sdk `0.16.0` peers on `^0.16.1`.

```json
{
  "dependencies": {
    "@miden-sdk/react": "<satisfies its own peer range on miden-sdk>",
    "@miden-sdk/miden-sdk": "<authoritative core version>",
    "@miden-sdk/miden-wallet-adapter-react": "<peers on BOTH core packages>"
  },
  "devDependencies": {
    "@miden-sdk/vite-plugin": "<versioned separately - see your package.json>"
  }
}
```

Notes:
- **`@miden-sdk/react` and `@miden-sdk/miden-sdk` must be a compatible pair**, since a mixed pair (one built against an older WASM ABI, one against the current) won't link. The peer range is what defines compatible; upgrade them together and let the package manager check it.
- **`@miden-sdk/vite-plugin` is versioned separately, and may or may not match.** It matched the core SDK exactly at every 0.16.0 tag, then stayed at `0.16.0` when the SDK moved to `0.16.1`. Never infer one version from the other in either direction. Read your app's `package.json` for the authoritative plugin pin.
- **The wallet adapters ship from the SDK's own repo since 0.16.** The five `@miden-sdk/miden-wallet-adapter*` packages are built from `packages/adapter/` in [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk) and released on the same line (all `0.16.0` at the 0.16.0 release). `@miden-sdk/miden-wallet-adapter-react` peers on **both** core packages, at independent ranges (`@miden-sdk/react` and `@miden-sdk/miden-sdk`), so read both from your installed copy rather than deriving them from one number.
- **Always check your app's `package.json` for the authoritative versions** - this skill intentionally doesn't inline them, because they shift across SDK releases.
- When you bump, do a clean install with your project's package manager: delete `node_modules` and the lockfile it actually uses, then reinstall. The web-sdk itself uses pnpm (`rm -rf node_modules pnpm-lock.yaml && pnpm install`). For an app repo, use whatever package manager its lockfile implies, whether that is `npm ci`, `yarn install` or `pnpm install`. Vite's dep optimizer caches resolved SDK paths, and stale caches can surface as `ERR_BLOCKED_BY_RESPONSE` or spurious `Failed to fetch` errors on module workers.

## Production Deployment Headers

These headers apply **only if you ship the MT WASM variant** (`/mt` or `/mt/lazy`). The default ST build needs none of this, so skip the whole section if you're on the default imports. If you are on MT, the COOP/COEP headers must be set on the production server: `midenVitePlugin({ crossOriginIsolation: true })` only emits them on the Vite dev server (`vite`) and the Vite preview server (`vite preview`), and does not touch your real production host. Configure the headers separately on nginx/Vercel/Cloudflare/etc.

The maintained host reference is the "Setting cross-origin isolation headers" section of `crates/web-client/README.md` in [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk) (shipped as the `@miden-sdk/miden-sdk` npm README). It covers forms this skill does not list: Next.js (`next.config.mjs` `headers()`), Express / generic Node (`res.setHeader`), and MV3 browser-extension manifests (`"cross_origin_opener_policy": { "value": "same-origin" }`). Check it before hand-rolling a host config.

### Nginx
```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

### Vercel (vercel.json)
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

### Cloudflare Pages (_headers)
```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

### WASM MIME Type
Ensure your server serves `.wasm` files with `application/wasm` MIME type.

## COOP/COEP Gotchas

These gotchas only apply once you've enabled cross-origin isolation for the MT build. The default ST build sets no such headers and is unaffected. When COOP `same-origin` + COEP `require-corp` are in force, they break:
- **Third-party iframes** (YouTube embeds, Twitter embeds, analytics)
- **External scripts** without CORS headers
- **OAuth popups** from different origins

Workaround: Use `credentialless` for COEP if you need cross-origin resources:
```
Cross-Origin-Embedder-Policy: credentialless
```

Note: `credentialless` provides weaker isolation but allows most cross-origin resources.

If you cannot set the headers at all - a CDN or hosting provider that allows no header injection - the documented escape hatch is the COI service-worker shim pattern (`gzuidhof/coi-serviceworker`): a small same-origin service worker intercepts fetches and re-injects the headers on the way back. The SDK deliberately does not bundle it, because installing a service worker into a consumer's app is intrusive. Adopt it as a conscious decision, not a default.

## TypeScript Compatibility

Standard Vite-compatible tsconfig settings work with Miden. The only actual constraint is ES2020+ for `bigint` support:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler"
  }
}
```

`module: "ESNext"` and `moduleResolution: "bundler"` are standard Vite defaults, not Miden-specific requirements. If you're using the Vite-generated tsconfig, no changes are needed beyond ensuring `target` is ES2020+.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| "SharedArrayBuffer is not defined", or "WebAssembly.Memory: shared memory requires crossOriginIsolated" thrown out of `__wbg_init` (MT build only) | Importing `/mt` or `/mt/lazy` on a page where `self.crossOriginIsolated === false` at import time | Set `midenVitePlugin({ crossOriginIsolation: true })` and add the COOP/COEP headers on your production host; or switch back to the default ST imports, which don't need them |
| A direct MT client with `useWorker: false` is no faster than ST, with no error | Its current-thread WASM instance has no initialized rayon pool, so every parallel loop runs sequentially | `await initThreadPool(navigator.hardwareConcurrency)` in that client's own realm. Do NOT add this to the default worker-backed path - a `ThreadPoolBoot`-style component rendered inside a default `MidenProvider` is inert, because the Worker initializes its own pool. In React, `useWorker` is set on `MidenConfig` and forwarded to both `createClient` and `createClientWithExternalKeystore` |
| Top-level await crashes under SSR or in a Capacitor WKWebView | The eager entry initializes WASM at import | Import the lazy entry (`@miden-sdk/miden-sdk/lazy`, `@miden-sdk/react/lazy`) and `await MidenClient.ready()` |
| WASM module not found | SDK not configured correctly | Ensure `midenVitePlugin()` is in plugins array |
| "Top-level await not supported" | Missing plugin setup, or an `optimizeDeps.esbuildOptions.target` you set below `esnext` | Ensure `midenVitePlugin()` is in plugins array; if you set that target yourself, the plugin leaves it alone |
| WASM init hangs | COEP blocking WASM fetch | Check network tab for blocked requests; verify COOP/COEP headers are present |
| Build succeeds but WASM fails at runtime | Wrong MIME type | Serve .wasm as application/wasm |
| "recursive use of an object" | Concurrent WASM access | Use runExclusive() from useMiden() |
| Double initialization in dev | React StrictMode | Use MidenProvider (handles this internally) |
| A failed VM assertion reports only an error code, with no message | Production builds strip the MASM debug metadata (source spans, `assert.err` message text) out of the Miden packages embedded in the WASM binary - that strip is what takes the ST build from 27.4 MB to 18.8 MB | Reproduce against a dev build, which keeps full diagnostics: `MIDEN_WEB_DEV=true` when building `@miden-sdk/miden-sdk` (the `build-dev` script, and what `make integration-test-web-client` uses) |
