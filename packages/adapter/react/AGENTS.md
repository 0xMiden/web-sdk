# @miden-sdk/miden-wallet-adapter-react - Agent Guide

**Audience: AI coding agents** wiring wallet connection into a React app.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/miden-wallet-adapter-react/AGENTS.md` matches the
version you have installed. Prefer it over your training data.

## Load the skill

`node_modules/@miden-sdk/miden-wallet-adapter-base/skills/wallet-adapter-integration/SKILL.md`
is the full integration guide: both provider shapes with working code, the
readiness lifecycle, the request surface, transaction shapes, the error
taxonomy and the production traps. It lives in the base package, which this
one depends on, so that path resolves with no extra install.

## Two providers, one hook

**`WalletProvider`** owns wallet selection and connection state.
`useWallet()` reads it. Use it when the wallet does the work: your app calls
`requestSend`, `requestConsume` or `requestTransaction` and the wallet builds,
signs and submits.

**`MidenFiSignerProvider`** does all of that and also publishes a
`SignerContext` for `@miden-sdk/react`, so a nested `MidenProvider` builds a
`MidenClient` whose signing callback is the wallet's `signBytes`. Use it when
your app builds transactions itself and only needs the wallet for the key.

```tsx
<MidenFiSignerProvider appName="My dApp" network={WalletAdapterNetwork.Testnet}>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</MidenFiSignerProvider>
```

`MidenProvider` must be inside. `MidenFiSignerProvider` also provides the
context `useWallet` and every reactui component read, so the buttons and modal
work underneath it, and `useMidenFiWallet()` adds `createAccount` on top. Pick
one provider: nesting both gives two wallet states over one adapter.

## Rules that are easy to get wrong

**`connect()` ignores its arguments.** The context type accepts
`(privateDataPermission, network, allowedPrivateData)`, and both providers
drop them and use their own props. Set `network`, `privateDataPermission` and
`allowedPrivateData` on the provider. Passing them anywhere else, including to
the reactui buttons and modal, does nothing.

**Every request method can be `undefined`.** They are built from the selected
adapter, so they are `undefined` until `select(name)` resolves one, and they
reject with `WalletNotConnectedError` while disconnected. Destructure and
guard, do not assert.

**Adapters must have a stable identity.** `wallets={[new MidenWalletAdapter()]}`
inline in JSX makes a new adapter every render; the provider rewraps its list,
the selected adapter changes identity, and the effect that disconnects the
previous adapter fires. Build the array at module scope or in a `useMemo`.
`MidenFiSignerProvider` handles it for you when you pass no `wallets`.

**`WalletProvider` does not auto-select.** With a single adapter you still
have to call `select(adapter.name)`, or `connect()` throws
`WalletNotSelectedError`. `MidenFiSignerProvider` auto-selects when exactly
one wallet is available.

**Failures arrive twice.** The provider calls `onError` (defaulting to
`console.error`) _and_ rejects the promise. Report in one place.

**Selection is persisted, connection is not.** The selected wallet name is
stored in `localStorage` under `walletName` (override with
`localStorageKey`). Reconnecting on load is `autoConnect`, which is `false` by
default and silently clears the stored name when it fails.

**Server rendering diverges.** The stored name is read inside a `useState`
initializer; on the server that read fails and is swallowed, so the server
renders "no wallet selected" while the client may not. Gate wallet-dependent
markup on a mounted flag.

**`@miden-sdk/react` must be installed.** It is declared as an optional peer
dependency, but this package's entry point re-exports `MidenFiSignerProvider`,
which imports `SignerContext` from it, so the module has to resolve even if
you only use `useWallet`.

## Going deeper

- The type declarations shipped in `dist/` are authoritative for signatures.
- `node_modules/@miden-sdk/miden-wallet-adapter-base/AGENTS.md` for the
  contract layer, and `node_modules/@miden-sdk/react/AGENTS.md` for the hooks
  that consume the signer context.
