---
name: signer-integration
description: Guide to integrating external signers (Para, Turnkey, MidenFi wallet adapter) and building custom signers for Miden React frontends. Covers provider setup, passkey authentication, unified signer interface, multi-signer registry, custom SignerContext implementation, wallet-extension detection, signer account initialization, custom account components, building guarded-multisig auth components, and network-account / network-note targeting. Use when adding wallet connection, authentication, or external key management to a Miden frontend.
---

# Miden Signer Integration

## Overview

By default, MidenProvider uses a **local keystore** (keys in IndexedDB, no wallet connection needed). For production apps, wrap MidenProvider with a signer provider to use external key management.

Signer providers must wrap MidenProvider (outer → inner):
```
<SignerProvider>      ← manages keys + auth
  <MidenProvider>     ← manages Miden client
    <App />
  </MidenProvider>
</SignerProvider>
```

## Pre-Built Signer Providers

All three signer families ship from this monorepo and are version-locked to the SDK:
`packages/para/` (`@miden-sdk/para`, `@miden-sdk/para-react`, `@miden-sdk/create-para-react`),
`packages/turnkey/` (`@miden-sdk/turnkey`, `@miden-sdk/turnkey-react`, `@miden-sdk/create-turnkey-react`),
and `packages/adapter/` (the five `@miden-sdk/miden-wallet-adapter*` names, unchanged).
Install them at the same minor as `@miden-sdk/miden-sdk`. As of 0.16.1 the Para packages
peer on Para SDK 3.18 (`@getpara/web-sdk` and `@getpara/react-sdk-lite` `^3.18.0`); the 2.x
range is dropped and will not satisfy the peer.

> The six Para and Turnkey packages dropped their redundant `miden-` prefix on the 0.16
> line. If you are upgrading from 0.15, rewrite `@miden-sdk/use-miden-para-react` to
> `@miden-sdk/para-react` and `@miden-sdk/miden-turnkey-react` to `@miden-sdk/turnkey-react`.
> The exported symbols are unchanged.

### Para (EVM Wallets)
```tsx
import { ParaSignerProvider, useParaSigner } from "@miden-sdk/para-react";

<ParaSignerProvider apiKey="your-api-key" environment="PRODUCTION">
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</ParaSignerProvider>

const { para, wallet, isConnected } = useParaSigner();
```

### Turnkey (Passkey Authentication)
```tsx
import { TurnkeySignerProvider } from "@miden-sdk/turnkey-react";

// `config` is REQUIRED, and `defaultOrganizationId` is required within it.
// Type: Pick<TurnkeySDKBrowserConfig, "defaultOrganizationId">
//       & Partial<Omit<TurnkeySDKBrowserConfig, "defaultOrganizationId">>
// - only the other fields (e.g. `apiBaseUrl`) are optional; `apiBaseUrl`
// defaults to https://api.turnkey.com. There is NO env-var fallback for the
// org id (the provider does not read `VITE_TURNKEY_ORG_ID`).
<TurnkeySignerProvider config={{ defaultOrganizationId: "your-org-id" }}>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</TurnkeySignerProvider>

// Or override the apiBaseUrl default:
<TurnkeySignerProvider config={{
  apiBaseUrl: "https://api.turnkey.com",
  defaultOrganizationId: "your-org-id",
}}>
  ...
</TurnkeySignerProvider>
```

`TurnkeySignerProvider` also accepts optional `customComponents` and `importAccountId` props, which it forwards into `accountConfig` (see "Custom Account Components").

Connect via passkey:
```tsx
import { useSigner } from "@miden-sdk/react";
import { useTurnkeySigner } from "@miden-sdk/turnkey-react";

// useSigner() returns null in local-keystore mode (no signer provider mounted),
// so guard before destructuring.
const signer = useSigner();
if (!signer) return null;
const { isConnected, connect, disconnect } = signer;
await connect();  // triggers passkey flow, auto-selects account

// Turnkey-specific extras
const { client, account, setAccount } = useTurnkeySigner();
```

### MidenFi Wallet Adapter (Browser Extension)
```tsx
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";

<MidenFiSignerProvider
  appName="My App"                                        // optional: passed to MidenWalletAdapter
  network={WalletAdapterNetwork.Testnet}                  // WalletAdapterNetwork enum: Devnet | Testnet | Localnet
  autoConnect                                             // reconnect on mount. Default: false
  storageMode="public"                                    // "private" | "public". Default: "public"
  customComponents={[myComponent]}                        // optional: custom AccountComponents
  privateDataPermission={permission}                      // optional: private data access level
  allowedPrivateData={allowedData}                        // optional: allowed private data types
>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</MidenFiSignerProvider>
```

With `MidenFiSignerProvider` in place, use `useSigner()` from the React SDK to manage connection state. The regular React SDK hooks (`useSend`, `useConsume`, etc.) automatically sign via the connected wallet - no additional wiring needed.

> The provider accepts an `accountType` prop, but it is a no-op: account visibility is determined solely by `storageMode` (`private`/`public`), and the provider always imports the account by ID (`importAccountId`), bypassing the builder path entirely. Omit it.

### Wallet-extension detection

`@miden-sdk/react` ships an adapter-agnostic detection primitive, so UI and tests can wait for
the extension without depending on a wallet-adapter package:

```tsx
import { waitForWalletDetection } from "@miden-sdk/react";
import type { WalletAdapterLike } from "@miden-sdk/react";

// WalletAdapterLike is a duck type, nothing more:
//   { readyState: string;
//     on(e: "readyStateChange", cb: (state: string) => void): void;
//     off(e: "readyStateChange", cb: (state: string) => void): void }

await waitForWalletDetection(adapter);        // default timeout: 5000 ms
await waitForWalletDetection(adapter, 10000); // custom timeout
```

It resolves immediately when `adapter.readyState === "Installed"`; otherwise it subscribes to
`readyStateChange` and rejects with `Wallet extension not detected within <n>ms. Is the browser
extension installed and enabled?`. Use it to show an install prompt instead of blindly calling
`connect()`. Source: `packages/react-sdk/src/utils/walletDetection.ts:20-57`.

### Frontend-template-specific MidenFi pattern

The [frontend template](https://github.com/0xMiden/frontend-template) (last verified against web-sdk 0.15; it lives in a separate repository, so re-check its lockfile before trusting the version-specific notes below) deviates from the generic patterns above in three places worth knowing when the wallet extension is the primary signer:

- **Provider order is INVERTED: `MidenProvider` runs OUTSIDE `MidenFiSignerProvider`** - see `src/providers.tsx`. This is the opposite of the canonical signer-outer / Miden-inner nesting at the top of this skill, and it is deliberate. In v0.15 and still in 0.16, when a signer provider is an *ancestor* of `MidenProvider`, `MidenProvider` treats it as its external keystore and does NOT create the `WebClient` until the signer connects (the init effect sees `signerIsConnected === false` and returns early before building the client). With a wallet that hasn't connected - or any environment without the extension - the app would hang on "Initializing…" and even public reads couldn't run. The template never signs *through* `MidenProvider` (it signs its only write, the counter increment, through the local `WebClient` rather than the wallet), so it runs `MidenProvider` in local-keystore mode (no signer ancestor → it initializes immediately, reads work pre-connect) and keeps `MidenFiSignerProvider` *inside*, purely for the connect button and the wallet's `requestTransaction`. `MidenFiSignerProvider` works standalone (it provides its own `WalletContext` + `SignerContext`; no `MultiSignerProvider` needed). Use this inversion only when you do not sign through `MidenProvider`; if external-keystore signing IS the goal, keep the canonical signer-outer order so `MidenProvider` picks up the signer's `signCb`/`accountConfig`.
- **Wallet button uses `useMidenFiWallet()` + `WalletReadyState`** - see `src/components/AppContent.tsx`. The button gates on `wallet?.readyState` (rendering a disabled "Install MidenFi Wallet" state unless `readyState` is `Installed` or `Loadable`) so it can show install state before the extension is detected. `useSigner().connect()` would silently fall through to the adapter's `window.open(adapter.url, ...)` install fallback; gating on `readyState` avoids that path.
- **The counter increment is a local two-transaction flow, not a wallet-signed tx** - see `src/hooks/useIncrementCounter.ts`. It does not use the wallet at all. It creates a throwaway local sender (`client.newWallet(...)`), publishes a plain increment note as that sender's own output note (`TransactionRequestBuilder().withOwnOutputNotes(...)`), then consumes the note *as the counter* (`await client.newConsumeTransactionRequest([note], counterAccountId)` - since 0.16 this is async and requires the consuming account, because it reads the chain's fee parameters to decide whether to attach fee conversion info; the 0.15 form `newConsumeTransactionRequest([note])` no longer compiles). Both transactions are submitted by the local `WebClient` via `submitNewTransactionWithProver(accountId, request, prover)` (remote prover), never by the wallet, so `useWaitForCommit` doesn't apply and the template polls the counter's storage map instead. This mirrors the project-template `increment_count` reference.
  - **The note APIs in that hook (use as the reference):** the JS `NoteMetadata` constructor is attachment-less - `new NoteMetadata(sender, noteType, tag)`. Build the note with `new Note(new NoteAssets(), metadata, recipient)`. The increment note carries no attachment and uses tag `0`; the counter is a plain **public `NoAuth`** account, so anyone can consume the note against it with no signature. (Attachments still exist for other uses - `NoteAttachment.fromWord(scheme, word)` / `fromWords(scheme, words)`, read back via `.toWords()`, or `createNoteAttachment(...)` - but the increment does not need one. Network-execution targeting DOES exist on 0.16: a `Public` note carrying a `NetworkAccountTarget` attachment is auto-consumed by the operator. The target must be an account built from `AccountComponent.createNetworkAuthComponents`, committed on-chain at the transaction's reference block, allowlisting and pricing the note's script root; see `useCreateNetworkNote` in the React SDK. Targeting a plain wallet fails with `account procedure ... is not in the account procedure index map`.)
  - **Two hard requirements (don't regress):** (1) the client runs with `useWorker: false` on `MidenProvider`. The default worker shim keeps a separate in-memory SMT forest per thread; consuming against an *imported* (not locally-created) account applies a delta transaction whose apply step looks the account up in the executing (worker) forest, which never contains the late-imported counter, so it fails with `account data wasn't found` ([web-sdk#222](https://github.com/0xMiden/web-sdk/issues/222)). One thread means one forest, which fixes it. (2) Submits go through the remote prover (`submitNewTransactionWithProver`) so the worker-less single thread only pays local execution, not minutes of local proving. The increment was verified working end-to-end on testnet on v0.15; there is no `INCREMENT_ONCHAIN_BLOCKED` flag. Re-verify against the template's current lockfile before relying on that, and note the `newConsumeTransactionRequest` signature change above.

## Unified Signer Interface

Works with any signer provider above. `useSigner()` returns `null` in local-keystore mode (no signer provider mounted), so guard before destructuring:
```tsx
import { useSigner } from "@miden-sdk/react";

const signer = useSigner();
if (!signer) return null; // local keystore mode - no external signer

const { isConnected, connect, disconnect, name } = signer;

if (!isConnected) {
  return <button onClick={connect}>Connect {name}</button>;
}
```

## Building a Custom Signer

Implement `SignerContextValue` via `SignerContext.Provider`:

```tsx
import { SignerContext } from "@miden-sdk/react";
import { AccountStorageMode } from "@miden-sdk/miden-sdk";

<SignerContext.Provider value={{
  name: "MyWallet",
  storeName: `mywallet_${userAddress}`,  // unique per user for DB isolation
  isConnected: true,
  accountConfig: {
    publicKeyCommitment: userPublicKeyCommitment,  // Uint8Array
    storageMode: AccountStorageMode.private(),      // AccountStorageMode instance, not a string
  },
  signCb: async (pubKey, signingInputs) => {
    // Route to your signing service
    return signature;  // Uint8Array
  },
  connect: async () => { /* trigger wallet connection */ },
  disconnect: async () => { /* clear session */ },
}}>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</SignerContext.Provider>
```

**`SignerContextValue` fields** (`packages/react-sdk/src/context/SignerContext.ts:83-102`):

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name; also the registry key `MultiSignerProvider` stores the signer under |
| `storeName` | yes | Unique per user - becomes the `MidenClientDB_<storeName>` IndexedDB name |
| `isConnected` | yes | `false` blocks client creation on first mount (see the frontend-template note above) |
| `accountConfig` | yes | `SignerAccountConfig` (below); only meaningful while connected |
| `signCb` | yes | `(pubKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array>` |
| `connect` / `disconnect` | yes | `() => Promise<void>` session lifecycle |
| `getKeyCb` | no | `(pubKey: Uint8Array) => Promise<Uint8Array>` - hand back a secret key by commitment |
| `insertKeyCb` | no | `(pubKey: Uint8Array, secretKey: Uint8Array) => void` - persist a key the SDK generated |

Omit both key callbacks for a sign-only service; `MidenProvider` forwards them verbatim to
`createClientWithExternalKeystore`.

**`SignerAccountConfig` fields** (`packages/react-sdk/src/context/SignerContext.ts:55-76`):

| Field | Required | Notes |
|---|---|---|
| `publicKeyCommitment` | yes | `Uint8Array`, deserialized to a `Word` for the auth component |
| `storageMode` | yes | an `AccountStorageMode` **instance** - `AccountStorageMode.private()` / `.public()`, not a string |
| `accountSeed` | no | `Uint8Array` for a deterministic account ID; otherwise 32 random bytes |
| `customComponents` | no | `AccountComponent[]` appended after the basic wallet component |
| `importAccountId` | no | Skip the builder entirely and import this account ID from chain. **Silently makes `customComponents` a no-op.** Use one or the other, never both |
| `accountType` | no | **`@deprecated` and ignored** - visibility comes solely from `storageMode`. Omit it |

`signCb` is not handed to the client directly. `MidenProvider` keeps the latest callback in a ref
and passes a wrapper that reads through it, so reconnecting the *same* identity hot-swaps the
callback (`store.client.setSignCb(wrappedSignCb)`) instead of rebuilding the client. A wrapped call
made after disconnect throws `Signer is disconnected. Cannot sign.`
(`packages/react-sdk/src/context/MidenProvider.tsx:166-212`).

Two hooks additionally hard-block while a signer is mounted but disconnected: `useImportAccount`
and `useMultiSend` call `assertSignerConnected()` and throw `Signer is disconnected. Reconnect your
wallet to perform transactions.` (`packages/react-sdk/src/utils/errors.ts:101-107`).

The two shipped providers are the best worked examples of this contract: read `packages/para/react/src/ParaSignerProvider.tsx` or `packages/turnkey/react/src/TurnkeySignerProvider.tsx` end to end before writing your own.

## How the Account Gets Initialized

`MidenProvider` calls `initializeSignerAccount(client, accountConfig)`
(`packages/react-sdk/src/utils/signerAccount.ts:48-164`) right after creating the
external-keystore client. There are two paths.

**Fast path - `importAccountId` is set.** The builder is skipped and `client.importAccountById()`
runs. It tolerates exactly two machine-readable error codes and rethrows everything else
(`signerAccount.ts:85-89`):

- `ACCOUNT_NOT_FOUND_ON_CHAIN` - a brand-new account not yet registered on-chain. The dApp still
  renders, but **the account is not tracked locally**, so `useAccount` returns `null` and no
  transaction can be built against it until a later `importAccountById` succeeds. `syncState()`
  only refreshes accounts the store already tracks; it never discovers one by ID.
- `ACCOUNT_ALREADY_TRACKED` - already imported locally; harmless.

**Slow path - build from the commitment** (`signerAccount.ts:105-113`):

```ts
new AccountBuilder(seed)
  .withAuthComponent(
    AccountComponent.createAuthComponentFromCommitment(
      commitmentWord,
      AuthScheme.AuthEcdsaK256Keccak  // see the AuthScheme trap below
    )
  )
  .storageMode(config.storageMode)
  .withBasicWalletComponent()
  // then .withComponent(c) for each entry in customComponents
  .build();
```

For a **public** storage mode it first tries `importAccountById` (the account may already exist
on-chain). If that succeeds it syncs and returns immediately - `getAccount` and `newAccount` are
never reached. Only when the import throws does it fall through to checking
`client.getAccount(accountId)` for a local copy and finally `client.newAccount(account, false)`.

Note the hard-coded ECDSA-K256/Keccak auth scheme: an external signer's commitment is registered
as an ECDSA key, not Falcon. The `AuthScheme` symbol here is the numeric WASM enum, not the frozen
string const the package exports - see "The `AuthScheme` trap" under Guarded Multisig below.

**`withAuthComponent` validates nothing.** Its body is `with_component` verbatim
(`crates/web-client/src/models/account_builder.rs:81-85`), so the name is documentation,
not a check: passing a non-auth component compiles, builds, and produces an account with
no auth component, failing later and somewhere else. If you build the component yourself,
the burden of getting it right is entirely yours. The builder also exposes
`withNoAuthComponent()` for the deliberately unauthenticated case and
`buildWithoutSchemaCommitment()` alongside `build()`.

To inspect the keys the client ended up with, use the keystore resource on the high-level client: `client.keystore.getCommitments(accountId)`, `.get(pubKeyCommitment)`, `.getAccountId(pubKeyCommitment)`, `.insert(accountId, secretKey)`, `.remove(pubKeyCommitment)`. (`remove` is not supported on every platform and throws where it is not.)

## Using More Than One Signer

`MultiSignerProvider` (exported from `@miden-sdk/react`) lets several signer providers
coexist and hands `MidenProvider` whichever one is active.

**Registration happens through `<SignerSlot />`, and nothing else.** `SignerSlot` renders
nothing: it reads its nearest ancestor's `SignerContext` and registers that value into the
`MultiSignerProvider` registry. So each signer provider is mounted as a **sibling** of
`MidenProvider`, with a `SignerSlot` inside it. Nesting the providers around
`MidenProvider` and omitting `SignerSlot` leaves `signers` empty, so the first
`connectSigner(name)` throws ``Signer "<name>" not found`` - and the nesting also puts the
innermost provider's own `SignerContext` nearest to `MidenProvider`, bypassing the value
`MultiSignerProvider` is trying to forward.

```tsx
import {
  MultiSignerProvider,
  SignerSlot,
  useMultiSigner,
} from "@miden-sdk/react";

<MultiSignerProvider>
  <ParaSignerProvider apiKey="..." environment="PRODUCTION">
    <SignerSlot />
  </ParaSignerProvider>

  <TurnkeySignerProvider config={{ defaultOrganizationId: "..." }}>
    <SignerSlot />
  </TurnkeySignerProvider>

  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</MultiSignerProvider>;

// inside the tree
const { signers, activeSigner, connectSigner, disconnectSigner } = useMultiSigner();
await connectSigner("Turnkey"); // switches by `name` and calls that signer's connect()
```

`useMultiSigner()` returns `null` outside a `MultiSignerProvider`.

`connectSigner(name)` has three behaviors worth knowing
(`packages/react-sdk/src/context/MultiSignerProvider.tsx:157-196`):

- an unregistered name throws ``Signer "<name>" not found`` **before** anything becomes active, so
  the registry is never left pointing at an invalid name;
- the previously active signer is disconnected **fire-and-forget** - the rejection is only
  `console.warn`ed, never awaited, so a wedged old signer cannot block the new one;
- if the new signer's `connect()` rejects, the active name reverts to `null` and the error is
  rethrown, which puts the app back in local-keystore mode rather than in a half-connected state.

Switching signers changes `storeName`, which makes `MidenProvider` drop its cached in-memory state
and build a fresh client for the new identity; reconnecting the *same* identity hot-swaps `signCb`
on the existing client instead.

`disconnectSigner()` drops the active signer and reverts to local-keystore mode. A single signer provider does NOT need this wrapper - `MidenFiSignerProvider`, `ParaSignerProvider` and `TurnkeySignerProvider` each provide their own `SignerContext` standalone.

## Custom Account Components

Attach application-specific `AccountComponent` instances (e.g., DEX logic from `.masp` packages) to accounts created by the signer:

```tsx
import { type SignerAccountConfig } from "@miden-sdk/react";
import { AccountComponent } from "@miden-sdk/miden-sdk";

const myDexComponent: AccountComponent = await loadCompiledComponent();

const accountConfig: SignerAccountConfig = {
  publicKeyCommitment: userPublicKeyCommitment,
  storageMode: myStorageMode,            // an AccountStorageMode instance (e.g. AccountStorageMode.public())
  customComponents: [myDexComponent],
};
```

Each entry must be a real `AccountComponent` - created via `AccountComponent.compile()`,
`.fromPackage()` or `.fromLibrary()`. The initializer duck-checks for a `getProcedures` method and
throws otherwise (`packages/react-sdk/src/utils/signerAccount.ts:116-128`):

> Each entry in customComponents must be an AccountComponent instance created via AccountComponent.compile(), AccountComponent.fromPackage(), or AccountComponent.fromLibrary().

`SignerAccountConfig` has an `accountType` field, but it is ignored - account kind and code mutability are not encoded in the account, so visibility comes solely from `storageMode`. Omit it.

Components are appended to the `AccountBuilder` after the default basic wallet component. The field is optional - omitting it preserves default behavior.

## Guarded Multisig: Use `createAuthGuardedMultisig`, Never Hand-Rolled MASM

If the signer backs a guarded multisig account (a set of approvers plus a guardian that co-signs), build the auth component with `createAuthGuardedMultisig`. It returns the standard `miden::standards::auth::guarded_multisig` component, statically linked exactly as the Rust client builds it.

```tsx
import {
  createAuthGuardedMultisig,
  AuthGuardedMultisigConfig,
} from "@miden-sdk/miden-sdk";

// approvers and guardian are public key commitments (Word);
// defaultThreshold must be >= 1 and <= approvers.length;
// the guardian key must differ from every approver key;
// the scheme applies to every approver AND the guardian (mixed sets are not expressible here).
const config = new AuthGuardedMultisigConfig(
  approvers,                       // Word[]
  2,                               // defaultThreshold
  guardian,                        // Word
  authScheme                       // see the AuthScheme trap below
);

// Optional: tighten the threshold for specific procedures.
// const tuned = config.withProcThresholds([new ProcedureThreshold(procRoot, 3)]);

const authComponent = createAuthGuardedMultisig(config);

const accountConfig: SignerAccountConfig = {
  publicKeyCommitment,
  storageMode: AccountStorageMode.public(),
  customComponents: [authComponent],
};
```

**The `AuthScheme` trap.** `@miden-sdk/miden-sdk` exports TWO different things under that
name, and the one you get from the browser entry is not the enum this constructor wants.
The package's own `AuthScheme` is a frozen string const, `{ Falcon: "falcon", ECDSA:
"ecdsa" }`, and it **shadows** the wasm-bindgen enum of the same name. So
`AuthScheme.AuthRpoFalcon512` evaluates to `undefined`, and the constructor fails when it
tries to convert it.

On Node the wasm class is re-exported under the non-colliding alias `AuthSchemeNative`, so
`AuthSchemeNative.AuthRpoFalcon512` works there. The browser entry has no such escape
hatch, which is why the SDK's own browser test harness restores it by hand
(`window.AuthScheme = wasm.AuthScheme`). In a browser app, obtain the enum from the wasm
namespace yourself rather than from the package's named export, and verify the value is
not `undefined` before passing it.


**Do not compile equivalent MASM through `AccountComponent.compile` instead.** Doing so links the standards package *dynamically*, which yields a different `auth_tx` procedure root. `AccountComponentInterface::from_procedures` then cannot classify the account, the client treats it as having no recognised auth component, declines to attach fee conversion info, and **every transaction from the account fails on a fee-charging chain**. Nothing warns you at account-creation time; the failure arrives later, at the first send.

## Network Accounts and Network Notes

There **is** a network-execution surface, and a signer-backed app can both create the account and
target it. A network note is a `Public` note carrying a `NetworkAccountTarget` attachment; once it
lands on-chain the targeted network account auto-consumes it, with no manual `consume` on the
recipient side.

### Targeting

```tsx
import { NetworkAccountTarget, NoteExecutionHint } from "@miden-sdk/miden-sdk";

const target = new NetworkAccountTarget(networkAccountId, NoteExecutionHint.always());
// executionHint is optional and defaults to `always`.
// The constructor errors if accountId is not a public account.

target.targetId();       // AccountId
target.executionHint();  // NoteExecutionHint
const attachment = target.toAttachment();         // NoteAttachment
NetworkAccountTarget.fromAttachment(attachment);  // decode back; errors if not a target attachment
```

Source: `crates/web-client/src/models/network_account_target.rs:23-71`.

### Building the note

```tsx
// Note.withAttachments(noteAssets, noteMetadata, noteRecipient, attachments)
// Uses the metadata's sender / note type / tag; attachments on the metadata itself are ignored.
const note = Note.withAttachments(noteAssets, metadata, recipient, [target.toAttachment(), extra]);
note.attachments();    // NoteAttachment[]
note.isNetworkNote();  // true - Public plus a valid NetworkAccountTarget attachment
```

Source: `crates/web-client/src/models/note.rs:212-256`.

From React, `useCreateNetworkNote` builds, funds and submits it in one call:

```tsx
import { useCreateNetworkNote } from "@miden-sdk/react";

const { createNetworkNote, result, isLoading, stage, error, reset } = useCreateNetworkNote();
const { txId, note } = await createNetworkNote({
  accountId: senderId,       // AccountRef - creates, funds and submits the note
  target: networkAccountId,  // AccountRef
  script: myNoteScript,      // NoteScript - OR `recipient`, exactly one of the two
  executionHint,             // optional; defaults to `always`
  inputs: [1n, 2n],          // optional note storage / inputs (used with `script`)
  assetId, amount,           // optional single asset to lock into the note
  attachment: [1n, 2n, 3n],  // optional extra payload appended after the NetworkAccountTarget
});
```

Passing both `recipient` and `script`, or neither, throws
(`packages/react-sdk/src/hooks/useCreateNetworkNote.ts:57-66`); the option and result shapes are
`CreateNetworkNoteOptions` / `NetworkNoteResult` in `packages/react-sdk/src/types/index.ts:406-431`.
From the raw client the equivalent is `client.transactions.createNetworkNote(options)`.

To build a network note without submitting it, import the standalone helper from the package root:

```tsx
import { buildNetworkNote } from "@miden-sdk/miden-sdk";

const note = buildNetworkNote({
  account: senderId,
  target: networkAccountId,
  script: myNoteScript,
});
```

### Creating the network account

A network account is a **public** account carrying the network-account auth component, whose
note-script allowlist is what the node's network-transaction builder inspects:

```tsx
import { AccountBuilder, AccountComponent, AccountStorageMode, NoteScriptFee } from "@miden-sdk/miden-sdk";

// Returns AccountComponent[] - the auth component plus the components backing
// its fee policy. Install ALL of them.
const components = AccountComponent.createNetworkAuthComponents(
  [new NoteScriptFee(myNoteScript.root(), 0n)],  // NoteScriptFee[] - must be non-empty
  feeFaucetId,                                   // AccountId - fees are denominated in this faucet's asset
  allowedTxScriptRoots                           // optional Word[] from TransactionScript.root()
);

const builder = new AccountBuilder(seed)
  .storageMode(AccountStorageMode.public())
  .withComponent(myComponent);
for (const component of components) builder.withComponent(component);
const { account } = builder.build();
```

Four rules bite, all enforced in
`crates/web-client/src/models/account_component.rs:255-335`:

- The allowlist must be **non-empty**. `createNetworkAuthComponents([], ...)` errors, since such an
  account could never consume a note.
- **Install every returned component.** The call returns the auth component *plus* the components
  backing its fee policy; dropping any of them leaves the account unable to price a consumption.
- **Every allowlisted script is priced by construction** - each `NoteScriptFee` carries root and
  amount together. A fee of `0n` is valid; a script root the account does not price at all aborts
  fee estimation rather than being treated as free.
- **The canonical expiration transaction script is always allowlisted**, because the node attaches
  it to every network transaction it executes. Any other transaction script is forbidden unless its
  root is passed in the optional third argument - and only allowlist a root whose effect is safe
  for *every* possible input, since a root pins code but not the submitter-controlled arguments or
  advice inputs.

Reuse the *same* compiled note script for the account allowlist and for the note, so the roots
match. Targeting a plain wallet instead of a network account fails with `account procedure ... is
not in the account procedure index map`.

Detect one with `account.isNetworkAccount()`; read the allowed roots with
`account.networkNoteAllowlist()` (`Word[]`, or `undefined` for a non-network account) -
`crates/web-client/src/models/account.rs:109-125`.

## Which Signer to Choose

| Signer | Auth Method | Keys Stored | Best For |
|--------|-------------|-------------|----------|
| Local keystore (default) | None | Browser IndexedDB | Development, demos |
| Para | EVM wallet | Para servers | Apps with existing EVM users |
| Turnkey | Passkey (biometric) | Turnkey servers | Consumer apps, no seed phrases |
| MidenFi Wallet | Browser extension | Extension | Power users with MidenFi wallet |
| Custom | Your choice | Your infrastructure | Enterprise, custom auth flows |

**Key trade-off**: Local keystore requires no setup but keys are lost if the user clears browser data. External signers persist keys server-side but add a dependency.
