/**
 * Terminal worker-failure latch for WebClient.
 *
 * A Worker `error` / `messageerror` event does not reject in-flight
 * `pendingRequests` on its own, and `ready` may already have resolved.
 * Latch a failure on the client so later `callMethodWithWorker` calls
 * fail fast instead of posting to a dead worker and hanging forever.
 */

export function errorFromWorkerEvent(event) {
  const message =
    typeof event?.message === "string" && event.message.length > 0
      ? event.message
      : null;
  if (event?.type === "messageerror") {
    return new Error(message ?? "Web worker message could not be deserialized");
  }
  return new Error(message ?? "Web worker failed to load or crashed");
}

/**
 * Record a terminal worker failure, flush in-flight requests, and reject
 * `ready` if it has not already settled.
 *
 * @param {object} client
 * @param {Error} error
 * @param {{ preventDefault?: () => void }} [event]
 * @returns {Error}
 */
export function latchWorkerFailure(client, error, event) {
  if (client.workerFailure) {
    return client.workerFailure;
  }
  const err = error instanceof Error ? error : new Error(String(error));
  client.workerFailure = err;
  event?.preventDefault?.();
  const pending = client.pendingRequests;
  if (pending) {
    for (const { reject } of pending.values()) {
      reject(err);
    }
    pending.clear();
  }
  client.readyRejecter?.(err);
  return err;
}
