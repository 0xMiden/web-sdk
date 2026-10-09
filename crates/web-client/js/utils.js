/**
 * Shared utility functions for the MidenClient resource classes.
 * Each function accepts a `wasm` parameter (the WASM module) for constructing typed objects.
 */

/**
 * Resolves an AccountRef (string | Account | AccountId) to an AccountId.
 *
 * - Strings starting with `0x`/`0X` are parsed as hex via `AccountId.fromHex()`.
 * - Other strings are parsed as bech32 via `AccountId.fromBech32()`.
 * - Objects with an `.id()` method (Account) are resolved by calling `.id()`.
 * - Otherwise, the value is assumed to be an AccountId pass-through.
 *
 * @param {string | Account | AccountId} ref - The account reference to resolve.
 * @param {object} wasm - The WASM module.
 * @returns {AccountId} The resolved AccountId.
 */
export function resolveAccountRef(ref, wasm) {
  if (ref == null) {
    throw new Error("Account reference cannot be null or undefined");
  }
  if (typeof ref === "string") {
    if (ref.startsWith("0x") || ref.startsWith("0X")) {
      return wasm.AccountId.fromHex(ref);
    }
    return wasm.AccountId.fromBech32(ref);
  }
  if (ref && typeof ref.id === "function") {
    return ref.id();
  }
  return ref;
}

/**
 * Resolves an AccountRef to a WASM Address object.
 *
 * - Strings starting with bech32 prefixes (`m`) are parsed via `Address.fromBech32()`.
 * - Strings starting with `0x`/`0X` are parsed as hex AccountId, then wrapped in Address.
 * - Account objects are resolved via `.id()` then wrapped in Address.
 * - AccountId objects are wrapped in Address directly.
 *
 * @param {string | Account | AccountId} ref - The account reference to resolve.
 * @param {object} wasm - The WASM module.
 * @returns {Address} The resolved Address.
 */
export function resolveAddress(ref, wasm) {
  if (ref == null) {
    throw new Error("Address reference cannot be null or undefined");
  }
  if (typeof ref === "string") {
    if (ref.startsWith("0x") || ref.startsWith("0X")) {
      const accountId = wasm.AccountId.fromHex(ref);
      return wasm.Address.fromAccountId(accountId, undefined);
    }
    return wasm.Address.fromBech32(ref);
  }
  if (ref && typeof ref.id === "function") {
    const accountId = ref.id();
    return wasm.Address.fromAccountId(accountId, undefined);
  }
  return wasm.Address.fromAccountId(ref, undefined);
}

/**
 * True when `record` can be consumed right now, as of the client's last sync.
 *
 * Reads each entry's status rather than inferring it: a missing
 * `consumableAfterBlock()` alone would also match a note that is never
 * consumable. With `accountIdHex`, only that account's entry counts, so a note
 * locked for it is excluded even when another tracked account could spend it;
 * without one (a listing that spans accounts), any account's entry counts.
 *
 * @param {ConsumableNoteRecord} record - A record from `getConsumableNotes`.
 * @param {string} [accountIdHex] - The account the record was screened for.
 * @returns {boolean} True when a counted entry reports a consumable-now status.
 */
export function isConsumableNow(record, accountIdHex) {
  return record
    .noteConsumability()
    .some(
      (nc) =>
        (accountIdHex == null || nc.accountId().toString() === accountIdHex) &&
        nc.consumptionStatus().isConsumableNow()
    );
}

/**
 * Resolves a NoteVisibility string to a WASM NoteType value.
 *
 * @param {string | undefined} type - "public" or "private". Defaults to "public".
 * @param {object} wasm - The WASM module.
 * @returns {number} The NoteType enum value.
 */
export function resolveNoteType(type, wasm) {
  if (type === "private") {
    return wasm.NoteType.Private;
  }
  if (type === "public" || type == null) {
    return wasm.NoteType.Public;
  }
  throw new Error(
    `Unknown note type: "${type}". Expected "public" or "private".`
  );
}

/**
 * Resolves a storage mode string to a WASM AccountStorageMode instance.
 *
 * @param {string | undefined} mode - "private" or "public". Defaults to "private".
 * @param {object} wasm - The WASM module.
 * @returns {AccountStorageMode} The storage mode instance.
 */
export function resolveStorageMode(mode, wasm) {
  switch (mode) {
    case "public":
      return wasm.AccountStorageMode.public();
    case "private":
    case undefined:
    case null:
      return wasm.AccountStorageMode.private();
    default:
      throw new Error(
        `Unknown storage mode: "${mode}". Expected "private" or "public".`
      );
  }
}

/**
 * Resolves an auth scheme string to a WASM AuthScheme enum value.
 *
 * A number passes through unchanged only when it is one of
 * `wasm.AuthScheme`'s values, so callers that receive a pre-resolved value
 * (e.g. `AccountsResource.create`, which resolves before forwarding to the
 * low-level `newWallet`/`newFaucet`) don't get double-processed, while any
 * other number is rejected here rather than at the WASM boundary. Members are
 * read by name because the napi-rs enum on the Node entry defines them
 * non-enumerable, so `Object.values` sees none of them there.
 *
 * @param {string | number | undefined} scheme - "falcon" or "ecdsa" (or an
 *   already-resolved numeric enum value). Defaults to "falcon".
 * @param {object} wasm - The WASM module.
 * @returns {number} The AuthScheme enum value.
 */
export function resolveAuthScheme(scheme, wasm) {
  if (
    typeof scheme === "number" &&
    Object.getOwnPropertyNames(wasm.AuthScheme).some(
      (name) => wasm.AuthScheme[name] === scheme
    )
  ) {
    return scheme;
  }
  if (scheme === "ecdsa") {
    return wasm.AuthScheme.AuthEcdsaK256Keccak;
  }
  if (scheme === "falcon" || scheme == null) {
    return wasm.AuthScheme.AuthRpoFalcon512;
  }
  throw new Error(
    `Unknown auth scheme: "${scheme}". Expected "falcon" or "ecdsa".`
  );
}

/**
 * Resolves a NoteInput (string | NoteId | InputNoteRecord | Note) to a hex string.
 *
 * - Strings are passed through unchanged.
 * - NoteId WASM objects are converted via `.toString()`.
 * - InputNoteRecord and Note objects (with an `.id()` method) are resolved via `.id().toString()`.
 *
 * @param {string | object} input - The note reference to resolve.
 * @returns {string} The hex note ID string.
 */
export function resolveNoteIdHex(input) {
  if (input == null) {
    throw new Error("Note ID cannot be null or undefined");
  }
  if (typeof input === "string") {
    return input;
  }
  // NoteId WASM object — has toString() but not id() (unlike InputNoteRecord/Note).
  // Check for constructor.fromHex to distinguish from plain objects (which also inherit toString).
  if (
    typeof input.toString === "function" &&
    typeof input.id !== "function" &&
    input.constructor?.fromHex !== undefined
  ) {
    return input.toString();
  }
  // InputNoteRecord, Note, or other object with id() returning NoteId
  if (typeof input.id === "function") {
    return input.id().toString();
  }
  throw new TypeError(
    `Cannot resolve note ID: expected string, NoteId, InputNoteRecord, or Note, got ${typeof input}`
  );
}

/**
 * Resolves a TransactionId reference (string | TransactionId) to a hex string.
 *
 * - Strings are passed through unchanged.
 * - TransactionId WASM objects are converted via `.toHex()`.
 *
 * @param {string | object} input - The transaction ID reference to resolve.
 * @returns {string} The hex transaction ID string.
 */
export function resolveTransactionIdHex(input) {
  if (input == null) {
    throw new Error("Transaction ID cannot be null or undefined");
  }
  if (typeof input === "string") {
    return input;
  }
  // TransactionId WASM object — toHex() returns hex
  if (typeof input.toHex === "function") {
    return input.toHex();
  }
  throw new TypeError(
    `Cannot resolve transaction ID: expected string or TransactionId, got ${typeof input}`
  );
}

/**
 * Hashes a seed value. Strings are hashed via SHA-256 to produce a 32-byte Uint8Array.
 * Uint8Array values are passed through unchanged.
 *
 * @param {string | Uint8Array} seed - The seed to hash.
 * @returns {Promise<Uint8Array>} The hashed seed.
 */
export async function hashSeed(seed) {
  if (seed instanceof Uint8Array) {
    return seed;
  }
  if (typeof seed === "string") {
    const encoded = new TextEncoder().encode(seed);
    const hash = await crypto.subtle.digest("SHA-256", encoded);
    return new Uint8Array(hash);
  }
  throw new TypeError(
    `Invalid seed type: expected string or Uint8Array, got ${typeof seed}`
  );
}

/**
 * Bounds for the note transport send-retry options. A retry waits
 * `noteTransportRetryIntervalMs * 2^n` before attempt `n + 1`, so a send can
 * spend `interval * (2^maxRetries - 1)` ms in backoff. Each value has its own
 * cap, and the two together may not exceed a 120000 ms total: a send's retries
 * run inside the client's serialized call, so every other call on the client
 * waits for them. That also keeps each single delay far below the `2^31 - 1` ms
 * at which the browser timer throws inside WASM. The defaults are the transport's
 * own, used for an omitted value.
 */
const NOTE_TRANSPORT_MAX_RETRIES_CAP = 10;
const NOTE_TRANSPORT_RETRY_INTERVAL_MS_CAP = 60_000;
const NOTE_TRANSPORT_TOTAL_BACKOFF_MS_CAP = 120_000;
const NOTE_TRANSPORT_DEFAULT_MAX_RETRIES = 3;
const NOTE_TRANSPORT_DEFAULT_RETRY_INTERVAL_MS = 250;

/**
 * Validates the note transport send-retry options before any worker or WASM
 * call sees them. Validation lives here because wasm-bindgen converts a JS
 * number to `u32` with `>>> 0` (so `-1` silently becomes `4294967295`), while
 * the napi binding throws; checking first makes both builds agree.
 *
 * `undefined` means "use the default" (3 retries, 250 ms) and is accepted.
 *
 * @param {unknown} noteTransportMaxRetries - Integer from 0 to 10, or undefined.
 * @param {unknown} noteTransportRetryIntervalMs - Integer from 0 to 60000, or undefined.
 * @throws {TypeError} Naming the option that is out of range, or the total
 *   backoff `interval * (2^maxRetries - 1)` when it exceeds 120000 ms.
 */
export function validateNoteTransportRetryOptions(
  noteTransportMaxRetries,
  noteTransportRetryIntervalMs
) {
  checkRetryOption(
    "noteTransportMaxRetries",
    noteTransportMaxRetries,
    NOTE_TRANSPORT_MAX_RETRIES_CAP
  );
  checkRetryOption(
    "noteTransportRetryIntervalMs",
    noteTransportRetryIntervalMs,
    NOTE_TRANSPORT_RETRY_INTERVAL_MS_CAP
  );
  const maxRetries =
    noteTransportMaxRetries ?? NOTE_TRANSPORT_DEFAULT_MAX_RETRIES;
  const intervalMs =
    noteTransportRetryIntervalMs ?? NOTE_TRANSPORT_DEFAULT_RETRY_INTERVAL_MS;
  const totalMs = intervalMs * (2 ** maxRetries - 1);
  if (totalMs > NOTE_TRANSPORT_TOTAL_BACKOFF_MS_CAP) {
    throw new TypeError(
      `noteTransportMaxRetries ${maxRetries} with noteTransportRetryIntervalMs ` +
        `${intervalMs} allows ${totalMs} ms of retry backoff in total; the most ` +
        `is ${NOTE_TRANSPORT_TOTAL_BACKOFF_MS_CAP} ms`
    );
  }
}

function checkRetryOption(name, value, cap) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > cap) {
    throw new TypeError(
      `${name} must be an integer from 0 to ${cap}, got ${String(value)}`
    );
  }
}
