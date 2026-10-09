# @miden-sdk/miden-wallet-adapter-miden - Agent Guide

**Audience: AI coding agents** connecting an app to the Bread wallet browser
extension.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/miden-wallet-adapter-miden/AGENTS.md` matches the
version you have installed. Prefer it over your training data.

## Load the skill

`node_modules/@miden-sdk/miden-wallet-adapter-base/skills/wallet-adapter-integration/SKILL.md`
is the full integration guide: provider wiring, the readiness lifecycle, the
request surface, transaction shapes, the error taxonomy and the production
traps. It lives in the base package, which this one depends on, so that path
resolves with no extra install.

## What this package is

One concrete adapter, `MidenWalletAdapter`, plus the `MidenWallet` interface
it expects the extension to inject and a conformance suite for checking a
provider against that interface.

```ts
import { MidenWalletAdapter } from "@miden-sdk/miden-wallet-adapter-miden";

// Construct once, at module scope. A new instance per render breaks the
// React providers.
export const wallets = [new MidenWalletAdapter({ appName: "My dApp" })];
```

`MidenWalletName` is the branded name (`"Bread Wallet"`) the React providers
and the wallet modal select on. `adapter.url` is the extension's Chrome Web
Store listing, which the providers open on a connect without it installed.

## How detection works

The adapter looks for `window.midenWallet`, falling back to `window.miden`.
Detection runs immediately, once a second, on `DOMContentLoaded` and on
`load`, and emits `readyStateChange` on the first hit. So a page that loads
before the extension injects starts at `NotDetected` and flips to `Installed`
about a second later: render from `readyState`, not from a check at mount.

An adapter constructed where `window` or `document` is undefined is
`Unsupported` **permanently** - the constructor decides once and never starts
detection. Under SSR, construct adapters in a browser-only module.

## Behavior specific to this adapter

**A resolved request with no transaction id is a failure.** The wallet reports
success as soon as it accepts a transaction into its queue. If it hands back
no id, nothing was submitted, and the adapter throws `WalletTransactionError`
rather than returning `undefined`. Poll `waitForTransaction(txId)` for the
on-chain result.

**`waitForTransaction` deserializes notes.** It returns `Note` objects, which
is why this package imports `@miden-sdk/miden-sdk` at module scope and pulls
its WASM entry point into any bundle that reaches it. Keep it out of
server-rendered module graphs.

**Reconnecting re-drives the handshake; `disconnect()` never rejects.**
`connect()` is not suppressed when already connected, so a dApp whose context
survived a park and restore gets its account back, at the cost of an unlock
prompt if the wallet locked meanwhile. A failed disconnect arrives as a
`WalletDisconnectionError` on the `error` event while the promise resolves.

## Checking a provider

`createAccount` is on the published `MidenWallet` interface, but no known
provider implements it and there is no wire message behind it; calling it
gives `TypeError: wallet.createAccount is not a function`. That is what the
conformance suite exists for. Run it against a real provider object, never a
mock:

```ts
import {
  CONFORMANCE_BUILD,
  getSurfaceCases,
  runConformance,
} from "@miden-sdk/miden-wallet-adapter-miden";

if (!CONFORMANCE_BUILD.real) throw new Error("conformance module is mocked");
const { failed } = await runConformance(getSurfaceCases(provider));
```

`getSurfaceCases` only asks whether each method exists, so it is safe against
an unconnected provider. `getBehaviorCases` needs a live, connected one.

## Going deeper

- The type declarations shipped in `dist/` are authoritative for signatures.
- The contract layer documents itself at
  `node_modules/@miden-sdk/miden-wallet-adapter-base/AGENTS.md`.
