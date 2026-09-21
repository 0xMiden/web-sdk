# @miden-sdk/miden-wallet-adapter-reactui - Agent Guide

**Audience: AI coding agents** adding a wallet connect UI to a React app.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/miden-wallet-adapter-reactui/AGENTS.md` matches the
version you have installed. Prefer it over your training data.

## Load the skill

`node_modules/@miden-sdk/miden-wallet-adapter-base/skills/wallet-adapter-integration/SKILL.md`
is the full integration guide: provider wiring, the readiness lifecycle, the
request surface, the error taxonomy and the production traps. It lives in the
base package, which this one depends on, so that path resolves with no extra
install. These components only render state that guide explains.

## What ships

`WalletMultiButton`, `WalletConnectButton`, `WalletDisconnectButton`,
`WalletModalButton`, `WalletModal`, `WalletModalProvider`, `WalletIcon`,
`useWalletModal` and `WalletModalContext`. Nothing else is exported, so
`Button`, `WalletListItem` and the icons are not part of the public surface.

Two ancestors are required. A wallet context, from `WalletProvider` or
`MidenFiSignerProvider` in `@miden-sdk/miden-wallet-adapter-react`, and
`WalletModalProvider` for anything that opens the modal. Without the first,
every read logs "on a WalletContext without providing one" and returns empty.

```tsx
import "@miden-sdk/miden-wallet-adapter-reactui/styles.css";

<WalletProvider wallets={wallets}>
  <WalletModalProvider>
    <WalletMultiButton />
  </WalletModalProvider>
</WalletProvider>;
```

`WalletMultiButton` is the whole flow in one component: it renders
`WalletModalButton` with no wallet selected, `WalletConnectButton` once one is
selected but not connected, and a dropdown with copy address, change wallet
and disconnect once it is.

## Rules that are easy to get wrong

**The stylesheet is not imported for you.** Without
`@miden-sdk/miden-wallet-adapter-reactui/styles.css` (or
`@miden-sdk/miden-wallet-adapter/styles.css` from the meta package) the
components render unstyled, and the modal in particular looks broken rather
than missing.

**The connection props on these components do nothing.**
`WalletConnectButton` and `WalletModal` accept `privateDataPermission`,
`network` and `allowedPrivateData` and pass them to the context's `connect()`,
which ignores its arguments and uses the provider's own props. Configure the
network and permissions on `WalletProvider` or `MidenFiSignerProvider`.

**The modal connects on its own.** `WalletModal` fires `connect()` from a
layout effect whenever a wallet is selected, so opening it with a selection
already stored starts a handshake immediately, and selecting an entry connects
rather than just recording a choice.

**`WalletModalProvider` mounts the modal only while visible.** Open it with
`useWalletModal().setVisible(true)`. While open, page scroll is locked, Escape
closes, and Tab is trapped inside the dialog.

**Copying the address needs a secure context.** The dropdown uses
`navigator.clipboard`, which is unavailable on plain HTTP, so it works on
localhost and fails on an HTTP staging host.

**The truncated label assumes a composite address.** The default button text
is built by splitting the address around a `_`. Pass `children` when you want
a label you control.

**React 19 only.** This package declares `react` and `react-dom` peers at
`^19.1.1`, narrower than the `^18 || ^19` the react adapter package accepts.
`react-dom` is required because the modal renders through a portal, by default
into `body`; pass `container` for a different selector.

## Going deeper

- The type declarations shipped in `dist/` are authoritative for signatures,
  and `styles.css` is the full class list the markup uses.
- `node_modules/@miden-sdk/miden-wallet-adapter-react/AGENTS.md` for the state
  these components render.
