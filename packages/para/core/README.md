# @miden-sdk/para

[![LICENSE](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/0xMiden/web-sdk/blob/main/LICENSE.md)

The Miden x Para integration: build a Miden account from a Para-managed EVM
wallet and sign Miden transactions through Para.

For the React bindings see [`@miden-sdk/para-react`](https://www.npmjs.com/package/@miden-sdk/para-react),
which is where `ParaSignerProvider` and the hooks live. To scaffold a fresh Vite
`react-ts` app with the Miden and Para config already wired, use
[`@miden-sdk/create-para-react`](https://www.npmjs.com/package/@miden-sdk/create-para-react).

## Agent guidance

If you are an AI coding agent, read
`node_modules/@miden-sdk/para/AGENTS.md` and
`node_modules/@miden-sdk/para/skills/para-signer/SKILL.md` before writing code
against this package. They ship in this tarball, so they match the version you
have installed.

## Requirements

- Node.js >= 20.
- A Para API key. **Production deployments require a Para production API key**;
  use a non-production key for local and development work.

## Installation

```bash
pnpm add @miden-sdk/para @miden-sdk/miden-sdk @getpara/web-sdk
```

## Peer dependencies

`@miden-sdk/para` expects these to be provided by the consuming app. Install
matching versions alongside it so no duplicate copy of the SDK is resolved:

- `@miden-sdk/miden-sdk@^0.16.1`
- `@getpara/web-sdk@^3.18.0`

Para SDK 3.18 is required as of 0.16.1; the 2.x range no longer satisfies the
peer.

When creating a client with `storageMode` set to `private`, supply an
`accountSeed`. The initializer throws if it is missing, so that private accounts
stay recoverable.

## Contributing

This package is developed in the [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk)
monorepo under `packages/para/core`, and is released from it. See that repo's
`CONTRIBUTING.md` and `AGENTS.md` for the build, test and release flow.
