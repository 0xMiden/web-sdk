# @miden-sdk/telemetry-sentry

Opt-in Sentry binding for Miden SDK observations.

`@miden-sdk/miden-sdk` emits one observation per client operation — name,
outcome, duration — and never transports one. It has no telemetry dependency
and no egress primitive in that path. This package is the adapter that turns
those observations into Sentry calls, so you can wire the SDK into a Sentry
project you already own without the core gaining anything.

## Installation

```bash
pnpm add @miden-sdk/telemetry-sentry
```

Sentry itself is **not** a dependency of this package, not even a peer. The
binding is defined against the `captureMessage` shape rather than a Sentry
import, so you own your Sentry version, its configuration, and its lifecycle.
Nothing here calls `Sentry.init`, constructs a client, or knows a DSN.

## Usage

```ts
import * as Sentry from "@sentry/browser";
import { MidenClient } from "@miden-sdk/miden-sdk";
import { createSentryObserver } from "@miden-sdk/telemetry-sentry";

Sentry.init({ dsn: "..." }); // yours to call, once, in your entry point

const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: createSentryObserver({ client: Sentry, minDurationMs: 5_000 }),
});
```

Pass anything with a `captureMessage(message, { level, tags, extra })` method:
the module namespace of any Sentry SDK, a `Scope`, a queue of your own, or a
test double.

## Options

### `client`

- **Type:** `SentryLikeClient` — an object with a `captureMessage` method
- **Required.** `createSentryObserver` throws a `TypeError` at wiring time if
  it is missing or cannot capture a message. That is the one thing this
  package reports by throwing, and it throws from the factory rather than the
  observer: an observer cannot report its own misconfiguration, so one built
  around a missing client would discard every observation forever and look
  exactly like a working one.

### `minDurationMs`

- **Type:** `number`
- **Default:** `Infinity` — failures only

Successful operations are forwarded only when they took at least this long.
Failures are always forwarded, however fast they were. The default is
deliberately conservative: the SDK's successful call volume is not something
to bill a Sentry quota for because an option was left out.

### `includeSensitive`

- **Type:** `boolean`
- **Default:** `false`

See below. Only a literal `true` enables it.

## Reported shape

One `captureMessage` per forwarded observation, synchronously, with nothing
scheduled afterwards:

| | |
|---|---|
| message | `miden.<op> <outcome>`, e.g. `miden.proveTransaction error` |
| `level` | `"error"` on failure, `"info"` on success |
| `tags.op` | the operation name |
| `tags.outcome` | `"ok"` or `"error"` |
| `extra.durationMs` | wall time the caller waited |

## Sensitive detail

An observation's `sensitive` channel carries verbatim error text, and account
identifiers where the SDK supplies them. It is opt-in at **both** ends:
`observeSensitive: true` when you construct the client, and
`includeSensitive: true` here. Either one left alone and nothing from that
channel reaches Sentry.

By default the SDK omits the `sensitive` key from an observation entirely, and
this binding forwards nothing in its place — no placeholder, no inferred
value, no empty rows in the Sentry UI. An observation without the key is still
reported; only its detail is absent.

Do not enable either flag in an application with confidentiality obligations
to its users. A wallet, for example, must never enable it.

## Failure behaviour

The observer never throws. A Sentry client that is down, misconfigured, or
throwing takes the report with it and nothing else — the client operation
being reported on still succeeds, and the next observation is still reported.
The SDK guards observer invocation too, but this binding is usable outside
that guard, so it does not rely on it.

## License

MIT
