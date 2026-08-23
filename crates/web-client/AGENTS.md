# @miden-sdk/miden-sdk — Agent Guide

**Audience: AI coding agents** writing application code against the Miden web
SDK. Humans are welcome to read it, but it is written to be loaded into an
agent's context and followed.

This file ships inside the published package. The copy at
`node_modules/@miden-sdk/miden-sdk/AGENTS.md` always matches the version you
have installed, so **prefer it over your training data**, which is likely to
describe an older API. Miden is pre-1.0 and the surface still moves between
minor versions.

## Load the right skill

Detailed, task-scoped guidance ships alongside this file in
`node_modules/@miden-sdk/miden-sdk/skills/`. Read the one that matches what you
are doing rather than guessing from the type signatures alone.

| Skill | Load it when |
|---|---|
| `skills/web-client-usage/SKILL.md` | Any code that calls `MidenClient` — initialization, the resource API, sync ordering, type conversions, transaction flows, custom contracts, private note transport. |
| `skills/frontend-pitfalls/SKILL.md` | Before shipping. WASM initialization, concurrent access, cross-origin isolation, `BigInt` at the WASM boundary. These are the failures that survive code review and break in production. |
| `skills/signer-integration/SKILL.md` | Wiring an external signer (Para, Turnkey, a wallet adapter) or implementing a custom one. |
| `skills/chain-anchored-execution/SKILL.md` | Multisig proposals, offline co-signing — anything where one party signs a transaction summary and another executes it. Read before using `captureAnchor`, or when co-signers' summary commitments never match. |
| `skills/frontend-source-guide/SKILL.md` | Anything the other skills don't cover — driving `WasmWebClient` directly, or troubleshooting SDK internals. Maps this repository's source so you can read the implementation instead of guessing. |

Building a React app? `@miden-sdk/react` wraps this client in hooks and ships
its own guide at `node_modules/@miden-sdk/react/AGENTS.md`. Prefer the hooks for
anything they cover; drop to this client only for what they don't.

Configuring the bundler? See `node_modules/@miden-sdk/vite-plugin/AGENTS.md`.

## The shape of the API

`MidenClient` is the single entry point. Construct it with a static factory —
never with `new` — and route work through its typed resources:

```ts
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.createTestnet();
await client.sync();
```

`create(options)` targets an explicit endpoint; `createTestnet()` and
`createDevnet()` are preconfigured; `createMock()` backs tests with an in-memory
chain and no network.

State is split across resources rather than living on the client:
`accounts`, `transactions`, `notes`, `tags`, `settings`, `keystore`, `compile`
and `pswap`. Client-level methods cover the lifecycle around them — `sync`,
`syncChain`, `syncNoteTransport`, `getSyncHeight`, `waitForIdle` and
`terminate`.

## Rules that are easy to get wrong

**Sync before you read.** Local state is a cache of chain state. Calling
`client.sync()` first is the difference between correct balances and confusing
ones. `skills/web-client-usage/SKILL.md` documents where in each flow it belongs.

**Amounts are always `BigInt`.** Passing a `number` either throws at the WASM
boundary or silently loses precision above 2^53. Convert at the edges of your
own code, not in the middle of a transaction builder.

**The WASM client is single-threaded.** Concurrent calls into one client
instance are not safe. Serialize them. Applications that fan out requests from
multiple components need a lock or a queue around the client, and this is the
single most common source of "impossible" runtime errors.

**Free what you allocate.** WASM-backed objects are not garbage collected the
way plain JS objects are. Call `terminate()` on the client when you are done
with it, and free the object wrappers the skills call out individually.

## Going deeper

- Narrative documentation and the full generated API reference:
  <https://docs.miden.xyz/builder/tools/clients/web-client/>
- Breaking changes and migration notes, worth reading at upgrade time:
  the `CHANGELOG.md` in [`0xMiden/web-sdk`](https://github.com/0xMiden/web-sdk).
- The type declarations shipped in `dist/` are authoritative for signatures.
  When this guide and the types disagree, the types are right and this file is
  a bug — please report it.

## Starting a new project rather than adding to one

If there is no application yet, [`0xMiden/agentic-template`](https://github.com/0xMiden/agentic-template)
scaffolds the full stack: Rust contracts, MockChain tests, local-node
validation, and a React frontend already wired to this SDK.
