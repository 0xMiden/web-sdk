---
name: turnkey-signer
description: Turnkey-specific guide for the Miden web SDK. Covers the three entry points (createMidenTurnkeyClient, TurnkeySignerProvider, useTurnkeyMiden), which one to pick, the ECDSA k256/keccak signing contract, public-key commitment derivation, account bootstrap, and the traps that land a user on an unexpected account. Use when adding Turnkey authentication to a Miden app, when a Turnkey signature is rejected, or when a Turnkey login resolves to a different account ID than expected.
---

# Turnkey Signing for Miden

Turnkey holds a secp256k1 key and signs on request; Miden never sees it. These
packages turn that into a Miden account whose auth component commits to the
Turnkey public key, plus a sign callback that routes every Miden signature
through Turnkey.

This skill is the Turnkey half. Provider nesting, the unified `useSigner()`
interface, running several signer providers behind `MultiSignerProvider`, custom
account components and how to write a signer from scratch are in
`node_modules/@miden-sdk/miden-sdk/skills/signer-integration/SKILL.md` and are
not repeated here.

## Which entry point

| Entry point | Package | Owns the client | Use when |
|---|---|---|---|
| `TurnkeySignerProvider` | `@miden-sdk/turnkey-react` | `MidenProvider` does | The app uses `@miden-sdk/react` hooks. Auth is a passkey via `@turnkey/sdk-browser`. |
| `useTurnkeyMiden` | `@miden-sdk/turnkey-react` | The hook does | The app drives `MidenClient` itself and authenticates with `@turnkey/react-wallet-kit`. |
| `createMidenTurnkeyClient` | `@miden-sdk/turnkey` | You do | No React, or you already have a Turnkey client and want the account bootstrap only. |

Pick one. `TurnkeySignerProvider` and `useTurnkeyMiden` each build a client with
its own IndexedDB store, so mounting both gives the user two clients and two
stores in one page.

## createMidenTurnkeyClient

```ts
import { createMidenTurnkeyClient } from "@miden-sdk/turnkey";
import { AccountStorageMode } from "@miden-sdk/miden-sdk";

const { client, accountId } = await createMidenTurnkeyClient(
  { client: turnkeyClient, organizationId, account: walletAccount },
  { endpoint: "testnet", storageMode: AccountStorageMode.public() }
);
```

First argument (`TConfig`):

- `client` - a `TurnkeyClient` (`@turnkey/http`), a `TurnkeyBrowserClient`
  (`@turnkey/sdk-browser`), or a `TurnkeySDKClientBase` (`@turnkey/core`). The
  `@turnkey/http` client goes through the activity API and its result is
  checked for `ACTIVITY_STATUS_COMPLETED`; the other two call `signRawPayload`
  directly.
- `organizationId` - required by the type, and sent on the `@turnkey/http`
  activity path. The other clients carry their own organization context.
- `account` - a Turnkey `WalletAccount`. `account.address` is what Turnkey
  signs with, and `account.publicKey` must be the 33-byte compressed SEC1 key.

Second argument (`MidenClientOpts & MidenAccountOpts`):

| Option | Type | Notes |
|---|---|---|
| `storageMode` | `AccountStorageMode` | Required. An instance (`AccountStorageMode.public()`), never a string. |
| `endpoint` | `string` | Becomes `ClientOptions.rpcUrl`, so `"testnet"`, `"devnet"`, `"localhost"` and raw URLs all work. Omitted means the SDK default. |
| `noteTransportUrl` | `string` | Becomes `ClientOptions.noteTransportUrl`. |
| `seed` | `Uint8Array` | Client seed, passed straight through. |
| `accountSeed` | `string` | UTF-8, truncated to 32 bytes. Defaults to 32 zero bytes. |

There is no `type` or `accountType` option. The README shows one; it is not in
the type and nothing reads it.

`accountId` comes back as the canonical hex string.

What the call does, in order: creates a `MidenClient` with `autoSync: true` and
a keystore whose `getKey` always resolves `undefined` and whose `insertKey` is
a no-op, so no secret key is ever generated or stored locally; syncs; derives
the commitment from `account.publicKey`; builds an account from the account
seed with the ECDSA auth component plus the basic wallet component; attempts
`accounts.import(account)` so an account already on chain is hydrated rather
than recreated; inserts it locally if the import found nothing; syncs again.

`createAccount(client, storageMode, config, opts?)` is exported separately if
you already have a client and only need the account bootstrap.

## TurnkeySignerProvider

```tsx
<TurnkeySignerProvider config={{ defaultOrganizationId: "your-org-id" }}>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</TurnkeySignerProvider>
```

- `config` is required and `defaultOrganizationId` within it. `apiBaseUrl`
  defaults to `https://api.turnkey.com`. There is no environment-variable
  fallback for the organization ID.
- `customComponents` and `importAccountId` are forwarded into the signer's
  `accountConfig`.
- The storage mode is fixed at `AccountStorageMode.public()`. No prop changes
  it; use `useTurnkeyMiden` or the core function if you need a private account.
- `storeName` is `turnkey_<account.address>`, which is what isolates one user's
  IndexedDB data from another's.
- `connect()` initializes an IndexedDB client, runs a `READ_WRITE` passkey
  login only when no session exists, then takes `wallets[0]` and the first
  account whose `addressFormat` is `ADDRESS_FORMAT_ETHEREUM` (falling back to
  `accounts[0]`). A user with several wallets gets the first one.

`useTurnkeySigner()` returns `{ client, account, setAccount, isConnected }` and
throws outside the provider. `setAccount` is for apps that run their own
Turnkey auth flow and hand the resulting `WalletAccount` over.

Context construction failures are caught, reported with `console.error`, and
published as a disconnected context whose `signCb` throws "Turnkey wallet not
connected". An account with no public key therefore looks exactly like a user
who never connected. Read the console before believing the connection state.

## useTurnkeyMiden

```tsx
const { client, accountId } = useTurnkeyMiden("testnet", "public", {
  accountSeed: "my-app-v1",
});
```

- Requires `TurnkeyProvider` from `@turnkey/react-wallet-kit` above it.
- `storageMode` is the string `"public"` or `"private"` here, unlike the core
  function which takes an `AccountStorageMode` instance.
- Uses the first embedded wallet (`wallet.source === "embedded"`) and its first
  account. The organization ID comes from `opts.organizationId`, else from the
  Turnkey session.
- `opts.endpoint` overrides the `nodeUrl` argument when both are present.
- The effect depends on the individual `opts` fields, not on the object, so an
  inline object literal is safe. Changing any of them rebuilds the client and
  re-derives the account.
- `client` is `null` until Turnkey has an embedded wallet, an HTTP client and an
  organization ID. Missing pieces are reported with `console.warn` only, and a
  failed bootstrap with `console.error`; neither surfaces in the return value.

## The signing contract

Every Miden signature goes through the same path:

1. The SDK calls `signCb(pubKey, signingInputs)`.
2. The callback deserializes `SigningInputs` and takes
   `inputs.toCommitment().toHex()`.
3. Turnkey signs that hex with `PAYLOAD_ENCODING_HEXADECIMAL` and
   `HASH_FUNCTION_KECCAK256`.
4. `fromTurnkeySig({ r, s, v })` packs the result into the 67-byte buffer the
   SDK expects: byte 0 is the auth scheme tag `1`, `r` at offset 1, `s` at
   offset 33, `v` at offset 65.

The auth component comes from
`AccountComponent.createAuthComponentFromCommitment(commitment, 1)`, where `1`
is the WASM `AuthScheme` enum's ECDSA k256/keccak variant. (The `AuthScheme`
constant exported from `@miden-sdk/miden-sdk` is a different thing, the string
pair `{ Falcon, ECDSA }` for client options; do not pass it here.) The Turnkey
key must be secp256k1 and the wallet account Ethereum-format; a key on any other
curve cannot back this account.

Use `fromTurnkeySig`. Handing Turnkey's `{ r, s, v }` to the SDK in any other
layout produces a signature the account rejects, with no hint about why.

Each signature is a Turnkey round trip, and `createMidenTurnkeyClient` writes a
`turnkey signing` `console.time` pair around it.

## The public-key commitment

`evmPkToCommitment(compressedPk)` takes the 33-byte compressed SEC1 key as hex
(`0x` prefix optional) and returns a `Word`. It throws if the key is not
exactly 33 bytes or is not a point on secp256k1.

It recovers `y` from the parity byte, splits `x` and then `y` into eight 32-bit
limbs each in little-endian limb order, and hashes the 16 field elements with
Poseidon2. That is the preimage the protocol commits to.

**This changed.** A pre-0.16 release of this integration hashed nine field
elements packed straight from the compressed encoding, with no decompression.
The same Turnkey key therefore produces a different commitment, a different
auth component, and an account that is not the one an older release derived.
There is no migration path: a user signing in through an upgraded app lands on
a new, empty account, and assets in the old one stay there. Plan for that
before shipping an upgrade.

## Traps

- **Do not copy the peer-dependency versions out of the READMEs.** They still
  say `@miden-sdk/miden-sdk@^0.13.0`. The real range is in `package.json`.
- **`accountSeed` decides the account.** Change it and the same user gets a
  different account. It is truncated at 32 bytes, so two seeds sharing a
  32-byte prefix are one seed.
- **The returned client is a normal `MidenClient`.** It is single-threaded and
  WASM-backed: serialize calls into it, and read
  `node_modules/@miden-sdk/miden-sdk/AGENTS.md` for the rest.
- **The keystore is deliberately empty.** `getKey` returns `undefined` by
  design. Do not "fix" it by wiring a local keystore in; that would create a
  second signing identity the account does not commit to.
