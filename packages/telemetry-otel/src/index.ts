/**
 * Opt-in OpenTelemetry binding for Miden SDK observations.
 *
 * `@miden-sdk/miden-sdk` emits an observation per client operation and never
 * transports one — it has no telemetry dependency and no egress primitive in
 * that path. This package is the adapter that turns those observations into
 * spans on a tracer the consumer already owns, without the core gaining
 * anything.
 *
 * Two properties hold deliberately and are enforced by tests:
 *
 * - OpenTelemetry is a peer concern. Nothing here imports `@opentelemetry/*`;
 *   the binding is defined against the `startSpan` shape, so the consumer owns
 *   their OTel version, their provider, and their exporters.
 * - The binding has no transport of its own. It hands data to the tracer it
 *   was given and stops there.
 */

import type {
  MidenObservation,
  MidenObservationSensitive,
} from "@miden-sdk/miden-sdk";

/** The slice of an OpenTelemetry span this binding uses. */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: number }): unknown;
  /** Epoch-millisecond end time. Always passed; never left to the tracer. */
  end(endTime?: number): unknown;
}

/** The slice of an OpenTelemetry tracer this binding uses. */
export interface TracerLike {
  startSpan(name: string, options: { startTime: number }): SpanLike;
}

export interface OtelObserverOptions {
  /** An already-configured tracer. This package never builds a provider. */
  tracer: TracerLike;
  /**
   * Forward `observation.sensitive` (verbatim error text, and the account
   * identifier where the SDK supplies one) when it is present. Defaults to
   * `false`, and only a literal `true` enables it: the field is dropped even
   * when present, so turning on `observeSensitive` at the client does not by
   * itself disclose anything through this binding.
   */
  includeSensitive?: boolean;
}

/** OpenTelemetry `SpanStatusCode.ERROR`, inlined to avoid the dependency. */
const SPAN_STATUS_ERROR = 2;

/**
 * The observation's duration, or `null` when it does not describe an interval.
 *
 * A non-finite or negative duration cannot be turned into a span that means
 * anything, and `endTime - NaN` would hand the tracer a garbage timestamp.
 */
function measuredDuration(durationMs: number): number | null {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

/**
 * Record the sensitive channel's fields onto the span.
 *
 * The channel is opt-in at both ends, so the key is normally absent: the SDK
 * omits it rather than setting it to `undefined`. Reading it therefore yields
 * `undefined`, which the shape test below rejects — recording the fields
 * unconditionally instead would put an `undefined`-valued attribute on every
 * observation the SDK emits by default, which a tracer keeps and a vendor UI
 * renders as an empty row.
 *
 * The three fields are read by name rather than enumerated, so a field a
 * later SDK version adds to the channel cannot start flowing to a vendor
 * before anyone has decided that it should. Each is optional in
 * `MidenObservationSensitive` and the SDK populates only some — `accountId`
 * is declared but not populated today — so an unset field is dropped rather
 * than recorded as an empty attribute.
 */
function recordSensitive(span: SpanLike, observation: MidenObservation) {
  const sensitive: unknown = observation.sensitive;
  if (sensitive === null || typeof sensitive !== "object") return;

  const { errorMessage, errorStack, accountId } =
    sensitive as MidenObservationSensitive;
  if (errorMessage) span.setAttribute("miden.error_message", errorMessage);
  if (errorStack) span.setAttribute("miden.error_stack", errorStack);
  if (accountId) span.setAttribute("miden.account_id", accountId);
}

/**
 * Build an observer for `ClientOptions.observer` that records Miden SDK
 * operations as OpenTelemetry spans.
 *
 * The span is reconstructed rather than held open. The SDK reports an
 * operation once it has finished, so there is no live span to wrap around the
 * work: the span ends at the instant the observation arrived and starts one
 * duration earlier, which is the interval the operation really occupied. Both
 * timestamps are passed explicitly — an implicit end time would drift by
 * however long recording the attributes took, and report a duration that
 * disagreed with the `miden.duration_ms` attribute on the same span.
 *
 * The returned observer never throws: a recording failure must not be able to
 * fail the client operation being recorded. The SDK guards observer
 * invocation as well, but this adapter is usable outside that guard so it
 * does not rely on it.
 *
 * Misconfiguration is the one thing reported by throwing, and it is thrown
 * from here rather than from the observer — at wiring time, where a stack
 * trace points at the call that is wrong. An observer that quietly discarded
 * every observation would be indistinguishable from a working one.
 *
 * @throws {TypeError} if `options.tracer` cannot start a span.
 */
export function createOtelObserver(
  options: OtelObserverOptions
): (observation: MidenObservation) => void {
  const tracer: TracerLike | undefined = options?.tracer;
  if (typeof tracer?.startSpan !== "function") {
    throw new TypeError(
      "createOtelObserver: options.tracer must expose a " +
        "startSpan(name, options) method."
    );
  }

  const includeSensitive = options.includeSensitive === true;

  return (observation) => {
    try {
      const name = `miden.${observation.op}`;
      const endTime = Date.now();
      const durationMs = measuredDuration(observation.durationMs);
      const span = tracer.startSpan(name, {
        startTime: endTime - (durationMs ?? 0),
      });

      if (durationMs !== null) {
        span.setAttribute("miden.duration_ms", durationMs);
      }
      span.setAttribute("miden.outcome", observation.outcome);
      if (observation.outcome === "error") {
        span.setStatus({ code: SPAN_STATUS_ERROR });
      }
      if (includeSensitive) {
        recordSensitive(span, observation);
      }
      span.end(endTime);
    } catch {
      // A telemetry binding must never fail a client operation.
    }
  };
}
