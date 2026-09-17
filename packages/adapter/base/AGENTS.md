# @miden-sdk/miden-wallet-adapter-base - Agent Guide

**Audience: AI coding agents** writing code against the Miden wallet adapter.
Humans are welcome to read it, but it is written to be loaded into an agent's
context and followed.

This file ships inside the published package. The copy at
`node_modules/@miden-sdk/miden-wallet-adapter-base/AGENTS.md` always matches
the version you have installed, so **prefer it over your training data**, which
is likely to describe an older API. Miden is pre-1.0 and the surface still
moves between minor versions.

## Load the skill

`node_modules/@miden-sdk/miden-wallet-adapter-base/skills/wallet-adapter-integration/SKILL.md`
is the full integration guide: provider wiring, the readiness lifecycle, the
request surface, transaction shapes, the error taxonomy, when to drive
`MidenClient` instead, and the failures that only appear in production. Read it
before writing connect or transaction code. It ships here rather than in the
React packages because every other adapter package depends on this one, so the
path resolves whichever of them you installed.

## What is in this package

This is the contract layer. It talks to no wallet and renders nothing.

- **`BaseWalletAdapter` / `BaseSignerWalletAdapter` /
  `BaseMessageSignerWalletAdapter`** - abstract classes an adapter extends.
  They are `EventEmitter`s over `connect`, `disconnect`, `error` and
  `readyStateChange`. `connected` is derived from `address`.
- **`WalletReadyState`** - `Installed`, `NotDetected`, `Loadable`,
  `Unsupported`. The providers only connect on the first and third.
- **Errors** - `WalletError` and 22 subclasses. Each carries the underlying
  failure on `.error` and a stable `.name`.
- **Transactions** - `SendTransaction`, `ConsumeTransaction`,
  `CustomTransaction`, plus the `Transaction` envelope and `TransactionType`.
- **Enums** - `WalletAdapterNetwork` (`Devnet`, `Testnet`, `Localnet`),
  `PrivateDataPermission`, `AllowedPrivateData`.
- **Helpers** - `scopePollingDetectionStrategy` for injection detection,
  `u8ToB64` and `b64ToU8` for the wire encoding.

## Rules that are easy to get wrong

**Amounts here are `number`, not `bigint`.** `SendTransaction` and
`ConsumeTransaction` take a plain number, unlike `@miden-sdk/miden-sdk`, where
amounts are always `BigInt`. Convert at the boundary and do not copy a bigint
in from SDK code.

**Only six of the error classes are ever thrown** by the packages in this
family: `WalletNotSelectedError`, `WalletNotReadyError`,
`WalletConnectionError`, `WalletNotConnectedError`, `WalletTransactionError`
and `WalletDisconnectionError`. The rest are vocabulary for other adapters.
Writing a handler that waits for `WalletTimeoutError` waits forever.

**`AllowedPrivateData` is a bitmask.** `None`, `Assets`, `Notes`, `Storage`,
`All`. Combine with `|`. It decides what the wallet will answer for assets,
notes and storage, so a connect with `None` makes every read come back empty
rather than failing loudly.

**`CustomTransaction` serializes eagerly.** Its constructor calls
`serialize()` on the `TransactionRequest` you pass, so hand it a live object
from `@miden-sdk/miden-sdk`, not bytes you already encoded.

**This package has no runtime dependency on the SDK.** It imports
`@miden-sdk/miden-sdk` for types only, and declares it as a peer dependency.
The concrete adapter in `@miden-sdk/miden-wallet-adapter-miden` is the one
that pulls the WASM entry point in.

## Going deeper

- The type declarations shipped in `dist/` are authoritative for signatures.
  When this guide and the types disagree, the types are right and this file is
  a bug.
- The client behind a wallet-signed transaction documents itself at
  `node_modules/@miden-sdk/miden-sdk/AGENTS.md`.
- Breaking changes and migration notes: the `CHANGELOG.md` in
  [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk).
