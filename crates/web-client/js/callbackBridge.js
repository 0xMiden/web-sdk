// External keystore callbacks under the Web Worker run on the main thread: the
// worker posts an EXECUTE_CALLBACK request and waits for a reply carrying the
// same requestId. This module holds the two pieces both sides must agree on:
// how a failed callback travels back, and how long the worker waits.

/** Per-callback limit for `getKey` and `insertKey` when `callbackTimeoutMs` is unset. */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 30000;

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
  if (typeof thrown !== "object" || thrown === null) {
    const message =
      typeof thrown === "string" && thrown !== ""
        ? thrown
        : `${callbackType} callback threw ${describeThrown(thrown)}`;
    return { message };
  }

  const serialized = {};
  if (typeof thrown.name === "string" && thrown.name !== "") {
    serialized.name = thrown.name;
  }
  if (typeof thrown.message === "string" && thrown.message !== "") {
    serialized.message = thrown.message;
  } else {
    const what =
      thrown instanceof Error
        ? (serialized.name ?? "an Error")
        : describeThrown(thrown);
    serialized.message = `${callbackType} callback threw ${what} with no message`;
  }
  if (isTransferableCode(thrown.code)) {
    serialized.code = thrown.code;
  }
  if (typeof thrown.reason === "string") {
    serialized.reason = thrown.reason;
  }
  if (thrown.cause !== undefined) {
    serialized.cause = serializeCallbackError(thrown.cause, callbackType);
  }
  return serialized;
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
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `callbackTimeoutMs must be a non-negative finite number, got ${describeThrown(value)}`
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
  return callbackTimeoutMs === 0 ? undefined : callbackTimeoutMs;
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
      const entry = data.callbackRequestId
        ? pending.get(data.callbackRequestId)
        : undefined;
      if (!entry) return false;
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
