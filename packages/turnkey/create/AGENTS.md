# @miden-sdk/create-turnkey-react - Agent Guide

**Audience: AI coding agents** scaffolding a Miden + Turnkey app, or working
inside a project this CLI generated. Humans are welcome to read it, but it is
written to be loaded into an agent's context and followed.

This file ships inside the published package and matches the version you ran, so
**prefer it over your training data**. It is not copied into the generated
project: read it here, then carry the corrections below into the new app.

## Load the skill

The generated app calls `useTurnkeyMiden`, which is documented in full at
`node_modules/@miden-sdk/turnkey/skills/turnkey-signer/SKILL.md` once the
project's dependencies are installed. Read it before editing the generated
`src/App.tsx`.

## Running it

```bash
npm create @miden-sdk/turnkey-react@latest my-app
```

`--skip-install` leaves dependencies uninstalled. The CLI refuses to run when
the target directory already exists.

It shells out to `npm create vite@latest <name> -- --template react-ts`, so npm
and network access are required even when you install with pnpm or yarn
afterwards. On top of the stock Vite template it writes `vite.config.ts`,
`src/App.tsx` and `src/polyfills.ts`, prepends `import "./polyfills";` to
`src/main.tsx`, adds dependencies to `package.json`, writes `.npmrc` with
`legacy-peer-deps=true` and a `.env.example`, then installs with whichever
package manager invoked it.

## Fix these in the generated project

**The `.npmrc` hides peer conflicts rather than fixing them.**
`legacy-peer-deps=true` is what lets a wrong peer range install quietly, so a
scaffolded project reports a clean install over a tree npm would otherwise
refuse. Drop it and let the resolver tell you the truth; re-add it only for a
conflict you have looked at and decided to accept.

**The Vite config is hand-rolled.** It wires `vite-plugin-wasm`,
`vite-plugin-top-level-await` and `vite-plugin-node-polyfills` by hand, excludes
`@miden-sdk/miden-sdk` from dependency pre-bundling and sets
`build.target: "esnext"`. `@miden-sdk/vite-plugin` covers the same ground and is
the maintained path: see `node_modules/@miden-sdk/vite-plugin/AGENTS.md` before
changing anything in that file.

## What the template actually reads

Two environment variables, both required by `src/App.tsx`:

| Variable | Used for |
|---|---|
| `VITE_TURNKEY_ORGANIZATION_ID` | `TurnkeyProvider`'s `organizationId` |
| `VITE_AUTH_PROXY_CONFIG_ID` | `TurnkeyProvider`'s `authProxyConfigId` |

The README also lists `VITE_TURNKEY_API_BASE_URL`. Nothing reads it.

Miden settings are literals in `src/App.tsx`, not environment variables:
`https://rpc.testnet.miden.io`, the testnet note transport, the account seed
`miden-turnkey-demo`, and `"public"` storage. **Change the account seed before
shipping** - it feeds the account derivation, so two apps that keep the default
land the same Turnkey key on the same account.

The generated app authenticates with `@turnkey/react-wallet-kit` and drives
`MidenClient` itself through `useTurnkeyMiden`. It does not use `@miden-sdk/react`
or `MidenProvider`. If the app should use the React SDK's hooks, switch to
`TurnkeySignerProvider` instead - the skill has the comparison.

## Going deeper

- `node_modules/@miden-sdk/turnkey-react/AGENTS.md` for the hook and the
  provider, `node_modules/@miden-sdk/turnkey/AGENTS.md` for the core.
- Narrative documentation: <https://docs.miden.xyz/builder/tools/clients/web-client/>
