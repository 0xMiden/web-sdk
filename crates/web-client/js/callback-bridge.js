import { CallbackType } from "./constants.js";

const DEFAULT_KEY_CALLBACK_TIMEOUT_MS = 30_000;

/**
 * Serialize a thrown callback value for postMessage across the worker
 * boundary. Preserves string throws, Error fields, and wallet-style
 * `{ code, message, name }` objects — unlike reading `.message` alone,
 * which treats `throw "rejected"` / `throw { code: 4001 }` as success.
 *
 * @param {*} error
 * @returns {{ name: string, message: string, stack?: string, cause?: *, code?: * }}
 */
export function serializeCallbackFailure(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause ? serializeCallbackFailure(error.cause) : undefined,
      code: /** @type {{ code?: unknown }} */ (error).code,
    };
  }

  if (typeof error === "string") {
    return { name: "Error", message: error };
  }

  if (typeof error === "object" && error !== null) {
    const message =
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : safeStringify(error);
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      message,
      code: error.code,
    };
  }

  return { name: "Error", message: String(error) };
}

/**
 * @param {*} errorLike
 * @returns {Error}
 */
export function deserializeCallbackFailure(errorLike) {
  if (!errorLike) {
    return new Error("Unknown error received from keystore callback");
  }
  if (typeof errorLike === "string") {
    return new Error(errorLike);
  }
  const { name, message, stack, cause, ...rest } = errorLike;
  const reconstructed = new Error(message ?? "Unknown keystore callback error");
  reconstructed.name = name ?? reconstructed.name;
  if (stack) {
    reconstructed.stack = stack;
  }
  if (cause) {
    reconstructed.cause = deserializeCallbackFailure(cause);
  }
  Object.entries(rest).forEach(([key, value]) => {
    if (value !== undefined) {
      reconstructed[key] = value;
    }
  });
  return reconstructed;
}

/**
 * Resolve the per-callback timeout.
 *
 * - `configured === undefined`: 30s for getKey/insertKey, no timeout for sign
 *   (human-paced approvals must not hit a fixed ceiling).
 * - `configured === null` or `0`: no timeout for any callback.
 * - finite positive number: that ceiling for every callback.
 *
 * @param {number | null | undefined} configured
 * @param {string} callbackType
 * @returns {number | null} milliseconds, or null for no timeout
 */
export function resolveCallbackTimeoutMs(configured, callbackType) {
  if (configured === null || configured === 0) {
    return null;
  }
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return configured > 0 ? configured : null;
  }
  if (callbackType === CallbackType.SIGN) {
    return null;
  }
  return DEFAULT_KEY_CALLBACK_TIMEOUT_MS;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
