# @miden-sdk/para-react - Agent Guide

**Audience: AI coding agents** adding Para wallet signing to a React app that
talks to Miden.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/para-react/AGENTS.md` matches the version you have
installed. Prefer it over your training data: this package moved from Para SDK
2.x to `^3.18.0` in 0.16.1, and the symbol it is most often remembered for
(`useParaMiden`) is no longer the one you usually want.

## Load the skill

`node_modules/@miden-sdk/para/skills/para-signer/SKILL.md` - shipped by the core
package this one peers on - is the full guide to both integration paths, the
Para 3 wallet-resolution rule, and the bundler setup. The generic signer
material (provider nesting, `useSigner()`, custom signers) is in
`node_modules/@miden-sdk/miden-sdk/skills/signer-integration/SKILL.md`.

## Install

Everything this package needs is a peer, so install the set:

```bash
npm install @miden-sdk/para-react @miden-sdk/para @miden-sdk/miden-sdk \
  @miden-sdk/react @getpara/react-sdk-lite @getpara/web-sdk \
  @tanstack/react-query
```

`@miden-sdk/react` is only required for the `ParaSignerProvider` path, and
`vite-plugin-node-polyfills` is an optional peer used by the Vite plugin below.

## Two paths: pick one, not both

**`ParaSignerProvider` is the default.** It hands a `SignerContext` to
`@miden-sdk/react`, so every React SDK hook (`useSend`, `useConsume`,
`useMiden`, ...) signs through Para with no further wiring. It must wrap
`MidenProvider`:

```tsx
import { ParaSignerProvider, useParaSigner } from "@miden-sdk/para-react";
import { MidenProvider } from "@miden-sdk/react";

<ParaSignerProvider apiKey={apiKey} environment="BETA" appName="My App">
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</ParaSignerProvider>;
```

It renders `QueryClientProvider` and Para's `ParaProvider` internally and
imports `@getpara/react-sdk-lite/styles.css`, so do not wrap with either of
those yourself. Pass your own `queryClient` to share one, and
`paraProviderConfig` to reach the rest of `ParaProvider`'s configuration.
Other props: `showSigningModal` (default `true`), `customSignConfirmStep`,
`customComponents` and `importAccountId` (both forwarded into the signer's
`accountConfig`). `environment` accepts `"BETA"`, `"PROD"`, `"SANDBOX"`,
`"DEV"`, `"DEVELOPMENT"` or `"PRODUCTION"`.

Inside it, `useSigner()` from `@miden-sdk/react` drives connect and disconnect;
`useParaSigner()` adds the Para-specific `{ para, wallet, isConnected }` and
throws if called outside the provider. `useModal` and `useLogout` are
re-exported from `@getpara/react-sdk-lite` for convenience.

**`useParaMiden` is the standalone path.** It builds its own `MidenClient` from
the Para session and hands it back, with no `MidenProvider` involved. Use it
only when you are driving the client directly; it needs a Para `ParaProvider`
ancestor of its own.

```tsx
const { client, accountId, error } = useParaMiden(
  "https://rpc.testnet.miden.io",
  "public",
  { accountSeed: "..." },
  true, // showSigningModal
  confirmTx // optional customSignConfirmStep
);
```

It returns `{ client, accountId, error, para, evmWallets, nodeUrl, opts }`.
`client` is `null` until the Para session is connected and the account is
resolved, the client is memoized in a ref so re-renders do not rebuild it, and
setup failures land on `error` rather than throwing - including the one for
`storageMode: "private"` with no `accountSeed`.

Do not run both paths in one app. Each builds its own WASM-backed client, with
its own store and its own account bootstrap. `ParaSignerProvider` goes out of
its way to keep a second client from existing while it initializes, because
concurrent access to the WASM module crashes.

## Bundler setup

Para 3.18 lazily imports optional connectors (`@getpara/aa-*`, Solana, Cosmos)
that almost no app installs, and Vite's pre-bundling still has to resolve them.
The `./vite` entry stubs them:

```ts
// vite.config.ts
import { paraVitePlugin } from "@miden-sdk/para-react/vite";
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

export default defineConfig({
  plugins: [react(), midenVitePlugin(), paraVitePlugin()],
});
```

It returns an array of plugins (Vite flattens it), dedupes `@getpara/web-sdk`
and `@getpara/react-sdk-lite`, and adds Node polyfills for `buffer`, `crypto`,
`stream` and `util` - override that list with the `polyfills` option. The
polyfills come from `vite-plugin-node-polyfills`, which is an optional peer
resolved from your project's own `node_modules`: without it the plugin logs a
warning and returns the stubs alone.

## Going deeper

- The core package documents itself at `node_modules/@miden-sdk/para/AGENTS.md`
  and carries the shared skill.
- The React SDK this integrates with:
  `node_modules/@miden-sdk/react/AGENTS.md` and
  <https://docs.miden.xyz/builder/tools/clients/react-sdk/>.
- Para's own SDK documentation: <https://docs.getpara.com>.
- The type declarations shipped in `dist/` are authoritative for signatures.
  When this guide and the types disagree, the types are right and this file is a
  bug - please report it.
