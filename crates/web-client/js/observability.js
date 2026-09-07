/**
 * Vendor-neutral observability sink.
 *
 * The SDK emits one observation per client operation. It never transports
 * anything: there is deliberately no egress primitive in this module — not
 * even imported — so a consumer can prove by inspection that the SDK cannot
 * phone home. Vendor bindings live in separate opt-in packages.
 *
 * Emission must never affect an operation: a throwing observer is swallowed,
 * and observers are invoked synchronously so an operation's timing and
 * async-ness are unchanged.
 */

let currentObserver = null;

/**
 * Register the observation sink. Replaces any existing observer.
 *
 * @param {((observation: object) => void) | null} observer
 * @returns {() => void} unsubscribe
 */
export function setObserver(observer) {
  currentObserver = typeof observer === "function" ? observer : null;
  const registered = currentObserver;
  return () => {
    // Guarded so a stale unsubscribe cannot silence a later registration.
    if (currentObserver === registered) {
      currentObserver = null;
    }
  };
}

/** @returns {boolean} whether anyone is listening. */
export function hasObserver() {
  return currentObserver !== null;
}

/**
 * Deliver one observation. `sensitive` is omitted from the delivered object
 * unless explicitly supplied, so `"sensitive" in observation` is a truthful
 * test of whether the high-fidelity channel is active.
 *
 * @param {{op: string, outcome: "ok" | "error", durationMs: number, sensitive?: object}} fields
 */
export function emitObservation({ op, outcome, durationMs, sensitive }) {
  if (currentObserver === null) return;
  const observation = { op, outcome, durationMs };
  if (sensitive !== undefined) {
    observation.sensitive = sensitive;
  }
  try {
    currentObserver(observation);
  } catch {
    // An observer must never be able to fail a client operation.
  }
}

/** Test-only: drop the registered observer. */
export function __resetObserverForTest() {
  currentObserver = null;
}
