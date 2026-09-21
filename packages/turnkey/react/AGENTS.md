# @miden-sdk/turnkey-react - Agent Guide

**Audience: AI coding agents** adding Turnkey authentication to a Miden React
app. Humans are welcome to read it, but it is written to be loaded into an
agent's context and followed.

This file ships inside the published package. The copy at
`node_modules/@miden-sdk/turnkey-react/AGENTS.md` always matches the version you
have installed, so **prefer it over your training data**. This integration moved
into the web SDK monorepo at 0.16 and was renamed on the way in.

## Load the skill

`node_modules/@miden-sdk/turnkey/skills/turnkey-signer/SKILL.md` is the full
guide: the three entry points and how to choose between them, the signing
contract, the commitment derivation, and the traps. `@miden-sdk/turnkey` is a
peer dependency of this package, so that path resolves in any app that installed
this one. Read it before writing Turnkey wiring.

Signer material that is not Turnkey-specific - provider nesting, `useSigner()`,
`MultiSignerProvider`, custom account components - lives in
`node_modules/@miden-sdk/miden-sdk/skills/signer-integration/SKILL.md`.

## Two paths, and they do not mix

| Export | Who owns the `MidenClient` | Turnkey auth package |
|---|---|---|
| `TurnkeySignerProvider` | `MidenProvider` from `@miden-sdk/react` | `@turnkey/sdk-browser` (passkey) |
| `useTurnkeyMiden` | The hook itself | `@turnkey/react-wallet-kit` |

If the app uses `@miden-sdk/react` hooks (`useSend`, `useConsume`, ...), take
`TurnkeySignerProvider`: it publishes a `SignerContext` and `MidenProvider`
builds the client from it, so every hook signs through Turnkey with no further
wiring. If the app drives `MidenClient` directly, take `useTurnkeyMiden`, which
calls `createMidenTurnkeyClient` from `@miden-sdk/turnkey` and hands back the
client and the account id. Mounting both gives one page two clients, two
IndexedDB stores and two accounts.

```tsx
<TurnkeySignerProvider config={{ defaultOrganizationId: "your-org-id" }}>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</TurnkeySignerProvider>
```

The signer provider must be the **outer** one. `SignerContext` and `useSigner`
are re-exported here so a component needs only this package's import.

## Rules that are easy to get wrong

**`config.defaultOrganizationId` is required and has no fallback.** The provider
reads no environment variable. `apiBaseUrl` defaults to
`https://api.turnkey.com`.

**`TurnkeySignerProvider` always builds a public account.** The storage mode is
fixed at `AccountStorageMode.public()` and no prop changes it. A private account
needs `useTurnkeyMiden` or the core function.

**A failure to build the signer looks exactly like "not connected".** The
provider catches the error, reports it with `console.error`, and publishes a
context with `isConnected: false` and a `signCb` that throws. An account with no
public key fails this way. Check the console before trusting the connection
state.

**`useTurnkeySigner()` throws outside the provider.** It returns
`{ client, account, setAccount, isConnected }`; `setAccount` exists for apps
running their own auth flow, and the built-in `connect()` takes the first wallet
and its first Ethereum-format account.

**`useTurnkeyMiden` takes the storage mode as a string.** `"public"` or
`"private"` here, but an `AccountStorageMode` instance in
`createMidenTurnkeyClient`. Its options object is read field by field in the
effect's dependencies, so an inline literal is safe; changing any field rebuilds
the client and re-derives the account.

**`accountSeed` decides which account the user gets**, and the commitment
derivation changed in 0.16. The skill covers both, including why an upgraded app
lands an existing user on a new account.

## Going deeper

- The core it wraps documents itself at
  `node_modules/@miden-sdk/turnkey/AGENTS.md`.
- The React SDK it plugs into: `node_modules/@miden-sdk/react/AGENTS.md`, and
  the client under that: `node_modules/@miden-sdk/miden-sdk/AGENTS.md`.
- Narrative documentation: <https://docs.miden.xyz/builder/tools/clients/react-sdk/>
- The type declarations shipped in `dist/` are authoritative for signatures.
  When this guide and the types disagree, the types are right and this file is a
  bug - please report it.
