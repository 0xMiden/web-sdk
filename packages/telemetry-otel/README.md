# @miden-sdk/telemetry-otel

Opt-in OpenTelemetry binding for Miden SDK observations.

`@miden-sdk/miden-sdk` emits one observation per client operation — name,
outcome, duration — and never transports one. It has no telemetry dependency
and no egress primitive in that path. This package is the adapter that turns
those observations into spans on a tracer you already own, without the core
gaining anything.

## Installation

```bash
pnpm add @miden-sdk/telemetry-otel
```

OpenTelemetry itself is **not** a dependency of this package, not even a peer.
The binding is defined against the `startSpan` shape rather than an
`@opentelemetry/api` import, so you own your OTel version, your provider, and
your exporters. That matters more here than for most vendors: a second
`@opentelemetry/api` resolved in one tree carries its own global provider
registration, and spans start disappearing into whichever copy lost.

## Usage

```ts
import { trace } from "@opentelemetry/api";
import { MidenClient } from "@miden-sdk/miden-sdk";
import { createOtelObserver } from "@miden-sdk/telemetry-otel";

const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: createOtelObserver({ tracer: trace.getTracer("my-app") }),
});
```

Pass anything with a `startSpan(name, { startTime })` method that returns an
object with `setAttribute`, `setStatus`, and `end`: a real tracer, a wrapper of
your own, or a test double. Getting the tracer — and registering the provider
that backs it — stays your call, in your entry point.

## Options

### `tracer`

- **Type:** `TracerLike` — an object with a `startSpan` method
- **Required.** `createOtelObserver` throws a `TypeError` at wiring time if it
  is missing or cannot start a span. That is the one thing this package reports
  by throwing, and it throws from the factory rather than the observer: an
  observer cannot report its own misconfiguration, so one built around a
  missing tracer would discard every observation forever and look exactly like
  a working one.

### `includeSensitive`

- **Type:** `boolean`
- **Default:** `false`

See below. Only a literal `true` enables it.

## Recorded shape

One span per observation, recorded synchronously, with nothing scheduled
afterwards:

| | |
|---|---|
| span name | `miden.<op>`, e.g. `miden.proveTransaction` |
| `miden.duration_ms` | wall time the caller waited |
| `miden.outcome` | `"ok"` or `"error"` |
| status | `ERROR` (code `2`) on failure; left `UNSET` on success |

## Retroactive spans

The SDK reports an operation once it has **finished**, so there is never a live
span to wrap around the work. The span is reconstructed instead: it ends at the
instant the observation arrived and is backdated by the reported duration, so
it occupies the interval the operation really ran in. Both timestamps are
passed explicitly, which keeps the span's own interval and its
`miden.duration_ms` attribute in agreement — an implicit end time would drift
by however long recording the attributes took.

One consequence worth knowing when you read a trace: these spans have no
parent and are not nested inside whatever your application was doing at the
time. They are a record of a completed operation, not a live instrumentation
of one.

A duration that is not a finite, non-negative number cannot describe an
interval. Rather than hand the tracer a garbage timestamp, the operation is
recorded as an instant at the moment it was reported, with no
`miden.duration_ms` attribute at all.

## Sensitive detail

An observation's `sensitive` channel carries verbatim error text, and the
account identifier where the SDK supplies one. It is opt-in at **both** ends:
`observeSensitive: true` when you construct the client, and
`includeSensitive: true` here. Either one left alone and nothing from that
channel reaches your tracer.

When enabled, three attributes may be added, each only if the SDK populated the
field:

| | |
|---|---|
| `miden.error_message` | verbatim error message |
| `miden.error_stack` | verbatim error stack |
| `miden.account_id` | account the operation acted on |

`miden.account_id` will not appear in practice yet: the SDK declares
`sensitive.accountId` on the type but does not currently populate it, so the
guard for that attribute never fires. It is read defensively here so the
attribute starts appearing on its own if a later SDK version fills the field
in — do not build a dashboard that assumes it is there today.

By default the SDK omits the `sensitive` key from an observation entirely, and
this binding records nothing in its place — no placeholder, no inferred value,
and no empty-valued attributes for a UI to render as blank rows. An observation
without the key is still recorded; only its detail is absent. The three fields
are read by name rather than enumerated, so a field a later SDK version adds to
the channel cannot start flowing to your backend before you have decided it
should.

Do not enable either flag in an application with confidentiality obligations to
its users. A wallet, for example, must never enable it.

## Failure behaviour

The observer never throws. A tracer that is unconfigured, detached, or throwing
takes its own span with it and nothing else — the client operation being
recorded still succeeds, and the next observation is still recorded. The SDK
guards observer invocation too, but this binding is usable outside that guard,
so it does not rely on it.

## License

MIT
