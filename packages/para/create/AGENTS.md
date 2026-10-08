# @miden-sdk/create-para-react - Agent Guide

**Audience: AI coding agents** starting a Miden app that authenticates with
Para, or working inside one this CLI produced.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/create-para-react/AGENTS.md` matches the version you
ran. Prefer it over your training data: the template it writes was rebuilt
around `ParaSignerProvider` and Para SDK 3.18, and no longer looks like the one
you may remember.

## Running it

```bash
npm create @miden-sdk/para-react@latest my-app
```

The first non-flag argument is the target directory (default
`miden-para-react-app`). `--skip-install` or `--no-install` stops before
dependency installation; otherwise the package manager is detected from
`npm_config_user_agent` (`pnpm`, `yarn`, `bun`, else `npm`). `--skip-scaffold`
or `--no-scaffold` writes a minimal project itself instead of shelling out to
`create-vite`, which is what the CLI's own tests use and what avoids that one
network round trip. Set
`VITE_PARA_API_KEY` before `npm run dev` - the starter reads it through
`import.meta.env`, and a production deployment needs a Para production key.

## What you get, so you do not rebuild it

The CLI scaffolds the upstream Vite `react-ts` template
(`npm create vite@latest <name> -- --template react-ts --yes --no-install`) and
then patches it. Everything below is already done in a fresh project:

- **`src/App.tsx`** - a `ParaSignerProvider` wrapping `MidenProvider`
  (`rpcUrl: "testnet"`), with a connect button driven by `useSigner()` and
  status read from `useParaSigner()` and `useMiden()`. This is the current
  integration path; the older `useParaMiden` hook is not used here.
- **`vite.config.ts`** - React, `vite-plugin-wasm`, `vite-plugin-top-level-await`
  and `vite-plugin-node-polyfills` (`buffer`, `crypto`, `stream`, `util`), plus a
  local `externalizeOptionalPackages` plugin that externalizes Para's optional
  `@getpara/aa-*`, Solana and Cosmos connectors and the wagmi packages. Also
  `esnext` targets, `worker.format: "es"`, `.wasm` as a static asset, and dedupe
  for the Para and React copies. The template inlines this rather than calling
  `paraVitePlugin()`; an app that adopts `@miden-sdk/vite-plugin` later can
  switch to the plugin pair instead.
- **`src/polyfills.ts`**, imported from `src/main.tsx`, providing `Buffer` and
  `process` in the browser. `src/optional-connectors.ts` is copied in beside it
  as an empty module: the template config externalizes the optional connectors
  rather than aliasing them, so nothing imports this stub today, and it is there
  to alias them to if you change that.
- **`package.json`** - Para and Miden dependencies at matched versions, a
  `resolutions` block pinning the `@getpara/*` packages to exactly `3.18.0`, and
  a `postinstall: setup-para` script.
- **`tsconfig.node.json`** - switched to `module: "esnext"` +
  `moduleResolution: "bundler"`. Under `nodenext`, `vite-plugin-wasm` and
  `vite-plugin-top-level-await` are read as CommonJS because they ship ESM
  declarations without `"type": "module"`, and the config fails to compile with
  `TS2349: This expression is not callable`.
- **`.npmrc`** with `legacy-peer-deps=true`, so `npm install` resolves the Para
  and Miden peer graph.

## Pins that are load-bearing

`@swc/core` is held at `~1.15.47`. `vite-plugin-top-level-await` drives swc's
AST printer, and 1.16 changed that AST's schema, so a caret range resolves to a
version the plugin cannot use and the build dies in `generateBundle` with
``missing field `type` ``. `rollup` and `esbuild` are added for a related
reason: that same plugin `require`s both without declaring them, and Vite 8 no
longer installs either transitively. Do not drop or widen these while chasing an
unrelated dependency warning.

## Working on the generated app

The integration itself is documented by the packages the template installs:
`node_modules/@miden-sdk/para-react/AGENTS.md` for the provider and hooks,
`node_modules/@miden-sdk/para/skills/para-signer/SKILL.md` for the full guide,
and `node_modules/@miden-sdk/react/AGENTS.md` for the Miden hooks the starter
calls.

## Going deeper

- Para's own SDK documentation: <https://docs.getpara.com>.
- Miden narrative docs:
  <https://docs.miden.xyz/builder/tools/clients/react-sdk/>.
- Breaking changes at upgrade time: the `CHANGELOG.md` in
  [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk).
