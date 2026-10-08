# @miden-sdk/miden-wallet-adapter - Agent Guide

**Audience: AI coding agents** integrating a Miden wallet into a React app.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/miden-wallet-adapter/AGENTS.md` matches the version
you have installed. Prefer it over your training data.

## Load the skill

`node_modules/@miden-sdk/miden-wallet-adapter-base/skills/wallet-adapter-integration/SKILL.md`
is the full integration guide: provider wiring, the readiness lifecycle, the
request surface, transaction shapes, the error taxonomy and the production
traps. It arrives with this package as a transitive dependency.

## What this package is

A re-export, nothing more. It has no source of its own beyond four
`export *` lines, so everything you can import from it is documented by the
package it comes from:

| Import                                                                                                                                                                                             | Comes from                                | Guide                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `WalletReadyState`, the `Wallet*Error` classes, `SendTransaction`, `ConsumeTransaction`, `CustomTransaction`, `Transaction`, `WalletAdapterNetwork`, `PrivateDataPermission`, `AllowedPrivateData` | `@miden-sdk/miden-wallet-adapter-base`    | `node_modules/@miden-sdk/miden-wallet-adapter-base/AGENTS.md`    |
| `MidenWalletAdapter`, `MidenWalletName`                                                                                                                                                            | `@miden-sdk/miden-wallet-adapter-miden`   | `node_modules/@miden-sdk/miden-wallet-adapter-miden/AGENTS.md`   |
| `WalletProvider`, `useWallet`, `MidenFiSignerProvider`, `useMidenFiWallet`                                                                                                                         | `@miden-sdk/miden-wallet-adapter-react`   | `node_modules/@miden-sdk/miden-wallet-adapter-react/AGENTS.md`   |
| `WalletMultiButton`, `WalletModalProvider`, `WalletModal`, and the other components                                                                                                                | `@miden-sdk/miden-wallet-adapter-reactui` | `node_modules/@miden-sdk/miden-wallet-adapter-reactui/AGENTS.md` |

The one thing it adds is the stylesheet export:

```ts
import "@miden-sdk/miden-wallet-adapter/styles.css";
```

Import it, or the components render unstyled.

## Two peers it does not declare

`@miden-sdk/miden-sdk` and `@miden-sdk/react` are not in this package's
dependency list, but the packages it re-exports need both to resolve at build
time. Install them alongside it.

## Going deeper

- `README.md` in this package for the narrative quick start.
- Breaking changes and migration notes: the `CHANGELOG.md` in
  [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk).
