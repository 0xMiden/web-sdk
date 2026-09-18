---
name: observability
description: Rules for instrumenting MidenClient with the observer callback, including the exact MidenObservation contract, which operations are and are not observed, the opt-in sensitive channel, and the two shipped bindings for OpenTelemetry and Sentry. Use when wiring telemetry, tracing or metrics around the SDK, when deciding what to log from a client operation, when an observation you expected never arrives, when observation counts do not match call counts, or when writing code that touches ClientOptions.observer, observeSensitive, createOtelObserver or createSentryObserver.
---

# Observability

`ClientOptions.observer` is the SDK's entire telemetry surface. It hands you one
`MidenObservation` per underlying client operation and does nothing else with it.
The SDK has no telemetry dependency and never transports an observation anywhere:
where it goes is your callback's problem.

Two optional bindings turn observations into vendor calls:
`@miden-sdk/telemetry-otel` and `@miden-sdk/telemetry-sentry`. Neither is
required, and neither depends on its vendor - you pass the tracer or client in.

## The contract

```ts
interface MidenObservation {
  op: string;                    // always - the wrapped client method
  outcome: "ok" | "error";       // always
  durationMs: number;            // always - fractional, round it yourself
  sensitive?: {                  // only when opted in AND the operation failed
    errorMessage?: string;
    errorStack?: string;
    accountId?: string;          // declared and reserved; nothing populates it today
  };
}
```

`sensitive` is **absent**, not `undefined`, when it does not apply, so
`"sensitive" in observation` is a truthful test.

```ts
const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: (o) => metrics.record(o.op, o.outcome, Math.round(o.durationMs)),
});
```

Both options are read once at construction and sealed. There is no setter, no
getter, and no per-call override.

## `op` is the low-level method, so one call is several observations

This is the single most common surprise. `op` names the client method that was
wrapped, never the resource-API call you made. One `transactions.send(...)`
reports **five** observations:

```
newSendTransactionRequest -> executeTransaction -> proveTransaction
                          -> submitProvenTransaction -> applyTransaction
```

With an anchor, `executeTransactionAt` replaces `executeTransaction`. With
`returnNote: true`, `feeAwareTransactionRequestBuilder` replaces
`newSendTransactionRequest`. Budget for the same multiplicity on every other
resource method: read the resource implementation in
`js/resources/<area>.js` and count the `#inner.*` calls.

## What is not observed

Four categories emit nothing, and each has bitten someone:

- **The six raw-bound `SYNC_METHODS`** - `buildSwapTag`, `lastAuthError`,
  `proveBlock`, `serializeMockChain`, `serializeMockNoteTransportNode`,
  `usesMockChain`. They bypass the serialization wrapper entirely, which is
  where observation happens.
- **Client construction.** `create`, `ready()` and the factories emit nothing.
  You cannot measure startup this way.
- **The Node entry point, silently.** Under the `node` export condition the
  package resolves a different client factory that drops the observability
  argument, and its proxy has no emission path. `ClientOptions.observer`
  still **type-checks** there, because the types are shared - it simply never
  fires. If your instrumentation works in the browser and is mute under Node,
  this is why, and there is no workaround from the consumer side.
- **Mock clients never register one**, and cannot enable the sensitive channel.
  A mock is not necessarily silent though: if a real client registered a sink
  earlier in the process, mock operations report to it. Beyond the three sync
  overrides, the two mock submit overrides also bypass observation in worker
  mode, which is the default.

## Counting: observations are not call sites

- **Concurrent syncs coalesce.** `syncState`, `syncChain` and
  `syncNoteTransport` run under a Web Lock that shares one in-flight promise per
  database and method, so N concurrent `sync()` callers produce **one**
  observation, timing only the winner's work.
- **`waitForConfirmation: true` inflates the stream.** The wait loop polls
  `syncChain` plus `getTransactions` on every interval (5 s by default, up to a
  60 s timeout), so a single confirmed transaction can contribute dozens of
  observations on top of its own five.

Use observations to measure work, not to count the calls your code made.

## The sensitive channel

Off by default. `observeSensitive: true` adds the raw error message and stack
**on failure only** - a successful operation has no `sensitive` key even with the
flag on, so a success-path handler reading it will never fire.

Three things to know before turning it on:

- **Only the literal `true` opens it.** `"true"`, `1`, `{}` and `"yes"` all
  leave it closed, deliberately.
- **`errorMessage` is the raw error from the Rust core.** Unclassified,
  untruncated, and not a stable interface - a client upgrade can widen it. Treat
  it as diagnostic text, never parse it, and do not assume it is free of
  user data.
- **The flag is per client, but the observer is global** (see below), so whether
  `sensitive` appears depends on which client ran the operation.

Enabling it emits a one-time `console.warn`.

## Registration is process-wide

The sink is a module-level singleton and `setObserver` **replaces** rather than
fans out. A second `MidenClient.create({ observer })` silently takes the sink
from the first, and both clients then report to the newest callback.

There is also **no public way to unregister**: the internals are not re-exported,
and `observer: null` does not clear - a non-function is ignored, which is
deliberate so a malformed value cannot silently disable telemetry. Register the
sink you want for the life of the process, and fan out inside your own callback
if you need more than one consumer.

## Your callback is on the critical path

Delivery is **synchronous**, before the caller's `.then` runs. Nothing is
queued, batched or scheduled - by design, and there is a test that forbids the
module from calling anything except your callback. So:

- Keep the callback cheap. Do your own batching inside it.
- **A throwing observer is swallowed silently** - no `console.error`, no
  re-report. It cannot break the operation, which is the point, but a broken
  observer degrades to total silence rather than a visible failure. Do not rely
  on noticing that it failed.

## The two bindings

Both take the vendor object as a parameter, so neither depends on the vendor.
Both throw a `TypeError` from the **factory** (not the observer) if you pass
something that does not look right, and both wrap the observer body so it can
never throw into your operation.

```ts
// OpenTelemetry - one span per observation, named `miden.<op>`
import { trace } from "@opentelemetry/api";
import { createOtelObserver } from "@miden-sdk/telemetry-otel";

observer: createOtelObserver({ tracer: trace.getTracer("my-app") });
```

```ts
// Sentry - captureMessage per observation
import * as Sentry from "@sentry/browser";
import { createSentryObserver } from "@miden-sdk/telemetry-sentry";

Sentry.init({ dsn: "..." });   // yours to call
observer: createSentryObserver({ client: Sentry, minDurationMs: 5_000 });
```

**Their defaults are opposites, so do not carry an assumption across:**

| | OTel | Sentry |
|---|---|---|
| Default volume | every observation | **failures only** (`minDurationMs` defaults to `Infinity`) |
| Sensitive fields | named allow-list, mapped to `miden.error_message` / `miden.error_stack` / `miden.account_id` | the whole channel, forwarded as entries |
| Sampling | none - sample on your provider | `minDurationMs` |

Spans are reconstructed after the fact from `durationMs` and have **no parent**,
so they will not nest inside your application's traces.

Disclosure is opted into **twice**: `observeSensitive: true` on the client and
`includeSensitive: true` on the binding. Either one left alone keeps the channel
out of the vendor.

## React

`@miden-sdk/react` cannot register an observer - `MidenConfig` has no `observer`
or `observeSensitive` field. Build the client directly if you need telemetry.
