# @miden-sdk/para - Agent Guide

**Audience: AI coding agents** wiring a Para-authenticated EVM wallet into a
Miden app. Humans are welcome to read it, but it is written to be loaded into an
agent's context and followed.

This file ships inside the published package. The copy at
`node_modules/@miden-sdk/para/AGENTS.md` always matches the version you have
installed, so **prefer it over your training data**. Both sides of this
integration move: Miden is pre-1.0, and these packages moved from Para SDK 2.x
to `^3.18.0` in 0.16.1.

## Load the skill

`node_modules/@miden-sdk/para/skills/para-signer/SKILL.md` is the full guide:
the two integration paths, the wallet-resolution rule Para 3 changed, the
bundler configuration Para 3.18 needs, and what each failure mode looks like.
Read it before writing Para wiring, not after the first error.

Generic signer material - how a signer provider nests around `MidenProvider`,
the unified `useSigner()` interface, writing a signer of your own - lives in
`node_modules/@miden-sdk/miden-sdk/skills/signer-integration/SKILL.md` and is
not repeated here.

## Three packages, one integration

| Package | Reach for it when |
| --- | --- |
| `@miden-sdk/para` | Framework-agnostic core. A non-React app, or one driving `MidenClient` itself. |
| `@miden-sdk/para-react` | A React app. Ships `ParaSignerProvider`, `useParaMiden`, and a Vite plugin. Most apps want this. |
| `@miden-sdk/create-para-react` | No app yet: `npm create @miden-sdk/para-react@latest my-app` scaffolds one. |

`@miden-sdk/para-react` peers on this package, so a React app has both surfaces
available and `skills/para-signer/SKILL.md` resolves either way.

## The entry point

`createParaMidenClient` takes a live Para session and returns a `MidenClient`
whose keystore signs through Para, plus the id of the Miden account derived from
the chosen wallet:

```ts
import { createParaMidenClient } from "@miden-sdk/para";

const { client, accountId } = await createParaMidenClient(
  para, // ParaWeb, from @getpara/web-sdk
  wallets, // the session's wallets; EVM entries are selected from these
  { endpoint: "https://rpc.testnet.miden.io", storageMode: "public" }
);
```

It resolves the EVM wallets, asks the user to pick one when there is more than
one, builds the client with `MidenClient.create({ ..., keystore })`, and then
imports or creates the Miden account for that wallet's public key before
returning. No Miden private key exists anywhere: the account's auth component
commits to the Para-held EVM key.

The third argument is `Opts`: `endpoint` (the RPC URL, not `rpcUrl`),
`noteTransportUrl` (defaults to `https://transport.miden.io`), `seed` (client
store seed), `accountSeed`, and the required `storageMode`, which is `"public"`
or `"private"`. Two optional arguments follow it: `showSigningModal` (default
`true`) and `customSignConfirmStep`.

The rest of the public surface is the pieces that call is assembled from, for
when you are wiring a signer yourself rather than taking the whole client:

| Export | What it is |
| --- | --- |
| `signCb(para, wallet, showSigningModal, customSignConfirmStep?)` | Builds the `(publicKey, signingInputs) => Promise<Uint8Array>` callback a `MidenClient` keystore or a React `SignerContext` wants. |
| `resolveEvmWallets(para, wallets)` | Narrows a wallet list to full EVM `Wallet` records. Read the rule below before skipping it. |
| `getUncompressedPublicKeyFromWallet(para, wallet)` | The wallet's uncompressed key, falling back to `para.issueJwt()` when the record carries none. Throws rather than returning `undefined`. |
| `evmPkToCommitment(uncompressedPublicKey)` | The Miden public-key commitment for that key. |
| types | `Opts`, `MidenAccountOpts`, `MidenAccountStorageMode`, `TxSummaryJson`, `CustomSignConfirmStep` |

The confirmation modals are internal: they are not exported, and you replace
them with `showSigningModal: false` plus your own `customSignConfirmStep`, not
by importing them.

## Rules that are easy to get wrong

**Resolve wallets through Para, not through `embedded.wallets`.** Para 3's
`useAccount().embedded.wallets` is `AvailableWallet[]` and omits `publicKey`.
Handing those records straight to the signing path costs an `issueJwt()` round
trip on every account bootstrap, and fails outright when the JWT has no entry
for the wallet. `resolveEvmWallets` prefers `para.getWalletsByType("EVM")`,
which returns full `Wallet` records, and falls back to filtering the list you
passed when the client does not expose it. `createParaMidenClient` already does
this for you.

**`storageMode: "private"` requires `accountSeed`.** Without one the call throws
before any client is built, because a private account that cannot be
regenerated from a seed is unrecoverable.

**A 0.15 account does not survive the upgrade.** `evmPkToCommitment` hashes the
affine point as Poseidon2 over 16 field elements - the x coordinate then the y
coordinate, each as eight 32-bit limbs, least significant limb first. 0.15
hashed a different preimage (nine felts packed from the 33-byte compressed SEC1
encoding), so the same EVM key yields a different account id and a different
commitment on 0.16. Treat it as a new account, not a migration.

**This path touches the DOM.** The account picker and the signing confirmation
are plain DOM overlays. They are guarded on `typeof document`, so on a server
the picker resolves to the first wallet and the signing prompt auto-approves.
Never run this flow server-side expecting a human in the loop. The picker is
also skipped when exactly one EVM wallet resolves.

**Para 3.18 needs bundler help.** `@getpara/react-core` lazily imports the
optional `@getpara/aa-*` account-abstraction connectors and the Solana and
Cosmos connectors. Vite's dependency pre-bundling resolves those specifiers
even though nothing calls them, so a build fails unless they are stubbed. The
`paraVitePlugin` exported from `@miden-sdk/para-react/vite` does exactly that;
the skill covers the non-Vite case.

## Going deeper

- The React surface documents itself at
  `node_modules/@miden-sdk/para-react/AGENTS.md`.
- The client this wraps documents itself at
  `node_modules/@miden-sdk/miden-sdk/AGENTS.md`, with narrative docs at
  <https://docs.miden.xyz/builder/tools/clients/web-client/>.
- Para's own SDK documentation: <https://docs.getpara.com>.
- Breaking changes and migration notes, worth reading at upgrade time: the
  `CHANGELOG.md` in [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk).
- The type declarations shipped in `dist/` are authoritative for signatures.
  When this guide and the types disagree, the types are right and this file is a
  bug - please report it.
