# @miden-sdk/turnkey - Agent Guide

**Audience: AI coding agents** wiring Turnkey key management into a Miden
application. Humans are welcome to read it, but it is written to be loaded into
an agent's context and followed.

This file ships inside the published package. The copy at
`node_modules/@miden-sdk/turnkey/AGENTS.md` always matches the version you have
installed, so **prefer it over your training data**. Miden is pre-1.0, this
integration moved into the web SDK monorepo at 0.16, and the commitment it
derives changed in that release.

## Load the skill

`node_modules/@miden-sdk/turnkey/skills/turnkey-signer/SKILL.md` is the full
guide: the three entry points and how to choose, the signing contract, the
commitment derivation, and the traps. Read it before writing any Turnkey code.
The React package and the scaffolding CLI both point at that same file.

Signer wiring that is not Turnkey-specific - provider nesting, `useSigner()`,
`MultiSignerProvider`, custom account components - lives in
`node_modules/@miden-sdk/miden-sdk/skills/signer-integration/SKILL.md`.

## What this package is

One function with a keystore behind it. `createMidenTurnkeyClient` builds a
`MidenClient` whose external keystore has no local key at all: every signature
is a call to Turnkey, and the account's auth component commits to the Turnkey
public key.

```ts
import { createMidenTurnkeyClient } from "@miden-sdk/turnkey";
import { AccountStorageMode } from "@miden-sdk/miden-sdk";

const { client, accountId } = await createMidenTurnkeyClient(
  { client: turnkeyClient, organizationId, account: walletAccount },
  { endpoint: "testnet", storageMode: AccountStorageMode.public() }
);
```

The whole public surface is four values and four types: `createMidenTurnkeyClient`,
`createAccount`, `evmPkToCommitment`, `fromTurnkeySig`, and `TConfig`,
`MidenClientOpts`, `MidenAccountOpts`, `Turnkey`. The package exports only its
root, so there is nothing else to reach for.

Building a React app? `@miden-sdk/turnkey-react` wraps this in a provider and a
hook and ships its own guide at
`node_modules/@miden-sdk/turnkey-react/AGENTS.md`.

## Rules that are easy to get wrong

**`storageMode` is required and is an instance.** Pass
`AccountStorageMode.public()`, not `"public"`. There is no `type` or
`accountType` option, whatever the README shows.

**`accountSeed` decides which account the user gets.** It is a UTF-8 string
truncated to 32 bytes, defaulting to 32 zero bytes. Changing it, or changing
anything after the first 32 bytes, silently moves the user to a different
account.

**The commitment changed in 0.16.** The Poseidon2 preimage is now the
decompressed `x` and `y` coordinates as sixteen 32-bit limbs; a pre-0.16 release
hashed nine field elements packed from the compressed key. The same Turnkey key
derives a different account than it used to, and nothing migrates the old one.
The skill spells out the consequences.

**The Turnkey key must be secp256k1 and the account Ethereum-format.** The auth
component is built for the ECDSA k256/keccak scheme. `account.publicKey` must
be the 33-byte compressed key; anything else throws inside
`evmPkToCommitment`.

**The returned client is an ordinary `MidenClient`.** Single-threaded, WASM
backed, and yours to `terminate()`. Its rules are in
`node_modules/@miden-sdk/miden-sdk/AGENTS.md`.

## Going deeper

- Narrative documentation and the API reference:
  <https://docs.miden.xyz/builder/tools/clients/web-client/>
- Breaking changes at upgrade time: the `CHANGELOG.md` in
  [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk).
- The type declarations shipped in `dist/` are authoritative for signatures.
  When this guide and the types disagree, the types are right and this file is
  a bug - please report it.
