/**
 * Opt-in Sentry binding for Miden SDK observations.
 *
 * `@miden-sdk/miden-sdk` emits an observation per client operation and never
 * transports one — it has no telemetry dependency and no egress primitive in
 * that path. This package is the adapter that turns those observations into
 * Sentry calls, so a consumer can wire the SDK into a Sentry project they
 * already own without the core gaining anything.
 *
 * Two properties hold deliberately and are enforced by tests:
 *
 * - Sentry is a peer concern. Nothing here imports `@sentry/*`; the binding is
 *   defined against the `captureMessage` shape, so the consumer owns their
 *   client, its version, and its lifecycle. `Sentry.init` is theirs to call.
 * - The binding has no transport of its own. It hands data to the client it
 *   was given and stops there.
 */

import type { MidenObservation } from "@miden-sdk/miden-sdk";

/** Severity Sentry files the message under. */
export type SentryLevel = "error" | "info";

/** The context object this binding passes to `captureMessage`. */
export interface SentryMessageContext {
  level: SentryLevel;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
}

/**
 * The slice of a Sentry client this binding uses.
 *
 * Satisfied by the module namespace of any Sentry SDK
 * (`import * as Sentry from "@sentry/browser"`), and by anything else with a
 * matching `captureMessage` — a queue, a test double, your own reporter.
 */
export interface SentryLikeClient {
  captureMessage(message: string, context: SentryMessageContext): unknown;
}

export interface SentryObserverOptions {
  /** An already-initialised Sentry client. This package never initialises one. */
  client: SentryLikeClient;
  /**
   * Forward successful operations only when they took at least this long.
   * Failures are always forwarded. Defaults to `Infinity` — failures only,
   * because the SDK's successful call volume is not something to bill a
   * Sentry quota for by accident.
   */
  minDurationMs?: number;
  /**
   * Forward `observation.sensitive` (verbatim error text, and account
   * identifiers where the SDK supplies them) when it is present. Defaults to
   * `false`, and only a literal `true` enables it: the field is dropped even
   * when present, so turning on `observeSensitive` at the client does not by
   * itself disclose anything through this binding.
   */
  includeSensitive?: boolean;
}

/**
 * Entries to merge into `extra` from the observation's sensitive channel.
 *
 * The channel is opt-in at both ends, so the key is normally ABSENT rather
 * than present-and-undefined — hence the `in` test. Reading the field
 * unconditionally would put `undefined` values into the payload for every
 * observation the SDK emits by default, and the same goes for the individual
 * fields: `MidenObservationSensitive` declares each one optional and the SDK
 * populates only some, so an unset field is dropped rather than forwarded as
 * an empty row in the Sentry UI.
 */
function sensitiveEntries(
  observation: MidenObservation,
  includeSensitive: boolean
): Array<[string, unknown]> {
  if (!includeSensitive) return [];
  if (!("sensitive" in observation)) return [];
  const sensitive: unknown = observation.sensitive;
  if (sensitive === null || typeof sensitive !== "object") return [];
  return Object.entries(sensitive).filter(([, value]) => value !== undefined);
}

/**
 * Build an observer for `ClientOptions.observer` that reports Miden SDK
 * operations to a Sentry client.
 *
 * The returned observer never throws: a reporting failure must not be able to
 * fail the client operation being reported on. The SDK guards observer
 * invocation as well, but this adapter is usable outside that guard so it
 * does not rely on it.
 *
 * Misconfiguration is the one thing reported by throwing, and it is thrown
 * from here rather than from the observer — at wiring time, where a stack
 * trace points at the call that is wrong. An observer that quietly discarded
 * every observation would be indistinguishable from a working one.
 *
 * @throws {TypeError} if `options.client` cannot capture a message.
 */
export function createSentryObserver(
  options: SentryObserverOptions
): (observation: MidenObservation) => void {
  const client: SentryLikeClient | undefined = options?.client;
  if (typeof client?.captureMessage !== "function") {
    throw new TypeError(
      "createSentryObserver: options.client must expose a " +
        "captureMessage(message, context) method."
    );
  }

  const minDurationMs = options.minDurationMs ?? Number.POSITIVE_INFINITY;
  const includeSensitive = options.includeSensitive === true;

  return (observation) => {
    try {
      const failed = observation.outcome === "error";
      // Written as `>=` rather than a negated `<` so a duration that is not
      // a number drops out instead of comparing false and sailing through.
      if (!failed && !(observation.durationMs >= minDurationMs)) return;

      client.captureMessage(`miden.${observation.op} ${observation.outcome}`, {
        level: failed ? "error" : "info",
        tags: { op: observation.op, outcome: observation.outcome },
        // `fromEntries` defines own properties rather than assigning them, so
        // a `__proto__` key in the sensitive channel lands as data instead of
        // reaching the payload's prototype. `durationMs` goes last: the
        // measured duration outranks anything of the same name.
        extra: Object.fromEntries([
          ...sensitiveEntries(observation, includeSensitive),
          ["durationMs", observation.durationMs],
        ]),
      });
    } catch {
      // A telemetry binding must never fail a client operation.
    }
  };
}
