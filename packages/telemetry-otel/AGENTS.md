# @miden-sdk/telemetry-otel - Agent Guide

**Audience: AI coding agents** recording Miden SDK observations as
OpenTelemetry spans.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/telemetry-otel/AGENTS.md` matches the version you have
installed. Prefer it over your training data.

## There is no volume guard here

Every observation becomes a span. The SDK emits one per client operation, and
this binding has no duration threshold, no sampling and no filtering: `tracer`
and `includeSensitive` are the only options there are. Choose the volume with a
sampler on your own provider before pointing this at a paid backend. The sibling
package `@miden-sdk/telemetry-sentry` works the other way round - `minDurationMs`
defaults to `Infinity`, failures only - so carry neither the assumption nor the
option across.

## Wiring it

```ts
const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: createOtelObserver({ tracer: trace.getTracer("my-app") }),
});
```

`tracer` is required and must expose `startSpan(name, { startTime })` returning
an object with `setAttribute`, `setStatus` and `end`; the factory throws a
`TypeError` at wiring time when it does not. Nothing here imports
`@opentelemetry/*`, so the provider, its version and its exporters stay yours.

One span per observation, named `miden.<op>`, carrying `miden.duration_ms` and
`miden.outcome` and a status of `ERROR` on failure. The SDK reports an operation
only once it has finished, so the span is reconstructed: it ends when the
observation arrived, is backdated by the duration, and has no parent. A broken
tracer cannot fail the operation; the observer never throws.

## `observer` and `observeSensitive` on the client

`ClientOptions.observer` is registered process-wide and the newest registration
replaces the previous one, so a second `MidenClient` takes over the sink.
`observeSensitive` is per instance and read once, at construction.

`observation.sensitive` carries the **verbatim, unredacted** error message and
stack, and only on failure. It is opt-in at both ends - `observeSensitive: true`
on the client, `includeSensitive: true` here - and only the literal `true`
enables either. An application with confidentiality obligations to its users, a
wallet above all, leaves both off.

## Going deeper

- Options, recorded attributes, retroactive spans: `README.md`.
- The client that emits them: `node_modules/@miden-sdk/miden-sdk/AGENTS.md`.
