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
 *   only while no other call has been queued on that client since the run.
 *   A joiner shares the run it joins, including a run that holds the lock and
 *   never settles
 * - A run stays joinable for `MAX_JOIN_AGE_MS`. The wait bound starts when
 *   the call is made and is `LOCK_WAIT_TIMEOUT_MS`, on the in-process
 *   fallback as well as the Web Lock, so one sync that never settles cannot
 *   capture every later sync or leave its waiters hanging
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

// How long a run stays joinable. A caller arriving later starts a run of its
// own, queued behind the lock, instead of waiting on one that may be stuck.
export const MAX_JOIN_AGE_MS = 5 * 60 * 1000;

// How long a call waits, from when it is made, before it rejects. The bound
// covers the in-process fallback as well as the Web Lock. Aborting a request
// affects only a waiter, never a holder.
export const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Rejection for a call whose wait for the sync lock of `dbId` ran out.
 *
 * @param {string} dbId
 * @param {number} waitTimeoutMs
 * @returns {Error}
 */
export function lockWaitError(dbId, waitTimeoutMs) {
  return new Error(
    `Timed out after ${waitTimeoutMs} ms waiting for the sync lock of ${dbId}`
  );
}

// Coalesce map keyed by `${dbId}:${methodId}` -> in-flight promise, used by
// `withSyncLock`. A WebClient passes `coalesceRun` a map of its own instead.
const inFlight = new Map();

// The `epoch()` each run registered with one was started in; see `coalesceRun`.
const startedIn = new WeakMap();

// When each registered run started, for `MAX_JOIN_AGE_MS`.
const startedAt = new WeakMap();

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
 * Every call runs its own `fn`, queued behind the current holder, unless the
 * wait bound has already run out; see `withSyncLock` for the coalescing
 * variant. The bound starts when this call is made and covers the in-process
 * fallback as well as the Web Lock. Work whose wait timed out never runs, and
 * a holder that has started is not aborted.
 *
 * @param {string} dbId
 * @param {() => Promise<T>} fn
 * @param {number} [waitTimeoutMs] - How long this call waits, from when it is
 *   made, before rejecting. Covers the in-process fallback as well as the
 *   Web Lock.
 * @returns {Promise<T>}
 * @template T
 */
export function runUnderLock(dbId, fn, waitTimeoutMs = LOCK_WAIT_TIMEOUT_MS) {
  if (!hasWebLocks()) {
    // The caller rejects at the deadline. The queue slot stays until its
    // turn, so a later call cannot overlap the holder, and this does not
    // settle the previous tail.
    let timedOut = false;
    let resolveCaller = () => {};
    let rejectCaller = () => {};
    const caller = new Promise((resolve, reject) => {
      resolveCaller = resolve;
      rejectCaller = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      rejectCaller(lockWaitError(dbId, waitTimeoutMs));
    }, waitTimeoutMs);

    const prev = fallbackTails.get(dbId) ?? Promise.resolve();
    const slot = prev
      .catch(() => {})
      .then(() => {
        // Already-settled tail: this microtask runs before the timer, so a
        // free lock still calls fn. A timer that has fired skips fn.
        if (timedOut) return;
        clearTimeout(timer);
        return fn();
      });
    const guarded = slot.catch(() => {});
    fallbackTails.set(dbId, guarded);
    guarded.then(() => {
      // Drop the slot only if no successor chained onto this tail.
      if (fallbackTails.get(dbId) === guarded) fallbackTails.delete(dbId);
    });
    slot.then(resolveCaller, rejectCaller);
    return caller;
  }

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, waitTimeoutMs);
  // Chrome 69 to 97 and Firefox 96 reject an aborted request with a fresh
  // AbortError and leave `signal.reason` unset, so the flag is the signal.
  const rejection = (error) => {
    clearTimeout(timer);
    if (timedOut) return lockWaitError(dbId, waitTimeoutMs);
    return error;
  };
  const callback = () => {
    clearTimeout(timer);
    if (timedOut) throw lockWaitError(dbId, waitTimeoutMs);
    return fn();
  };

  let request;
  try {
    request = navigator.locks.request(
      `miden-sync-${dbId}`,
      { mode: "exclusive", signal: controller.signal },
      callback
    );
  } catch (error) {
    return Promise.reject(rejection(error));
  }
  return Promise.resolve(request).catch((error) => {
    throw rejection(error);
  });
}

/**
 * Share one in-flight run of (dbId, methodId) among concurrent callers.
 *
 * The first caller's `start()` begins the run, and it stays registered in
 * `registry` until it settles; a caller arriving meanwhile with the same
 * registry gets the same promise and starts nothing. A joiner shares the run
 * it joins, including a run that holds the lock and never settles. With
 * `epoch`, a caller joins only while `epoch()` still returns what it returned
 * once the run had started; otherwise it starts a run of its own, which
 * replaces that one in the registry. `start` takes the lock itself, if it
 * needs one.
 *
 * @param {string} dbId - Database ID
 * @param {string} methodId - Method identifier (see MethodName constants)
 * @param {() => Promise<T>} start - Begins the run
 * @param {Map<string, Promise<T>>} [registry] - The runs callers can join.
 *   Defaults to the module-wide one `withSyncLock` uses.
 * @param {() => number} [epoch] - Moves once a joiner would no longer settle
 *   after every call made before it. Omitted, a run is joinable until it
 *   settles or outlives `maxJoinAgeMs`.
 * @param {number} [maxJoinAgeMs] - A run older than this is not joined.
 * @returns {Promise<T>}
 * @template T
 */
export function coalesceRun(
  dbId,
  methodId,
  start,
  registry = inFlight,
  epoch,
  maxJoinAgeMs = MAX_JOIN_AGE_MS
) {
  const key = coalesceKey(dbId, methodId);

  let work = registry.get(key);
  if (
    !work ||
    (epoch && startedIn.get(work) !== epoch()) ||
    Date.now() - startedAt.get(work) > maxJoinAgeMs
  ) {
    work = start();
    registry.set(key, work);
    startedAt.set(work, Date.now());
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
 *   `fetchPrivateNotes` or `notes.fetchPrivate`, and
 *   `syncBeforeAccountCreation`, `newWallet`, `newFaucet`, `newAccount` and
 *   `newAccountWithSecretKey`, which request and wait for the lock only on a
 *   store still at genesis, the creations holding it only for the sync they
 *   run first, so no application callback such as an external keystore's
 *   `insertKey` runs under it). A store-locked call takes its place on its
 *   client's call chain first and requests the lock inside it, so one already
 *   queued on that client, an auto-sync for example, holds the chain while it
 *   waits for the lock `fn` holds, and every later call on that client queues
 *   behind it.
 * - Any lock whose holder is waiting on such a call, such as
 *   `@miden-sdk/react`'s `runExclusive`, which `MidenProvider` holds across
 *   its init sync, or an application mutex around `_withInnerWebClient`.
 *
 * Every client on the store stalls until the waiting store-locked call's bound
 * runs out and it rejects.
 *
 * @param {string} dbId - Database ID
 * @param {string} methodId - Method identifier (see MethodName constants)
 * @param {() => Promise<T>} fn - Work to run under the lock
 * @returns {Promise<T>}
 */
export function withSyncLock(dbId, methodId, fn) {
  return coalesceRun(dbId, methodId, () => runUnderLock(dbId, fn));
}
