/**
 * Sync Lock Module
 *
 * Coordinates concurrent sync calls using the Web Locks API.
 *
 * Behavior:
 * - Same-method coalescing: if a sync of the same method is in progress,
 *   subsequent callers share its result promise
 * - Different-method serialization: different methods (e.g. syncState vs
 *   syncNoteTransport) wait for each other via the Web Lock (or the
 *   WASM-level mutex when Web Locks are unavailable)
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

/**
 * Build the coalesce-map key for an in-flight sync of `(dbId, methodId)`.
 *
 * @param {string} dbId
 * @param {string} methodId
 * @returns {string}
 */
<<<<<<< ours
export async function acquireSyncLock(dbId, timeoutMs = 0) {
  const state = getSyncState(dbId);

  // If a sync is already in progress, wait for it to complete (coalescing)
  if (state.inProgress) {
    return new Promise((resolve, reject) => {
      let timeoutId;
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          const idx = state.waiters.findIndex((w) => w.resolve === onResult);
          if (idx !== -1) {
            state.waiters.splice(idx, 1);
          }
          reject(new Error("Sync lock acquisition timed out"));
        }, timeoutMs);
      }

      const onResult = (result) => {
        /* v8 ignore next 1 -- timeoutId only set when timeoutMs>0 AND another sync is in progress; combo rare in tests */
        if (timeoutId) clearTimeout(timeoutId);
        resolve({ acquired: false, coalescedResult: result });
      };

      const onError = (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        reject(error);
      };

      state.waiters.push({ resolve: onResult, reject: onError });
    });
  }

  // Mark sync as in progress and increment generation
  state.inProgress = true;
  state.result = null;
  state.error = null;
  state.syncGeneration++;
  const currentGeneration = state.syncGeneration;

  // Try to acquire Web Lock if available
  if (hasWebLocks()) {
    const lockName = `miden-sync-${dbId}`;

    return new Promise((resolve, reject) => {
      let timeoutId;
      let timedOut = false;

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          if (state.syncGeneration === currentGeneration) {
            state.inProgress = false;
            const error = new Error("Sync lock acquisition timed out");
            for (const waiter of state.waiters) {
              waiter.reject(error);
            }
            state.waiters = [];
          }
          reject(new Error("Sync lock acquisition timed out"));
        }, timeoutMs);
      }

      navigator.locks
        .request(lockName, { mode: "exclusive" }, async () => {
          /* v8 ignore next 3 -- race: lock granted after timeout or newer generation */
          if (timedOut || state.syncGeneration !== currentGeneration) {
            return;
          }

          if (timeoutId) clearTimeout(timeoutId);

          return new Promise((releaseLock) => {
            state.releaseLock = releaseLock;
            resolve({ acquired: true });
          });
        })
        .catch((err) => {
          /* v8 ignore next 5 -- catch path requires Web Locks rejection combined with
             optional timeout; tested via "rejects when Web Locks request rejects" but
             the timeoutId-set branch needs Web Locks + timeout simultaneously */
          if (timeoutId) clearTimeout(timeoutId);
          if (state.syncGeneration === currentGeneration) {
            state.inProgress = false;
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  } else {
    // Fallback: no Web Locks, just use in-process state
    return { acquired: true };
  }
=======
function coalesceKey(dbId, methodId) {
  return `${dbId}:${methodId}`;
>>>>>>> theirs
}

/**
 * Run `fn` while holding the per-db Web Lock. When Web Locks are unavailable,
 * runs `fn` directly and relies on the WASM-level mutex (`get_mut_inner`) to
 * serialize across methods within the tab.
 *
 * @param {string} dbId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
function runUnderLock(dbId, fn) {
  if (!hasWebLocks()) {
    // No Web Locks: rely on the WASM-level mutex (get_mut_inner) to serialize
    // across methods within the tab.
    return Promise.resolve().then(fn);
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
