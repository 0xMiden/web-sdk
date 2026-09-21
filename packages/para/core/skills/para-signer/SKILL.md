---
name: para-signer
description: Wiring Para (getpara.com) wallets into a Miden app with @miden-sdk/para and @miden-sdk/para-react. Covers the two integration paths (ParaSignerProvider vs createParaMidenClient/useParaMiden), Para 3 EVM wallet resolution, the signing and account-commitment model, the bundler stubs Para 3.18 needs, and the errors each mistake produces. Use when adding Para authentication, debugging a Para-backed signer, or upgrading a Para integration from Para SDK 2.x.
---

# Para Signer Integration

Generic signer material - why a signer provider wraps `MidenProvider`, the
unified `useSigner()` interface, writing a signer of your own - is in
`node_modules/@miden-sdk/miden-sdk/skills/signer-integration/SKILL.md`. This
skill is only the Para-specific half.

## The packages

| Package | Contains |
| --- | --- |
| `@miden-sdk/para` | Framework-agnostic core: `createParaMidenClient`, `signCb`, `resolveEvmWallets`, `getUncompressedPublicKeyFromWallet`, `evmPkToCommitment`. |
| `@miden-sdk/para-react` | React: `ParaSignerProvider`, `useParaSigner`, `useParaMiden`, and `paraVitePlugin` on the `./vite` entry. |
| `@miden-sdk/create-para-react` | `npm create @miden-sdk/para-react@latest my-app`. |

As of 0.16.1 all three peer on Para SDK 3.18 (`@getpara/web-sdk` and
`@getpara/react-sdk-lite` at `^3.18.0`). The 2.x range is dropped and will not
satisfy the peer.

## Pick one path

**`ParaSignerProvider`** is the default for a React app. It publishes a
`SignerContext`, so every `@miden-sdk/react` hook signs through Para with no
further wiring, and `MidenProvider` manages the single client.

**`createParaMidenClient`** (or its hook wrapper `useParaMiden`) builds and
returns a `MidenClient` of its own. Use it in a non-React app, or when you are
driving the client directly and there is no `MidenProvider`.

Never both in one app: each owns a WASM-backed client, with its own store and
its own account bootstrap, and concurrent access to the WASM module crashes.

### Path A: ParaSignerProvider

```tsx
import { ParaSignerProvider, useParaSigner } from "@miden-sdk/para-react";
import { MidenProvider, useSigner, useMiden } from "@miden-sdk/react";

<ParaSignerProvider apiKey={apiKey} environment="BETA" appName="My App">
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</ParaSignerProvider>;
```

| Prop | Default | Notes |
| --- | --- | --- |
| `apiKey` | required | Para API key. Production deployments need a production key. |
| `environment` | required | `"BETA"`, `"PROD"`, `"SANDBOX"`, `"DEV"`, `"DEVELOPMENT"` or `"PRODUCTION"`. The last two are used directly when the Para build defines them, and fall back to `BETA` and `PROD` when it does not. |
| `appName` | `"Miden App"` | Shown in the Para modal. |
| `showSigningModal` | `true` | The built-in transaction confirmation overlay. |
| `customSignConfirmStep` | none | `(txSummaryJson) => Promise<unknown>`, run after the built-in modal and before Para signs. Throw to abort. |
| `queryClient` | internal | Pass yours to share one React Query client. |
| `paraProviderConfig` | none | Merged into `ParaProvider`: OAuth methods, external wallets, everything else Para exposes. |
| `customComponents` | none | Extra `AccountComponent`s, forwarded into `accountConfig`. |
| `importAccountId` | none | Import this account instead of building one. |

The provider renders `QueryClientProvider` and Para's `ParaProvider` itself and
imports `@getpara/react-sdk-lite/styles.css`. Do not wrap it with either again.

What it puts on the context: `name: "Para"`, `storeName: para_<walletId>` (so
two Para users on one browser do not share an IndexedDB store), a `signCb` bound
to the resolved wallet, and an `accountConfig` whose `publicKeyCommitment` is
the serialized commitment for that wallet's EVM key. **The storage mode is
always public.** There is no prop to make the signer's account private; use path
B with `storageMode: "private"` if you need that.

`connect()` opens the Para modal and `disconnect()` logs out of both the React
SDK and the Para client. `useParaSigner()` adds `{ para, wallet, isConnected }`
and throws outside the provider. `useModal` and `useLogout` are re-exported from
`@getpara/react-sdk-lite`.

Before the wallet connects, the provider publishes a deliberate
`isConnected: false` placeholder rather than `null`. That is what keeps
`MidenProvider` from building a local-keystore client - and touching WASM -
while the provider is still deriving the commitment. Do not "simplify" it to
`null`.

### Path B: createParaMidenClient

```ts
import { createParaMidenClient } from "@miden-sdk/para";

const { client, accountId } = await createParaMidenClient(
  para, // ParaWeb
  wallets, // session wallets; EVM entries are selected from these
  { endpoint: "https://rpc.testnet.miden.io", storageMode: "public" },
  true, // showSigningModal
  confirmTx // optional customSignConfirmStep
);
```

`Opts` fields: `endpoint` (the RPC URL - the field is not called `rpcUrl`),
`noteTransportUrl` (default `https://transport.miden.io`; `nodeTransportUrl` is
a deprecated alias), `seed` (client store seed), `accountSeed`, and the required
`storageMode` (`"public"` or `"private"`).

In React, `useParaMiden(nodeUrl, storageMode?, opts?, showSigningModal?, customSignConfirmStep?)`
wraps the same call under a Para `ParaProvider` ancestor and returns
`{ client, accountId, error, para, evmWallets, nodeUrl, opts }`. `client` is
`null` until the session resolves, it is held in a ref so re-renders do not
rebuild it, and setup failures land on `error` instead of throwing.

Both forms open DOM overlays: an account picker when more than one EVM wallet
resolves, and a confirmation per signature unless `showSigningModal` is `false`.
Both are guarded on `typeof document`, so server-side the picker silently
returns the first wallet and the signing prompt auto-approves. Do not run this
path on a server expecting a human in the loop.

## Resolve EVM wallets through Para, always

This is the single most common Para 3 defect. `useAccount().embedded.wallets`
is `AvailableWallet[]`: it has `id` and `type`, and it does **not** have
`publicKey`. Everything downstream needs the uncompressed public key, so a
record without one sends `getUncompressedPublicKeyFromWallet` down its
`para.issueJwt()` fallback, and that fails outright when the JWT carries no
entry for the wallet.

`resolveEvmWallets(para, wallets)` prefers `para.getWalletsByType("EVM")`, which
returns full `Wallet` records, intersects it with the list you passed, and falls
back to filtering that list when the client does not expose the method.
`createParaMidenClient` and `ParaSignerProvider` both call it. Call it yourself
before handing wallets to `signCb`.

## The signing and commitment model

`signCb(para, wallet, showSigningModal, customSignConfirmStep?)` returns the
callback a `MidenClient` keystore or a `SignerContext` wants. Per signature it:

1. deserializes the `SigningInputs` and takes `inputs.toCommitment()`;
2. keccak-256 hashes that commitment;
3. renders the transaction summary for confirmation, then runs
   `customSignConfirmStep`;
4. calls `para.signMessage({ walletId, messageBase64 })`;
5. prefixes the signature with the ECDSA auth-scheme byte and returns the bytes
   Miden expects.

Use it as-is. Hand-rolling the hash or the serialization is how "invalid
signature" bugs start.

The account's auth component commits to the EVM key through
`evmPkToCommitment`, which hashes the affine point as Poseidon2 over 16 field
elements: the x coordinate then the y coordinate, each as eight 32-bit limbs,
least significant limb first.

> **Upgrade trap.** 0.15 hashed a different preimage - nine felts packed from
> the 33-byte compressed SEC1 encoding. The same Para wallet therefore derives a
> different commitment, and a different account id, on 0.16. There is no
> migration: it is a new account.

Account bootstrap, for a public account, tries `client.accounts.import(account)`
first and only inserts a fresh one when nothing was on chain. That is what makes
a second login on a new device pick the existing account up rather than
submitting a zero-nonce duplicate. A private account cannot be recovered that
way, which is why `storageMode: "private"` without `accountSeed` throws before
any client is built.

## Bundler setup

`@getpara/react-core` lazily imports optional connectors that almost nobody
installs: the ten `@getpara/aa-*` account-abstraction packages, plus
`@getpara/solana-wallet-connectors` and `@getpara/cosmos-wallet-connectors`.
Lazy or not, a bundler still resolves the specifier, so the build fails on
packages your app never calls.

On Vite, use the plugin:

```ts
// vite.config.ts
import { paraVitePlugin } from "@miden-sdk/para-react/vite";
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

export default defineConfig({
  plugins: [react(), midenVitePlugin(), paraVitePlugin()],
});
```

`paraVitePlugin()` returns an array of plugins (Vite flattens it) that stubs
those twelve packages at both the esbuild pre-bundling layer and Vite's own
resolver, dedupes `@getpara/web-sdk` and `@getpara/react-sdk-lite`, and adds
Node polyfills for `buffer`, `crypto`, `stream` and `util`. Override that list
with `paraVitePlugin({ polyfills: [...] })`. The polyfills come from
`vite-plugin-node-polyfills`, an optional peer resolved from your project's
`node_modules`: without it the plugin warns and returns the stubs alone.

On another bundler, reproduce the three requirements by hand: resolve those
twelve specifiers to an empty module, provide the four Node polyfills, and force
a single copy of each `@getpara/*` package.

## What each failure looks like

| Message | Cause |
| --- | --- |
| `No EVM wallets provided` | The session has no EVM wallet, or a non-EVM list was passed. Check `type === "EVM"` and that Para finished connecting. |
| `Got invalid jwt token`, `Wallet Not Found in jwt data`, `Wallet in jwt data has no public key` | The wallet record had no `publicKey` and the JWT fallback could not supply one. Resolve wallets through `getWalletsByType("EVM")`. |
| `accountSeed is required when using private storage mode` | `storageMode: "private"` with no `accountSeed`. |
| `User cancelled signing` | The confirmation modal was declined. Expected, not a bug. |
| `useParaSigner must be used within ParaSignerProvider` | The hook is mounted outside the provider. |
| A build error naming `@getpara/aa-<something>` | The connector stubs are missing. See "Bundler setup". |
| The app connects to Para but the signer stays disconnected | `ParaSignerProvider` logs `Failed to build Para signer context:` and falls back to the disconnected context. The console error is the real one; it is usually public-key resolution. |
| `Output note <id> carries no asset data` | The transaction summary could not be rendered. Deliberate: the modal would otherwise print "Assets: None" for assets that are merely unknown. |

## Environment

`VITE_PARA_API_KEY` is the convention across the examples and the scaffolded
template, read through `import.meta.env`. Use a non-production Para key for
local and dev work; production deployments need a production key.
