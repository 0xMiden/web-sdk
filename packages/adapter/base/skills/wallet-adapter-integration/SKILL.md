---
name: wallet-adapter-integration
description: Connect a dApp to a Miden wallet with @miden-sdk/miden-wallet-adapter. Covers provider wiring, the WalletReadyState lifecycle, the request* surface and transaction shapes, the Wallet*Error taxonomy, the wallet-as-signer path into MidenClient, and the traps that only show up in production. Use when adding wallet connect to an app, debugging a connect or transaction failure, or writing a new wallet adapter.
---

# Miden wallet adapter integration

The adapter is a thin, typed channel between your page and a wallet that
injects itself into `window`. It holds no keys, no client and no chain state.
Every call is a request the wallet may prompt on, refuse, or answer from its
own store.

## Pick the package

| Package                                   | Install when                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@miden-sdk/miden-wallet-adapter`         | React app. Re-exports the four below and serves the stylesheet at `@miden-sdk/miden-wallet-adapter/styles.css`. |
| `@miden-sdk/miden-wallet-adapter-base`    | No React, or you are writing an adapter. Types, errors, transaction shapes, `BaseWalletAdapter`.                |
| `@miden-sdk/miden-wallet-adapter-miden`   | `MidenWalletAdapter`, the adapter for the Bread wallet extension.                                               |
| `@miden-sdk/miden-wallet-adapter-react`   | `WalletProvider`, `useWallet`, `MidenFiSignerProvider`.                                                         |
| `@miden-sdk/miden-wallet-adapter-reactui` | Prebuilt connect button, dropdown and wallet modal.                                                             |

Install the peers yourself: `@miden-sdk/miden-sdk` (base, miden and react all
declare it as a peer dependency) and, for anything that pulls the react
package, `@miden-sdk/react`. The react package's entry point imports
`SignerContext` from `@miden-sdk/react` even if you only ever call
`useWallet`, so the module must resolve at build time.

## Wiring: two shapes

### A. The wallet does the work

`WalletProvider` owns wallet selection and connection state. `useWallet`
exposes it.

```tsx
// wallets.ts - module scope, so the array identity never changes
import { MidenWalletAdapter } from "@miden-sdk/miden-wallet-adapter";
export const wallets = [new MidenWalletAdapter({ appName: "My dApp" })];
```

```tsx
import {
  AllowedPrivateData,
  PrivateDataPermission,
  WalletAdapterNetwork,
  WalletModalProvider,
  WalletMultiButton,
  WalletProvider,
} from "@miden-sdk/miden-wallet-adapter";
import "@miden-sdk/miden-wallet-adapter/styles.css";
import { wallets } from "./wallets";

export function App() {
  return (
    <WalletProvider
      wallets={wallets}
      network={WalletAdapterNetwork.Testnet}
      privateDataPermission={PrivateDataPermission.UponRequest}
      allowedPrivateData={AllowedPrivateData.Assets | AllowedPrivateData.Notes}
      onError={(error) => console.error(error.name, error.message)}
    >
      <WalletModalProvider>
        <WalletMultiButton />
      </WalletModalProvider>
    </WalletProvider>
  );
}
```

`network`, `privateDataPermission` and `allowedPrivateData` belong on the
provider. `connect()` takes no arguments in practice: the provider's `connect`
ignores anything passed to it and forwards its own props to the adapter.

### B. The wallet holds the key, your app drives `MidenClient`

`MidenFiSignerProvider` does everything `WalletProvider` does and also
publishes a `SignerContext` for `@miden-sdk/react`, so `MidenProvider` builds
a client whose signing callback is the wallet's `signBytes`.

```tsx
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";
import { MidenProvider } from "@miden-sdk/react";

<MidenFiSignerProvider appName="My dApp" network={WalletAdapterNetwork.Testnet}>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</MidenFiSignerProvider>;
```

`MidenProvider` must be a descendant, not an ancestor: the signer context is
provided by `MidenFiSignerProvider` and consumed by `MidenProvider`.

It creates a `MidenWalletAdapter` for you when you pass no `wallets`, and
auto-selects the wallet when exactly one is available. It also provides the
same context `useWallet` and every reactui component read, so the buttons and
the modal work underneath it.

The account it configures is the connected one: `accountConfig.importAccountId`
defaults to the wallet's `address`, `publicKeyCommitment` is the adapter's
`publicKey`, and the IndexedDB store is named `midenfi_<address>`. Override
with `importAccountId`, `accountType` (default
`"RegularAccountImmutableCode"`), `storageMode` (`"private" | "public"`,
default `"public"`) and `customComponents`.

Read wallet state inside it with `useMidenFiWallet()`, which throws if it is
rendered outside the provider, or with `useWallet()` from the same package.

## The readiness lifecycle

`WalletReadyState` on the adapter, mirrored per wallet in `useWallet().wallets`:

| State         | Meaning                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Unsupported` | No DOM. `MidenWalletAdapter` enters this state when `window` or `document` is undefined at construction, and never leaves it.                                                                     |
| `NotDetected` | DOM present, nothing injected yet. The starting state in a browser.                                                                                                                               |
| `Installed`   | The wallet injected itself. `MidenWalletAdapter` polls for `window.midenWallet` or `window.miden` once a second, on `DOMContentLoaded`, on `load` and immediately, then emits `readyStateChange`. |
| `Loadable`    | A wallet that needs no install. No adapter in this repo reports it, but the providers treat it as connectable.                                                                                    |

The connect path is: `select(name)` writes the wallet name to
`localStorage` (key `walletName`, override with `localStorageKey`), the
provider resolves it to an adapter, then `connect()` drives the handshake.
With `WalletProvider` you must select first or `connect()` throws
`WalletNotSelectedError`.

If `readyState` is neither `Installed` nor `Loadable`, the provider's
`connect()` clears the stored name, opens `adapter.url` in a new tab (the
extension's store listing) and throws `WalletNotReadyError`.

`autoConnect` is off by default. When on, it connects as soon as a stored
wallet resolves to a ready adapter, and clears the stored name if that fails.
It never rethrows; the failure reaches you through `onError` only.

Connecting twice is deliberately not a no-op. A second `connect()` re-drives
the handshake so a dApp whose JS context survived a park and restore gets its
account back. The cost is that a wallet that locked in the meantime may
prompt for unlock.

## Calling the wallet

`useWallet()` and `useMidenFiWallet()` return each method as
`fn | undefined`. They are `undefined` until a wallet is selected, and reject
with `WalletNotConnectedError` while disconnected. Always guard.

| Method                                  | Returns                   | Notes                                                                                                                                           |
| --------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestSend(tx)`                       | transaction id            | `MidenSendTransaction` payload.                                                                                                                 |
| `requestConsume(tx)`                    | transaction id            | `MidenConsumeTransaction` payload.                                                                                                              |
| `requestTransaction(tx)`                | transaction id            | A `MidenTransaction` envelope. Dispatches by `type` to the send and consume endpoints; anything else goes to the wallet's generalized endpoint. |
| `waitForTransaction(txId, timeout?)`    | `{ txHash, outputNotes }` | `outputNotes` are `Note` objects from `@miden-sdk/miden-sdk`.                                                                                   |
| `requestAssets()`                       | `{ faucetId, amount }[]`  | `amount` is a string.                                                                                                                           |
| `requestConsumableNotes()`              | `InputNoteDetails[]`      | From the wallet's store.                                                                                                                        |
| `requestPrivateNotes(filter, noteIds?)` | `InputNoteDetails[]`      | `filter` is a `NoteFilterTypes` from `@miden-sdk/miden-sdk`.                                                                                    |
| `importPrivateNote(bytes)`              | note id                   | `bytes` is a serialized note.                                                                                                                   |
| `signBytes(data, kind)`                 | `Uint8Array`              | `kind` is `"word"` or `"signingInputs"`.                                                                                                        |
| `createAccount(params?)`                | account id                | Only on `MidenFiSignerProvider`'s context. See the traps.                                                                                       |
| `requestGuardianInfo()`                 | `GuardianInfo`            | Whether the connected account is a guardian account, and its endpoint, provider and sync status.                                                |

Everything the wallet returns about private state is gated by the
`AllowedPrivateData` bitmask you connected with: `None`, `Assets`, `Notes`,
`Storage`, `All`. Combine with `|`. `PrivateDataPermission.UponRequest` makes
the wallet ask every time; `Auto` lets it answer without a prompt.

## Transaction shapes

All three are plain objects you can build by hand, with classes and static
factories in `@miden-sdk/miden-wallet-adapter-base` that build them for you.
The constructor signatures:

```
SendTransaction(sender, recipient, faucetId, noteType, amount, recallBlocks?)
ConsumeTransaction(faucetId, noteId, noteType, amount, noteBytes?)
CustomTransaction(address, recipientAddress, transactionRequest,
                  inputNoteIds?, inputNoteBytes?)
```

`amount` is a `number`, not a `bigint`, unlike everything in
`@miden-sdk/miden-sdk`.

`noteType` is the string `"public"` or `"private"`. `ConsumeTransaction` and
`CustomTransaction` base64-encode the `Uint8Array` arguments for you, and
`CustomTransaction` calls `transactionRequest.serialize()` on the live
`TransactionRequest` you hand it, so build that with `@miden-sdk/miden-sdk`
first. The wallet deserializes these bytes with its own SDK, so both must use the same `TransactionRequest` encoding: 0.17.0-rc.4 changed it, and a dApp and wallet on opposite sides of that change cannot exchange custom transactions.

`requestTransaction` wants the envelope, not a bare payload:

```ts
import { Transaction } from "@miden-sdk/miden-wallet-adapter";

const tx = Transaction.createCustomTransaction(
  address,
  recipientAddress,
  transactionRequest
);
const txId = await requestTransaction(tx);
```

`Transaction.createSendTransaction` and `Transaction.createConsumeTransaction`
build the other two envelopes, and the adapter routes them back to the
dedicated endpoints.

## Confirming a transaction

The id a request resolves with names a transaction the wallet **accepted**,
not one that landed. Poll for the on-chain result:

```ts
const txId = await requestSend({
  senderAddress: address,
  recipientAddress: recipient,
  faucetId,
  noteType: "public",
  amount: 100,
});
const { txHash, outputNotes } = await waitForTransaction(txId);
```

A wallet that resolves with no id at all is treated as a silent drop and
throws `WalletTransactionError`. A wallet that reports a failed transaction
from `waitForTransaction` also throws `WalletTransactionError`, carrying the
wallet's `errorMessage`.

## Error taxonomy

Every error extends `WalletError`, which carries the underlying failure on
`.error` and a stable `.name`. Switch on `error.name` or use `instanceof`.

| Error                      | Thrown when                                                                                                                                | Do                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `WalletNotSelectedError`   | `connect()` with no wallet selected.                                                                                                       | Call `select(name)`, or open the modal.                     |
| `WalletNotReadyError`      | `connect()` while the adapter is not `Installed` or `Loadable`. The provider has already opened the install page.                          | Tell the user to install or unlock, then retry.             |
| `WalletConnectionError`    | The wallet rejected the handshake, or returned no address.                                                                                 | Surface it. A rejection here is usually the user declining. |
| `WalletNotConnectedError`  | Any request while no wallet is connected.                                                                                                  | Gate your UI on `connected`.                                |
| `WalletTransactionError`   | The wallet rejected a request, returned no transaction id, or reported a failed transaction.                                               | Read `.error` for the wallet's own message.                 |
| `WalletDisconnectionError` | `disconnect()` failed wallet-side. Emitted on the `error` event, never thrown: `disconnect()` still resolves and still emits `disconnect`. | Do not rely on try/catch around `disconnect()`.             |

`base` exports many more (`WalletLoadError`, `WalletConfigError`,
`WalletDisconnectedError`, `WalletAccountError`, `WalletAddressError`,
`WalletKeypairError`, `WalletSendTransactionError`, `WalletSignMessageError`,
`WalletSignTransactionError`, `WalletTimeoutError`, `WalletWindowBlockedError`,
`WalletWindowClosedError`, `WalletDecryptionError`,
`WalletDecryptionNotAllowedError`, `WalletPrivateDataPermissionError`,
`WalletRecordsError`). Nothing in these packages throws them; they exist for
other adapters to use. Do not write handlers that wait for them.

Errors reach you twice: the provider calls `onError` (or `console.error` when
you pass none) **and** the promise rejects. Report in one place or the user
sees the same failure twice. `importPrivateNote` and `requestConsumableNotes`
emit the wallet's raw error rather than a `WalletError` subclass, so an
`onError` handler must not assume `error.name` is one of the names above.

## Adapter or `MidenClient` directly?

- **Wallet builds, signs, submits.** `requestSend`, `requestConsume`,
  `requestTransaction`. The wallet shows its own confirmation UI and your app
  never touches a key or a prover. Simplest, and the right default.
- **Your app builds, the wallet signs.** `MidenFiSignerProvider` plus
  `MidenProvider`. You construct `TransactionRequest`s with
  `@miden-sdk/miden-sdk` and the client calls back into `signBytes` for the
  signature. Reach for this when you need transaction shapes the wallet's
  endpoints do not express, or you want the client's local state.
- **Reads.** `requestAssets`, `requestConsumableNotes` and
  `requestPrivateNotes` answer from the wallet's store and only within the
  permission you connected with. If you need chain state your app controls,
  sync your own client instead.

The two are not exclusive: a `CustomTransaction` carries a serialized
`TransactionRequest`, so building one already means having the SDK loaded.

## Traps

**Construct adapters once.** An adapter array built inline in JSX is a new
array with a new adapter on every render. The provider rewraps its wallet
list, the selected adapter's identity changes, and the effect that disconnects
the previous adapter fires. Module scope, or `useMemo` with a stable
dependency list.

**An adapter constructed without a DOM is `Unsupported` forever.** The
constructor decides `readyState` once and only starts detection when `window`
and `document` exist. Under SSR, construct adapters in a client-only module.

**Server and client render different wallet state.** Wallet selection is read
from `localStorage` inside a `useState` initializer. On the server that read
fails and is swallowed, so the server renders "no wallet". Gate
wallet-dependent markup on a mounted flag if you server-render.

**The miden package imports the SDK eagerly.** `MidenWalletAdapter` imports
`@miden-sdk/miden-sdk` at module scope to deserialize output notes, which
pulls the eager WASM entry point and its top-level await into any module graph
that reaches it. Keep it out of server-rendered modules.

**`connect()` arguments are dropped.** The reactui buttons and modal accept
`privateDataPermission`, `network` and `allowedPrivateData` props and pass
them to `connect()`, which ignores them. Whatever you set on the provider is
what the wallet is asked for. Setting the network on the modal and not on the
provider is a silent testnet default.

**`createAccount` is on the interface but not in the wallets.** The package
ships a conformance suite (`getSurfaceCases`, `getBehaviorCases`,
`runConformance` from the miden package) precisely because this method has
been on the published `MidenWallet` interface with no provider implementing it
and no wire message behind it. Calling it yields
`TypeError: wallet.createAccount is not a function`. It is also absent from
`WalletProvider`'s context; only `MidenFiSignerProvider` exposes it. Probe
before you call, and let the SDK create accounts instead.

**Treating the returned id as confirmation.** On a fast local node a queued
transaction lands before your next line runs, so skipping `waitForTransaction`
looks correct in development and drops results in production.

**The not-installed path is never exercised in development.** Your machine has
the extension. Test the `NotDetected` branch: `connect()` opens a store page
in a new tab and throws.

## Writing an adapter for another wallet

Extend `BaseMessageSignerWalletAdapter` from
`@miden-sdk/miden-wallet-adapter-base`. It is an `EventEmitter` over
`connect`, `disconnect`, `error` and `readyStateChange`, and requires
`name` (branded `WalletName`), `url`, `icon`, `readyState`, `address`,
`publicKey`, `connecting`, `supportedTransactionVersions`, `connect`,
`disconnect` and the full request surface. `connected` is derived from
`address`. Use `scopePollingDetectionStrategy` for injection detection: it
returns immediately without a DOM and disposes its listeners on first hit.

Emit `error` with a `WalletError` subclass before rethrowing, so a provider's
`onError` sees a typed failure. Then run the conformance suite from
`@miden-sdk/miden-wallet-adapter-miden` against your real provider object, not
against a mock: `getSurfaceCases` needs no connection and catches a missing
method, `getBehaviorCases` needs a live connected provider and checks the
response envelopes. Assert `CONFORMANCE_BUILD.real` first so a mocked module
cannot make the run pass vacuously.
