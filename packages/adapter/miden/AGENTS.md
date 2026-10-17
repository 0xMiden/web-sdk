# @miden-sdk/miden-wallet-adapter-miden - Agent Guide

**Audience: AI coding agents** connecting an app to the Bread wallet: the
browser extension on desktop, or the Bread app from a phone browser.

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
it expects the extension to inject, `BREAD_OPEN_LINK_BASE` and
`getBreadOpenLink()` for handing a page to the Bread app, and a conformance
suite for checking a provider against that interface.

```ts
import { MidenWalletAdapter } from "@miden-sdk/miden-wallet-adapter-miden";

// Construct once, at module scope. A new instance per render breaks the
// React providers.
export const wallets = [new MidenWalletAdapter({ appName: "My dApp" })];
```

`MidenWalletName` is the branded name (`"Bread Wallet"`) the React providers
and the wallet modal select on. `adapter.url` follows `readyState`: while
`Loadable` it is the Open in Bread link for the current page,
`getBreadOpenLink()`; in every other state it is the extension's Chrome Web
Store listing, which the providers open on a connect without it installed.

## How detection works

The adapter looks for `window.midenWallet`, falling back to `window.miden`.
Detection runs immediately, once a second, on `DOMContentLoaded` and on
`load`, and emits `readyStateChange` on the first hit. So a page that loads
before the extension injects starts at `NotDetected` and flips to `Installed`
about a second later: render from `readyState`, not from a check at mount.

In a phone browser with nothing injected, the adapter starts at `Loadable`
instead. That covers an iPhone, iPad or iPod user agent, a Mac user agent with
more than one touch point (iPadOS asks for desktop sites by default) and an
Android one. Detection keeps running, so it still moves to `Installed` when
the wallet appears. The Bread app's own browser is the exception: it defines
`window.bread` before any page script runs and injects the wallet later, so
there the adapter starts at `NotDetected` and waits for the wallet.

An adapter constructed where `window` or `document` is undefined is
`Unsupported` **permanently** - the constructor decides once and never starts
detection. Under SSR, construct adapters in a browser-only module.

## Behavior specific to this adapter

**While `Loadable`, `openInBread()` opens the page in Bread.** It navigates
the current tab to `getBreadOpenLink()`: `BREAD_OPEN_LINK_BASE` with the page
URL percent-encoded in the fragment, `#url=`, which browsers never send to a
server. The Bread app claims that link on iOS and
Android and opens the page in its own browser, where the wallet is injected
and a normal connect follows. Without the app, a web page loads instead.
`connect()` hands off the same way while `Loadable`, and its promise resolves
without connecting or throwing. Both look for the wallet first: if it was
injected since the last poll, `openInBread()` moves to `Installed` and emits
`readyStateChange` instead of navigating, and `connect()` connects. The OS
hands the link to the app only for a navigation the user's tap started, so
call `openInBread()` synchronously from the click handler, with no `await`
before it. Without an active tap, such as a dApp's own `connect()` on page
load, it does nothing, and a second call within a second of a handoff is
ignored. The providers' `autoConnect` waits for `Installed`, so it never hands
off.

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
