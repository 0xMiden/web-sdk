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
 * @returns {Promise<T>}
 * @template T
 */
function runUnderLock(dbId, fn) {
  if (!hasWebLocks()) {
    const prev = fallbackTails.get(dbId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const guarded = next.catch(() => {});
    fallbackTails.set(dbId, guarded);
    guarded.then(() => {
      // Drop the slot only if no successor chained onto this tail.
      if (fallbackTails.get(dbId) === guarded) fallbackTails.delete(dbId);
    });
    return next;
  }
  return navigator.locks.request(
    `miden-sync-${dbId}`,
    { mode: "exclusive" },
    fn
  );
}

/**
 * Run `fn` under the sync lock for (dbId, methodId).
 *
 * Concurrent calls with the same (dbId, methodId) share the same promise
 * (coalescing). Concurrent calls on the same dbId with different methodIds
 * serialize via the Web Lock.
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
    work = runUnderLock(dbId, fn);
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
