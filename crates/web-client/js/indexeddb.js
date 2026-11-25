/** Validates browser storage options before worker or backend construction. */
export function validateIndexedDbOptions(options) {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("indexedDb must be an options object");
  }
  const { durability, onFailure } = options;
  if (
    durability !== undefined &&
    !["default", "strict", "relaxed"].includes(durability)
  ) {
    throw new TypeError("Invalid IndexedDB durability");
  }
  if (onFailure !== undefined && typeof onFailure !== "function") {
    throw new TypeError("IndexedDB onFailure must be a function");
  }
  return { durability, onFailure };
}

export function indexedDbArgs(options) {
  return options === undefined ? [] : [options];
}

export function workerIndexedDbOptions(options) {
  return options === undefined
    ? undefined
    : {
        durability: options.durability,
        notify: typeof options.onFailure === "function",
      };
}

/** Rejects malformed worker notifications and copies only the closed routing envelope. */
export function deliverIndexedDbFailure(callback, value) {
  if (
    typeof callback !== "function" ||
    !value ||
    value.backend !== "indexeddb" ||
    typeof value.storeName !== "string" ||
    typeof value.eventId !== "string" ||
    value.eventId.length === 0 ||
    value.eventId.length > 128 ||
    !["open", "read", "write", "commit"].includes(value.phase) ||
    value.operation !== `indexeddb.${value.phase}` ||
    !["quota", "io", "unavailable", "unexpected-abort"].includes(value.kind) ||
    ![
      "QuotaExceededError",
      "UnknownError",
      "SecurityError",
      "InvalidStateError",
      "MissingAPIError",
      "AbortError",
    ].includes(value.errorName)
  )
    return;
  const { backend, storeName, phase, operation, kind, errorName, eventId } =
    value;
  try {
    callback(
      Object.freeze({
        backend,
        storeName,
        phase,
        operation,
        kind,
        errorName,
        eventId,
      })
    );
  } catch {
    /* The operation retains its original result if consumer code throws. */
  }
}

/** One client may hold overlapping raw connections during replacement. */
export function createIndexedDbFailureSubscription(callback, isActive) {
  const seen = new Set();
  return {
    notify(value) {
      if (!callback || !isActive()) return;
      deliverIndexedDbFailure((failure) => {
        if (seen.has(failure.eventId)) return;
        seen.add(failure.eventId);
        if (seen.size > 64) seen.delete(seen.values().next().value);
        callback(failure);
      }, value);
    },
    dispose() {
      callback = undefined;
      seen.clear();
    },
  };
}
