/**
 * Codes assigned by the Rust client rather than this package. They arrive on
 * errors thrown out of WASM, so they are not `MidenError`s and not part of the
 * closed `MidenErrorCode` union.
 *
 * On Node these are a `"CODE: "` prefix on the message rather than a property,
 * because the napi bindings cannot attach one.
 */
export type WasmErrorCode =
  | "INVALID_CHAIN_ANCHOR"
  | "TRANSACTION_ALREADY_AUTHORIZED";

/**
 * An `Error` that may carry a machine-readable `code`.
 *
 * Hooks surface this rather than a bare `Error` so the codes their docs tell
 * you to branch on are reachable without a cast. The `(string & {})` arm keeps
 * unrecognized codes from a newer client assignable while preserving
 * autocomplete on the known ones.
 */
export type CodedError = Error & {
  readonly code?: MidenErrorCode | WasmErrorCode | (string & {});
};

export type MidenErrorCode =
  | "WASM_CLASS_MISMATCH"
  | "WASM_POINTER_CONSUMED"
  | "WASM_NOT_INITIALIZED"
  | "WASM_SYNC_REQUIRED"
  | "SEND_BUSY"
  | "OPERATION_BUSY"
  | "STALE_CLIENT"
  | "PRIVATE_NOTE_DELIVERY_FAILED"
  | "UNKNOWN";

export class MidenError extends Error {
  readonly code: MidenErrorCode;
  declare readonly cause?: unknown;

  constructor(
    message: string,
    options?: { cause?: unknown; code?: MidenErrorCode }
  ) {
    super(message);
    this.name = "MidenError";
    this.code = options?.code ?? "UNKNOWN";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** A private note a transaction created, and who it is for. */
export interface PrivateNoteDelivery {
  /** The note's id, as hex. */
  noteId: string;
  /**
   * The recipient, in a form the hooks accept again: the string the caller
   * passed, or an object recipient's account id as hex.
   */
  to: string;
}

/** What `useResendPrivateNotes().resend` relays. */
export interface PrivateNoteResendRequest {
  /** The transaction that created the notes. */
  transactionId: string;
  notes: PrivateNoteDelivery[];
}

/**
 * A transaction was submitted, but private notes it created for a recipient
 * were not delivered.
 *
 * The transaction is not retried and is not undone: `transactionId` names it
 * whatever happened to its notes. `commitment` is `"committed"` when the hook
 * saw the transaction commit before relaying, and `"unknown"` when it did not
 * get that far: applying it locally failed, the commit wait did not see it
 * commit, or none of the notes had a full note to relay. The SDK keeps no
 * queue, so nothing re-sends a note on its own: pass
 * `{ transactionId, notes: undelivered }` to `useResendPrivateNotes().resend`,
 * which is safe to repeat. A note whose transaction this client could not apply
 * is not in its store, so it cannot be resent from this client.
 *
 * `undelivered` is empty only when the transaction's output notes could not be
 * read at all; `cause` then says why.
 */
export class PrivateNoteDeliveryError extends MidenError {
  declare readonly code: "PRIVATE_NOTE_DELIVERY_FAILED";
  readonly transactionId: string;
  readonly commitment: "committed" | "unknown";
  readonly delivered: PrivateNoteDelivery[];
  readonly undelivered: PrivateNoteDelivery[];

  constructor(details: {
    transactionId: string;
    commitment: "committed" | "unknown";
    delivered: PrivateNoteDelivery[];
    undelivered: PrivateNoteDelivery[];
    cause?: unknown;
  }) {
    const { transactionId, commitment, delivered, undelivered, cause } =
      details;
    const missed =
      undelivered.length === 0
        ? "its private notes could not be read"
        : `${undelivered.length} of ${delivered.length + undelivered.length} private notes ${undelivered.length === 1 ? "was" : "were"} not delivered`;
    const reason =
      cause instanceof Error
        ? cause.message
        : cause == null
          ? ""
          : String(cause);
    super(
      `Transaction ${transactionId} was ${commitment === "committed" ? "committed" : "submitted"}, but ${missed}${reason ? `: ${reason}` : ""}`,
      { cause, code: "PRIVATE_NOTE_DELIVERY_FAILED" }
    );
    this.name = "PrivateNoteDeliveryError";
    this.transactionId = transactionId;
    this.commitment = commitment;
    this.delivered = delivered;
    this.undelivered = undelivered;
  }
}

interface ErrorPattern {
  test: (msg: string) => boolean;
  code: MidenErrorCode;
  message: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    test: (msg) =>
      msg.includes("_assertClass") || msg.includes("expected instance of"),
    code: "WASM_CLASS_MISMATCH",
    message:
      "WASM class identity mismatch. This usually means multiple copies of @miden-sdk/miden-sdk " +
      "are bundled. Ensure your bundler deduplicates the package. " +
      "For Vite: add resolve.dedupe and optimizeDeps.exclude for @miden-sdk/miden-sdk.",
  },
  {
    test: (msg) =>
      msg.includes("null pointer") ||
      msg.includes("already been freed") ||
      msg.includes("dereferencing a null"),
    code: "WASM_POINTER_CONSUMED",
    message:
      "WASM object was already consumed. Some WASM-bound objects can only be passed once — " +
      "if you need to reuse a value, create a fresh instance before each call.",
  },
  {
    test: (msg) =>
      msg.includes("not initialized") ||
      msg.includes("Cannot read properties of null"),
    code: "WASM_NOT_INITIALIZED",
    message:
      "Miden client is not initialized. Ensure you are inside a <MidenProvider> and the client is ready " +
      "before calling SDK methods.",
  },
  {
    test: (msg) =>
      msg.includes("state commitment mismatch") || msg.includes("stale state"),
    code: "WASM_SYNC_REQUIRED",
    message:
      "Account state is stale. Call sync() before executing transactions, or ensure no concurrent " +
      "transactions are running against the same account.",
  },
];

/**
 * Throws if the signer is disconnected.
 * No-op when signerConnected is `true` (connected) or `null` (no signer provider).
 */
export function assertSignerConnected(signerConnected: boolean | null): void {
  if (signerConnected === false) {
    throw new Error(
      "Signer is disconnected. Reconnect your wallet to perform transactions."
    );
  }
}

export function wrapWasmError(e: unknown): Error {
  if (e instanceof MidenError) return e;

  const msg = e instanceof Error ? e.message : String(e);
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return new MidenError(pattern.message, { cause: e, code: pattern.code });
    }
  }

  if (e instanceof Error) return e;
  return new Error(msg);
}
