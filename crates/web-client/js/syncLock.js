/**
 * Sync Lock Module
 *
 * Coordinates concurrent sync calls using the Web Locks API.
 *
 * Behavior:
 * - Same-method coalescing: if a sync of the same method is in progress,
 *   subsequent callers share its result promise
 * - Different-method serialization: different methods (e.g. syncState vs
 *   syncNoteTransport) wait for each other via the Web Lock, or via an
 *   in-process per-dbId promise chain when Web Locks are unavailable
 * - Web Locks also serialize across tabs (Chrome 69+, Safari 15.4+)
 */

/**
 * Check if the Web Locks API is available.
 */
export function hasWebLocks() {
  return (
    typeof navigator !== "undefined" &&
    navigator.locks !== undefined &&
    typeof navigator.locks.request === "function"
  );
}

// A transport or callback that never settles must not keep the module-level
// coalescing slot (and, in browsers, the Web Lock) alive forever.
export const SYNC_LOCK_TIMEOUT_MS = 60_000;

// Coalesce map keyed by `${dbId}:${methodId}` -> in-flight promise.
const inFlight = new Map();

// Per-dbId promise tail used to serialize cross-method calls when Web Locks
// are unavailable. Each new task chains onto the current tail so different
// methods on the same dbId run sequentially within the tab.
const fallbackTails = new Map();

/**
 * Build the coalesce-map key for an in-flight sync of `(dbId, methodId)`.
 *
 * @param {string} dbId
 * @param {string} methodId
 * @returns {string}
 */
function coalesceKey(dbId, methodId) {
  return `${dbId}:${methodId}`;
}

function syncLockTimeoutError() {
  return new Error(`Sync lock timed out after ${SYNC_LOCK_TIMEOUT_MS}ms`);
}

/**
 * Run `fn` within the remaining sync-lock deadline.
 *
 * @param {() => Promise<T>} fn
 * @param {number} deadline
 * @returns {Promise<T>}
 * @template T
 */
function runWithDeadline(fn, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(syncLockTimeoutError());

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(syncLockTimeoutError()), remaining);
  });

  return Promise.race([Promise.resolve().then(fn), timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Run `fn` while holding the per-db Web Lock. When Web Locks are unavailable,
 * serializes `fn` against any other in-flight call on the same `dbId` via an
 * in-process promise chain — the wasm-bindgen `WebClient` uses a synchronous
 * `RefCell` for interior mutability in the browser, so overlapping
 * cross-method borrows would throw "recursive use of an object detected
 * which would lead to unsafe aliasing in rust".
 *
 * @param {string} dbId
 * @param {() => Promise<T>} fn
 * @param {number} deadline
 * @returns {Promise<T>}
 * @template T
 */
function runUnderLock(dbId, fn, deadline) {
  if (!hasWebLocks()) {
    const prev = fallbackTails.get(dbId) ?? Promise.resolve();
    const queued = prev
      .catch(() => {})
      .then(() => {
        if (Date.now() >= deadline) throw syncLockTimeoutError();
        return fn();
      });
    const next = runWithDeadline(() => queued, deadline);
    const guarded = next.catch(() => {});
    fallbackTails.set(dbId, guarded);
    guarded.then(() => {
      // Drop the slot only if no successor chained onto this tail.
      if (fallbackTails.get(dbId) === guarded) fallbackTails.delete(dbId);
    });
    return next;
  }

  const controller = new AbortController();
  const request = navigator.locks.request(
    `miden-sync-${dbId}`,
    { mode: "exclusive", signal: controller.signal },
    () => runWithDeadline(fn, deadline)
  );

  return runWithDeadline(() => request, deadline).catch((err) => {
    // Abort a request that is still waiting for a lock. Once granted, the
    // bounded callback above releases the held lock by rejecting.
    if (Date.now() >= deadline) controller.abort();
    throw err;
  });
}

/**
 * Run `fn` under the sync lock for (dbId, methodId).
 *
 * Concurrent calls with the same (dbId, methodId) share the same promise
 * (coalescing). Concurrent calls on the same dbId with different methodIds
 * serialize via the Web Lock. Acquisition and execution are bounded so a
 * never-settling sync cannot permanently retain the coalescing slot or lock.
 *
 * @param {string} dbId - Database ID
 * @param {string} methodId - Method identifier (see MethodName constants)
 * @param {() => Promise<T>} fn - Work to run under the lock
 * @returns {Promise<T>}
 */
export function withSyncLock(dbId, methodId, fn) {
  const key = coalesceKey(dbId, methodId);

  let work = inFlight.get(key);
  if (!work) {
    const deadline = Date.now() + SYNC_LOCK_TIMEOUT_MS;
    work = runUnderLock(dbId, fn, deadline);
    inFlight.set(key, work);
    // Swallow on the derived promise so a rejection here doesn't surface as
    // an unhandled rejection; the caller still sees the error through `work`.
    work
      .finally(() => {
        if (inFlight.get(key) === work) inFlight.delete(key);
      })
      .catch(() => {});
  }

  return work;
}
