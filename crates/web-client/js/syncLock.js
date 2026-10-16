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
 * - `WebClient._withStoreLock` in `index.js` takes the same lock, through
 *   `runUnderLock` and `coalesceRun`, for every call that writes the chain MMR.
 *   It coalesces in a registry of its own client, so a sync joins only a
 *   pending run of the same sync on that client, never another client's, and
 *   only while no other call has been queued on that client since the run
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

// Coalesce map keyed by `${dbId}:${methodId}` -> in-flight promise, used by
// `withSyncLock`. A WebClient passes `coalesceRun` a map of its own instead.
const inFlight = new Map();

// The `epoch()` each run registered with one was started in; see `coalesceRun`.
const startedIn = new WeakMap();

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
 * Every call runs its own `fn`, queued behind the current holder; see
 * `withSyncLock` for the coalescing variant.
 *
 * @param {string} dbId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export function runUnderLock(dbId, fn) {
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
 * Share one in-flight run of (dbId, methodId) among concurrent callers.
 *
 * The first caller's `start()` begins the run, and it stays registered in
 * `registry` until it settles; a caller arriving meanwhile with the same
 * registry gets the same promise and starts nothing. With `epoch`, a caller
 * joins only while `epoch()` still returns what it returned once the run had
 * started; otherwise it starts a run of its own, which replaces that one in
 * the registry. `start` takes the lock itself, if it needs one.
 *
 * @param {string} dbId - Database ID
 * @param {string} methodId - Method identifier (see MethodName constants)
 * @param {() => Promise<T>} start - Begins the run
 * @param {Map<string, Promise<T>>} [registry] - The runs callers can join.
 *   Defaults to the module-wide one `withSyncLock` uses.
 * @param {() => number} [epoch] - Moves once a joiner would no longer settle
 *   after every call made before it. Omitted, a run is joinable until it
 *   settles.
 * @returns {Promise<T>}
 * @template T
 */
export function coalesceRun(dbId, methodId, start, registry = inFlight, epoch) {
  const key = coalesceKey(dbId, methodId);

  let work = registry.get(key);
  if (!work || (epoch && startedIn.get(work) !== epoch())) {
    work = start();
    registry.set(key, work);
    if (epoch) startedIn.set(work, epoch());
    // Swallow on the derived promise so a rejection here doesn't surface as
    // an unhandled rejection; the caller still sees the error through `work`.
    work
      .finally(() => {
        if (registry.get(key) === work) registry.delete(key);
      })
      .catch(() => {});
  }

  return work;
}

/**
 * Run `fn` under the sync lock for (dbId, methodId).
 *
 * Concurrent calls with the same (dbId, methodId) share the same promise
 * (coalescing). Concurrent calls on the same dbId with different methodIds
 * serialize via the Web Lock.
 *
 * It is the store lock a `WebClient` takes on the store named `dbId`, and it
 * is not reentrant: `fn` must not wait, directly or through any lock or
 * queue, for anything that waits for a call on a client of that store.
 *
 * - Any call on such a client, not only its store-locked calls (`syncState`,
 *   `syncChain`, `syncNoteTransport`, `importNoteFile` or `notes.import`,
 *   `fetchPrivateNotes` or `notes.fetchPrivate`, `newWallet`, `newFaucet`,
 *   `newAccount`, `newAccountWithSecretKey`). A store-locked call takes its
 *   place on its client's call chain first and requests the lock inside it,
 *   so one already queued on that client, an auto-sync for example, holds
 *   the chain while it waits for the lock `fn` holds, and every later call on
 *   that client queues behind it.
 * - Any lock whose holder is waiting on such a call, such as
 *   `@miden-sdk/react`'s `runExclusive`, which `MidenProvider` holds across
 *   its init sync, or an application mutex around `_withInnerWebClient`.
 *
 * Every client on the store then stops.
 *
 * @param {string} dbId - Database ID
 * @param {string} methodId - Method identifier (see MethodName constants)
 * @param {() => Promise<T>} fn - Work to run under the lock
 * @returns {Promise<T>}
 */
export function withSyncLock(dbId, methodId, fn) {
  return coalesceRun(dbId, methodId, () => runUnderLock(dbId, fn));
}
