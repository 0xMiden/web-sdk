// External keystore callbacks under the Web Worker run on the main thread: the
// worker posts an EXECUTE_CALLBACK request and waits for a reply carrying the
// same requestId. This module holds the two pieces both sides must agree on:
// how a failed callback travels back, and how long the worker waits.

/** Per-callback limit for `getKey` and `insertKey` when `callbackTimeoutMs` is unset. */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 30000;
/** Largest delay `setTimeout` can store, in milliseconds. */
const MAX_CALLBACK_TIMEOUT_MS = 2147483647;

const isTransferableCode = (value) =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  typeof value === "bigint";

const describeThrown = (thrown) => {
  if (thrown === null) return "null";
  if (thrown === undefined) return "undefined";
  try {
    const json = JSON.stringify(thrown);
    if (json !== undefined && json !== "{}") return json;
  } catch {
    // Fall through to String().
  }
  return String(thrown);
};

/**
 * Converts whatever a keystore callback threw into a structured-cloneable
 * object that keeps its `name`, `message`, `code`, `reason` and `cause`.
 *
 * Any value can be thrown, including a bare string, `{ code: 4001 }`, `null`
 * or an `Error` with an empty message, so `message` falls back to a
 * description of the thrown value when it has none.
 *
 * @param {unknown} thrown
 * @param {string} callbackType - The callback that threw, for the fallback message.
 * @returns {{name?: string, message: string, code?: string | number | boolean | bigint, reason?: string, cause?: object}}
 */
export function serializeCallbackError(thrown, callbackType) {
  const unreadable = {
    message: `${callbackType} callback threw an unreadable value`,
  };

  const serialize = (value, seen) => {
    if (typeof value !== "object" || value === null) {
      const message =
        typeof value === "string" && value !== ""
          ? value
          : describeThrown(value);
      return {
        message:
          message === undefined
            ? unreadable.message
            : typeof value === "string" && value !== ""
              ? message
              : `${callbackType} callback threw ${message}`,
      };
    }

    if (seen.has(value)) {
      return { message: `${callbackType} callback threw a circular cause` };
    }
    seen.add(value);

    const read = (key) => {
      try {
        return { ok: true, value: value[key] };
      } catch {
        return { ok: false };
      }
    };
    const name = read("name");
    const message = read("message");
    const code = read("code");
    const reason = read("reason");
    const cause = read("cause");
    if (!message.ok) return unreadable;

    const serialized = {};
    if (name.ok && typeof name.value === "string" && name.value !== "") {
      serialized.name = name.value;
    }
    if (typeof message.value === "string" && message.value !== "") {
      serialized.message = message.value;
    } else {
      const what =
        value instanceof Error
          ? (serialized.name ?? "an Error")
          : describeThrown(value);
      if (what === undefined) return unreadable;
      serialized.message = `${callbackType} callback threw ${what} with no message`;
    }
    if (code.ok && isTransferableCode(code.value)) {
      serialized.code = code.value;
    }
    if (reason.ok && typeof reason.value === "string") {
      serialized.reason = reason.value;
    }
    if (cause.ok && cause.value !== undefined) {
      try {
        serialized.cause = serialize(cause.value, seen);
      } catch {
        serialized.cause = {
          message: `${callbackType} callback threw an unreadable cause`,
        };
      }
    }
    return serialized;
  };

  try {
    return serialize(thrown, new WeakSet());
  } catch {
    return unreadable;
  }
}

/**
 * Rebuilds the `Error` a failed callback reply describes, so the worker rejects
 * with the callback's own name, message, code, reason and cause.
 *
 * @param {ReturnType<typeof serializeCallbackError>} serialized
 * @returns {Error}
 */
export function deserializeCallbackError(serialized) {
  const error = new Error(serialized.message);
  if (serialized.name !== undefined) error.name = serialized.name;
  if (serialized.code !== undefined) error.code = serialized.code;
  if (serialized.reason !== undefined) error.reason = serialized.reason;
  if (serialized.cause !== undefined) {
    error.cause = deserializeCallbackError(serialized.cause);
  }
  return error;
}

/**
 * Checks the `callbackTimeoutMs` client option.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function validateCallbackTimeoutMs(value) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_CALLBACK_TIMEOUT_MS
  ) {
    throw new TypeError(
      `callbackTimeoutMs must be a non-negative finite number no greater than ${MAX_CALLBACK_TIMEOUT_MS}, got ${typeof value === "number" ? String(value) : describeThrown(value)}`
    );
  }
  return value;
}

/**
 * How long the worker waits for one callback, in milliseconds, or `undefined`
 * for no limit.
 *
 * With `callbackTimeoutMs` unset, `sign` waits without a limit, since it can
 * wait on a person approving in a wallet, and `getKey` and `insertKey` keep
 * the 30 second limit. A positive `callbackTimeoutMs` applies to all three,
 * and `0` removes the limit for all three.
 *
 * @param {string} callbackType - A `CallbackType` value.
 * @param {number | undefined} callbackTimeoutMs
 * @returns {number | undefined}
 */
export function callbackTimeoutFor(callbackType, callbackTimeoutMs) {
  if (callbackTimeoutMs === undefined) {
    return callbackType === "sign" ? undefined : DEFAULT_CALLBACK_TIMEOUT_MS;
  }
  return callbackTimeoutMs === 0 ? undefined : Math.ceil(callbackTimeoutMs);
}

/**
 * The worker side of the bridge: forwards callbacks to the main thread and
 * settles each one when its reply arrives or its time limit passes.
 *
 * @param {{post: (message: object) => void, timeoutMs: () => number | undefined}} io
 *   `post` sends a message to the main thread; `timeoutMs` returns the
 *   `callbackTimeoutMs` client option, read when each callback starts.
 */
export function createCallbackForwarder({ post, timeoutMs }) {
  const pending = new Map();

  return {
    /**
     * @param {string} callbackType - A `CallbackType` value.
     * @param {unknown[]} args
     * @returns {Promise<unknown>} The callback's result.
     */
    forward(callbackType, args) {
      return new Promise((resolve, reject) => {
        const requestId = `${callbackType}-${Date.now()}-${Math.random()}`;
        const limitMs = callbackTimeoutFor(callbackType, timeoutMs());
        const timeoutId =
          limitMs === undefined
            ? undefined
            : setTimeout(() => {
                if (pending.delete(requestId)) {
                  reject(
                    new Error(
                      `Callback ${requestId} timed out after ${limitMs}ms`
                    )
                  );
                }
              }, limitMs);
        pending.set(requestId, { resolve, reject, timeoutId });
        post({ callbackType, args, requestId });
      });
    },

    /**
     * Settles the callback a main-thread reply answers.
     *
     * @param {{callbackRequestId?: string, callbackOk?: boolean, callbackResult?: unknown, callbackError?: object}} data
     * @returns {boolean} Whether `data` answered a pending callback.
     */
    handleReply(data) {
      if (typeof data.callbackRequestId !== "string") return false;
      const entry = pending.get(data.callbackRequestId);
      if (!entry) return true;
      clearTimeout(entry.timeoutId);
      pending.delete(data.callbackRequestId);
      if (data.callbackOk) {
        entry.resolve(data.callbackResult);
      } else {
        entry.reject(deserializeCallbackError(data.callbackError));
      }
      return true;
    },
  };
}
