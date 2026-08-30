// Import types needed for type references in the public API
import type {
  SyncSummary,
  TransactionProver,
  Account,
  AccountHeader,
  AccountId,
  AccountFile,
  AccountCode,
  AccountStorage,
  AssetVault,
  Word,
  Felt,
  TransactionId,
  TransactionRequest,
  TransactionRequestBuilder,
  TransactionResult,
  TransactionStoreUpdate,
  ProvenTransaction,
  TransactionSummary,
  ChainAnchor,
  TransactionRecord,
  InputNoteRecord,
  OutputNoteRecord,
  NoteId,
  NoteFile,
  NoteTag,
  Note,
  OutputNote,
  NoteExportFormat,
  StorageSlot,
  AccountComponent,
  Library,
  AuthSecretKey,
  AccountStorageRequirements,
  TransactionScript,
  NoteScript,
  NoteRecipient,
  NoteExecutionHint,
  NetworkAccountTarget,
  AdviceInputs,
  FeltArray,
  PswapLineageRecord,
} from "./crates/miden_client_web";

// Import the full namespace for the MidenArrayConstructors type
import type * as WasmExports from "./crates/miden_client_web";

// Source of truth for standalone-wrapper return types. By deriving them from
// the wasm-bindgen-generated namespace (rather than hand-writing `: Note`),
// the declarations below cannot drift from the actual runtime behavior — the
// exact class of bug behind #2042. Any forwarder-style wrapper should follow
// the same pattern: `ReturnType<WasmModule["Class"]["method"]>`.
type WasmModule = typeof import("./crates/miden_client_web");

// ════════════════════════════════════════════════════════════════
// Callback types for external keystore support
// ════════════════════════════════════════════════════════════════

export type GetKeyCallback = (
  pubKey: Uint8Array
) => Promise<Uint8Array | null | undefined> | Uint8Array | null | undefined;

export type InsertKeyCallback = (
  pubKey: Uint8Array,
  secretKey: Uint8Array
) => Promise<void> | void;

export type SignCallback = (
  pubKey: Uint8Array,
  signingInputs: Uint8Array
) => Promise<Uint8Array> | Uint8Array;

type MidenArrayConstructors = {
  [K in keyof typeof WasmExports as K extends `${string}Array`
    ? K
    : never]: (typeof WasmExports)[K];
};

export declare const MidenArrays: MidenArrayConstructors;

// ════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════

/**
 * User-friendly auth scheme constants for MidenClient options.
 * Use `AuthScheme.Falcon` or `AuthScheme.ECDSA` instead of raw strings.
 */
export declare const AuthScheme: {
  readonly Falcon: "falcon";
  readonly ECDSA: "ecdsa";
};

/**
 * Union of all values in the AuthScheme const.
 */
export type AuthSchemeType = (typeof AuthScheme)[keyof typeof AuthScheme];

/**
 * User-friendly note visibility constants.
 * Use `NoteVisibility.Public` or `NoteVisibility.Private` instead of raw strings.
 */
export declare const NoteVisibility: {
  readonly Public: "public";
  readonly Private: "private";
};

/** Union of valid NoteVisibility string values. */
export type NoteVisibility = "public" | "private";

/**
 * User-friendly storage mode constants.
 * Use `StorageMode.Public` or `StorageMode.Private` instead of raw strings.
 *
 * The `"network"` storage mode was removed in the migration to miden-client
 * PR #2214 — the 0.15 protocol surface no longer has a separate
 * network-account flag (network execution is now driven by the calling
 * surface, not the account's storage mode).
 */
export declare const StorageMode: {
  readonly Public: "public";
  readonly Private: "private";
};

/** Union of valid StorageMode string values. */
export type StorageMode = "public" | "private";

/**
 * Library linking mode for script compilation.
 * Use `Linking.Dynamic` or `Linking.Static` instead of raw strings.
 */
export declare const Linking: {
  readonly Dynamic: "dynamic";
  readonly Static: "static";
};

/** Union of valid Linking string values. */
export type Linking = "dynamic" | "static";

/**
 * Union of all values in the AccountType const.
 */
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

/**
 * Faucet-kind selectors for `accounts.create({ type })`.
 *
 * These are NOT the low-level WASM `AccountType` enum. As of protocol 0.15 that
 * enum encodes only account visibility (`Private` / `Public`), which the
 * low-level builder sets via `AccountBuilder.storageMode()`. Wallets and
 * contracts are not selected by a `type` value: a wallet is the default, and a
 * contract is any `accounts.create()` call that passes `components`.
 */
export declare const AccountType: {
  readonly FungibleFaucet: 0;
  readonly NonFungibleFaucet: 1;
};

/** Union of valid AccountType numeric values. */
export type AccountTypeValue = 0 | 1;

// ════════════════════════════════════════════════════════════════
// Client options
// ════════════════════════════════════════════════════════════════

export interface ClientOptions {
  /**
   * RPC endpoint. Accepts shorthands or a raw URL:
   * - `"testnet"` — Miden testnet RPC (`https://rpc.testnet.miden.io`)
   * - `"devnet"` — Miden devnet RPC (`https://rpc.devnet.miden.io`)
   * - `"localhost"` / `"local"` — local node (`http://localhost:57291`)
   * - any other string — treated as a raw RPC endpoint URL
   * Defaults to the SDK testnet RPC if omitted.
   */
  rpcUrl?: "testnet" | "devnet" | "localhost" | "local" | (string & {});
  /**
   * Note transport endpoint. Accepts shorthands or a raw URL:
   * - `"testnet"` — Miden testnet transport (`https://transport.miden.io`)
   * - `"devnet"` — Miden devnet transport (`https://transport.devnet.miden.io`)
   * - any other string — treated as a raw note transport endpoint URL
   */
  noteTransportUrl?: "testnet" | "devnet" | (string & {});
  /**
   * Prover to use for transactions. Accepts shorthands or a raw URL:
   * - `"local"` — local (in-browser) prover
   * - `"devnet"` — Miden devnet remote prover
   * - `"testnet"` — Miden testnet remote prover
   * - any other string — treated as a raw remote prover URL
   */
  proverUrl?: "local" | "devnet" | "testnet" | (string & {});
  /** Hashed to 32 bytes via SHA-256. */
  seed?: string | Uint8Array;
  /** Store isolation key. */
  storeName?: string;
  /** Sync state on creation (default: false). */
  autoSync?: boolean;
  /** External keystore callbacks. */
  keystore?: {
    getKey: GetKeyCallback;
    insertKey: InsertKeyCallback;
    sign: SignCallback;
  };
  /**
   * Enable the Web Worker shim that runs WASM calls off the main thread.
   * Defaults to `true` — leave it that way in browsers/extensions so the UI
   * stays responsive while WASM is busy.
   *
   * Set to `false` when:
   * - You pass a `CallbackProver` via `TransactionProver.newCallbackProver(jsFn)`.
   *   The worker boundary serializes the prover with `TransactionProver.serialize()`,
   *   which has no encoding for the callback variant and silently downgrades
   *   to `"local"` — your callback would never fire.
   * - You're embedding the client in a single-WebView native shell (iOS/Android
   *   Capacitor host, Tauri, Electron preload), where the UI thread isn't
   *   competing with the WASM thread anyway.
   */
  useWorker?: boolean;
}

// ════════════════════════════════════════════════════════════════
// Shared types
// ════════════════════════════════════════════════════════════════

/**
 * An account reference: hex string, bech32 string, Account, AccountHeader, or AccountId object.
 * All ID fields throughout the SDK accept any of these forms.
 */
export type AccountRef = string | Account | AccountHeader | AccountId;

/** Represents an amount of a specific token (identified by its faucet account). */
export interface Asset {
  /** Token identifier (faucet account ID). */
  token: AccountRef;
  /** Auto-converted to bigint internally. */
  amount: number | bigint;
}

/**
 * A note reference: hex note ID string, NoteId object, InputNoteRecord, or Note object.
 */
export type NoteInput = string | NoteId | Note | InputNoteRecord;

// ════════════════════════════════════════════════════════════════
// Account types
// ════════════════════════════════════════════════════════════════

/**
 * Create a wallet, faucet, or contract. A faucet sets `type`, a contract
 * passes `components`, and a wallet is the default (neither).
 */
export type CreateAccountOptions =
  | WalletCreateOptions
  | FaucetCreateOptions
  | ContractCreateOptions;

export interface WalletCreateOptions {
  storage?: StorageMode;
  auth?: AuthSchemeType;
  seed?: string | Uint8Array;
}

export interface FaucetCreateOptions {
  /** Use `AccountType.FungibleFaucet` or `AccountType.NonFungibleFaucet`. */
  type: AccountTypeValue;
  /** Human-readable token name. Defaults to `symbol` when omitted. */
  name?: string;
  symbol: string;
  decimals: number;
  maxSupply: number | bigint;
  storage?: StorageMode;
  auth?: AuthSchemeType;
}

export interface ContractCreateOptions {
  /** Raw 32-byte seed (Uint8Array). Required. */
  seed: Uint8Array;
  /** Auth secret key. Required. */
  auth: AuthSecretKey;
  /** Pre-compiled AccountComponent instances. Required for contracts. */
  components: AccountComponent[];
  /** Storage mode. Defaults to "public" for contracts. */
  storage?: StorageMode;
}

export interface AccountDetails {
  account: Account;
  vault: AssetVault;
  storage: AccountStorage;
  code: AccountCode | null;
  keys: Word[];
}

/**
 * Discriminated union for account import.
 *
 * - `AccountRef` (string, AccountId, Account, AccountHeader) — Import a public account by ID (fetches state from the network).
 * - `{ file: AccountFile }` — Import from a previously exported account file (works for both public and private accounts).
 * - `{ seed, auth? }` — Reconstruct a **public** account from its init seed. **Does not work for private accounts** — use the account file workflow instead.
 */
export type ImportAccountInput =
  | AccountRef
  | { file: AccountFile }
  | {
      seed: Uint8Array;
      auth?: AuthSchemeType;
    };

export interface InsertAccountOptions {
  /** The pre-built account to insert. */
  account: Account;
  /** Whether to overwrite an existing account with the same ID. Defaults to `false`. */
  overwrite?: boolean;
}

/** Options for accounts.export(). Exists for forward-compatible extensibility. */
export interface ExportAccountOptions {}

// ════════════════════════════════════════════════════════════════
// Transaction types
// ════════════════════════════════════════════════════════════════

/**
 * Mixin for the methods that take a caller-built `TransactionRequest`, letting
 * them execute against a pinned reference block instead of the current sync
 * height.
 *
 * Deliberately not part of {@link TransactionOptions}: `send`, `mint`,
 * `consume` and friends build their request internally, so a caller can never
 * hold an anchor captured for one.
 */
export interface AnchoredOptions {
  /**
   * A {@link ChainAnchor} from `transactions.captureAnchor(request)`, pinning
   * execution to the reference block the anchor was captured at.
   *
   * Since protocol 0.16 a signed transaction summary binds the reference block
   * commitment, so signatures only authorize an execution at that exact block.
   * Supplying the proposer's anchor is what makes the signed summary reproduce
   * on a client whose sync height has since advanced.
   *
   * When the anchor came from an untrusted party, compare `anchor.commitment()`
   * against an independently trusted value before using it.
   */
  anchor?: ChainAnchor;
}

export interface TransactionOptions {
  waitForConfirmation?: boolean;
  /**
   * Wall-clock polling timeout in milliseconds for waitFor() (default: 60_000).
   * This is NOT a block height. For block-height-based parameters, see
   * `reclaimAfter` and `timelockUntil` on SendOptions.
   */
  timeout?: number;
  /** Override default prover. */
  prover?: TransactionProver;
}

export interface SendOptionsDefault extends TransactionOptions {
  account: AccountRef;
  to: AccountRef;
  token: AccountRef;
  amount: number | bigint;
  type?: NoteVisibility;
  returnNote?: false;
  /** Block height after which the sender can reclaim the note. This is a block number, not wall-clock time. */
  reclaimAfter?: number;
  /** Block height until which the note is timelocked. This is a block number, not wall-clock time. */
  timelockUntil?: number;
}

export interface SendOptionsReturnNote extends TransactionOptions {
  account: AccountRef;
  to: AccountRef;
  token: AccountRef;
  amount: number | bigint;
  type?: NoteVisibility;
  returnNote: true;
}

/** @deprecated Use SendOptionsDefault or SendOptionsReturnNote instead */
export type SendOptions = SendOptionsDefault | SendOptionsReturnNote;

export interface SendResult {
  txId: TransactionId;
  note: Note | null;
  result: TransactionResult;
}

/**
 * Options for {@link TransactionsResource.createNetworkNote} and the standalone
 * {@link buildNetworkNote}. Builds a Public, custom-script note carrying a
 * `NetworkAccountTarget` attachment so a public network account auto-consumes it.
 *
 * Provide exactly one of `recipient` or `script`.
 */
export interface NetworkNoteOptions extends TransactionOptions {
  /** Account that creates, funds, and submits the note (the executing sender). */
  account: AccountRef;
  /**
   * The network account the note targets. Any account reference, or a pre-built
   * `NetworkAccountTarget`. Encoded as the note's `NetworkAccountTarget`
   * attachment — this is what makes `isNetworkNote()` true.
   */
  target: AccountRef | NetworkAccountTarget;
  /** Execution hint when `target` is an account reference. Defaults to `always`. */
  executionHint?: NoteExecutionHint;
  /**
   * Recipient carrying the note's custom consumption script. Build with
   * `new NoteRecipient(serialNum, noteScript, noteStorage)`, or omit and pass
   * `script` to have the recipient built for you.
   */
  recipient?: NoteRecipient;
  /** Custom consumption script; the recipient is built with a fresh serial number. */
  script?: NoteScript;
  /** Note storage / inputs the script reads (used with `script`). */
  inputs?: bigint[];
  /** Assets locked into the note. Optional — a note may carry no assets. */
  assets?: Asset | Asset[];
  /** Extra attachment payload appended AFTER the required `NetworkAccountTarget`. */
  attachment?: bigint[];
}

/** Result of {@link TransactionsResource.createNetworkNote}. */
export interface NetworkNoteResult {
  txId: TransactionId;
  /** The built network note (read its id / attachments). */
  note: Note;
  result: TransactionResult;
}

/** Result of methods that previously returned bare TransactionId. */
export interface TransactionSubmitResult {
  txId: TransactionId;
  result: TransactionResult;
}

export interface MintOptions extends TransactionOptions {
  /** Faucet (executing account). */
  account: AccountRef;
  /** Recipient account. */
  to: AccountRef;
  /** Amount to mint. */
  amount: number | bigint;
  /** Note visibility. Defaults to "public". */
  type?: NoteVisibility;
}

export interface BridgeOptions extends TransactionOptions {
  /** Account that creates and funds the bridge note (the sender / executing account). */
  account: AccountRef;
  /** Bridge account that consumes the note and burns the bridged asset. */
  bridgeAccount: AccountRef;
  /** Faucet / token ID of the fungible asset to bridge. */
  token: AccountRef;
  /** Amount of the asset to bridge. */
  amount: number | bigint;
  /** AggLayer-assigned network ID of the destination chain. */
  destinationNetwork: number;
  /** Destination Ethereum address on the destination network (0x-prefixed hex). */
  destinationAddress: string;
}

export interface ConsumeOptions extends TransactionOptions {
  account: AccountRef;
  notes: NoteInput | NoteInput[];
}

export interface ConsumeAllOptions extends TransactionOptions {
  account: AccountRef;
  maxNotes?: number;
}

/**
 * A single operation inside a transaction batch. The shape mirrors the
 * singular options types (`SendOptions`, `MintOptions`, ...) minus the
 * `account` field — the executing account is set once at the batch level
 * and shared by every operation (V1 single-account constraint).
 */
export type BatchOperation =
  | {
      kind: "send";
      to: AccountRef;
      token: AccountRef;
      amount: number | bigint;
      type?: NoteVisibility;
      reclaimAfter?: number;
      timelockUntil?: number;
    }
  | {
      kind: "mint";
      to: AccountRef;
      amount: number | bigint;
      type?: NoteVisibility;
    }
  | {
      kind: "consume";
      notes: NoteInput | NoteInput[];
    }
  | {
      kind: "swap";
      offer: Asset;
      request: Asset;
      type?: NoteVisibility;
      paybackType?: NoteVisibility;
    }
  | {
      kind: "execute";
      script: TransactionScript;
      foreignAccounts?: (
        | AccountRef
        | { id: AccountRef; storage?: AccountStorageRequirements }
      )[];
    }
  | {
      /** Escape hatch for pre-built TransactionRequests. */
      kind: "custom";
      request: TransactionRequest;
    };

export interface BatchOptions {
  /** The account executing every operation in the batch (single-account in V1). */
  account: AccountRef;
  /** Operations to execute atomically as a batch. Must be non-empty. */
  operations: BatchOperation[];
  /**
   * Wait until the batch's block has been observed in the local sync height.
   * Differs from singular `waitForConfirmation`: the V1 batch API returns
   * only a block number, so we poll chain height rather than per-tx status.
   */
  waitForConfirmation?: boolean;
  /** Wall-clock polling timeout for `waitForConfirmation` (default 60_000ms). */
  timeout?: number;
}

export interface BatchSubmitResult {
  /** The block number the batch was accepted into. */
  blockNumber: number;
}

/** Options for {@link TransactionExecution.prove}. */
export interface ProveOptions {
  /**
   * Per-call prover override. Falls back to the client's default prover, or
   * the built-in local prover if none is configured.
   *
   * A prover is consumed by the call — build (or clone) a fresh one per
   * `prove()`. Reusing an already-passed prover silently falls back to the
   * built-in local prover.
   */
  prover?: TransactionProver;
}

/**
 * A locally-executed transaction — nothing proven, submitted, or persisted yet.
 * First stage of the manual transaction lifecycle, returned by
 * {@link TransactionsResource.executeRequest}. Advance it with {@link prove}.
 */
export interface TransactionExecution {
  /** The raw execution artifact (account delta, output notes, …). */
  readonly result: TransactionResult;
  /** The executed transaction's id. */
  readonly id: TransactionId;
  /**
   * Prove this execution, then continue with {@link TransactionProof.submit}.
   * Pure computation — touches neither the network nor the local store.
   *
   * @param options - Optional per-call prover override.
   */
  prove(options?: ProveOptions): Promise<TransactionProof>;
}

/**
 * A proven transaction, ready for the network. Second stage of the manual
 * transaction lifecycle, returned by {@link TransactionExecution.prove}.
 * Advance it with {@link submit}.
 */
export interface TransactionProof {
  /** The raw proof — e.g. to serialize and submit from a different client. */
  readonly proof: ProvenTransaction;
  /** The execution result this proof was produced from. */
  readonly result: TransactionResult;
  /**
   * Submit the proof to the network, then persist with
   * {@link TransactionSubmission.apply}. Does NOT persist locally on its own.
   */
  submit(): Promise<TransactionSubmission>;
}

/**
 * A submitted transaction. Final stage of the manual transaction lifecycle,
 * returned by {@link TransactionProof.submit}. Persist it with {@link apply},
 * or block until it commits with {@link waitForConfirmation}.
 */
export interface TransactionSubmission {
  /** The block height the transaction was submitted at. */
  readonly blockNumber: number;
  /** The execution result that was submitted. */
  readonly result: TransactionResult;
  /**
   * Persist the transaction into the local store, firing registered
   * transaction observers (e.g. PSWAP lineage tracking). Until this runs the
   * local store is unaware of the transaction.
   *
   * @returns The pre-apply store update.
   */
  apply(): Promise<TransactionStoreUpdate>;
  /**
   * Poll local sync height until the transaction commits on-chain.
   *
   * @param options - Polling options (timeout, interval, onProgress).
   */
  waitForConfirmation(options?: WaitOptions): Promise<void>;
}

export interface SwapOptions extends TransactionOptions {
  account: AccountRef;
  offer: Asset;
  request: Asset;
  type?: NoteVisibility;
  paybackType?: NoteVisibility;
}

/**
 * Options for {@link TransactionsResource.pswapCreate}. V1 PSWAP notes carry
 * no attachment, so there is no `attachment` field.
 */
export interface PswapCreateOptions extends TransactionOptions {
  /** Account that creates the partial-swap (PSWAP) note. */
  account: AccountRef;
  /** Fungible asset offered by the creator. */
  offer: Asset;
  /** Fungible asset requested in exchange. */
  request: Asset;
  /** Visibility of the PSWAP note itself. */
  type?: NoteVisibility;
  /** Visibility of the payback note fillers emit to the creator. Defaults to `public`. */
  paybackType?: NoteVisibility;
}

export interface PswapConsumeOptions extends TransactionOptions {
  /** Consumer account filling the PSWAP note. */
  account: AccountRef;
  /** PSWAP note to consume — accepts a note id (hex), `NoteId`, `InputNoteRecord`, or `Note`. */
  note: NoteInput;
  /** Requested-asset amount the consumer supplies from its own vault; a partial amount emits a remainder PSWAP note. */
  fillAmount: number | bigint;
  /** Requested-asset amount supplied by other in-flight notes in the same tx. Defaults to `0`; leave unset normally. */
  noteFillAmount?: number | bigint;
}

export interface PswapCancelOptions extends TransactionOptions {
  /** Creator account reclaiming the offered asset. */
  account: AccountRef;
  /** PSWAP note to cancel — accepts a note id (hex), `NoteId`, `InputNoteRecord`, or `Note`. */
  note: NoteInput;
}

export interface PswapCancelByOrderOptions extends TransactionOptions {
  /**
   * Stable order id of the lineage to cancel, as reported by
   * {@link PswapLineageRecord.orderId}. Accepts the decimal string or a
   * `bigint`. `number` is rejected: a PSWAP order id is `u64`-shaped and
   * routinely exceeds `Number.MAX_SAFE_INTEGER`, which a JS `number` cannot
   * represent without silent precision loss. The creator account and current
   * tip note are resolved from the tracked lineage.
   */
  orderId: string | bigint;
}

export interface ExecuteOptions extends TransactionOptions {
  /** Account executing the custom script. */
  account: AccountRef;
  /** Compiled TransactionScript. */
  script: TransactionScript;
  /** Foreign accounts referenced by the script. */
  foreignAccounts?: (
    | AccountRef
    | { id: AccountRef; storage?: AccountStorageRequirements }
  )[];
}

export interface ExecuteProgramOptions {
  /** Account to execute the program against. */
  account: AccountRef;
  /** Compiled TransactionScript to execute. */
  script: TransactionScript;
  /** Advice inputs for the execution. Defaults to empty. */
  adviceInputs?: AdviceInputs;
  /** Foreign accounts referenced by the script. */
  foreignAccounts?: (
    | AccountRef
    | { id: AccountRef; storage?: AccountStorageRequirements }
  )[];
}

export interface PreviewSendOptions {
  operation: "send";
  account: AccountRef;
  to: AccountRef;
  token: AccountRef;
  amount: number | bigint;
  type?: NoteVisibility;
  reclaimAfter?: number;
  timelockUntil?: number;
}

export interface PreviewMintOptions {
  operation: "mint";
  account: AccountRef;
  to: AccountRef;
  amount: number | bigint;
  type?: NoteVisibility;
}

export interface PreviewBridgeOptions {
  operation: "bridge";
  account: AccountRef;
  bridgeAccount: AccountRef;
  token: AccountRef;
  amount: number | bigint;
  destinationNetwork: number;
  destinationAddress: string;
}

export interface PreviewConsumeOptions {
  operation: "consume";
  account: AccountRef;
  notes: NoteInput | NoteInput[];
}

export interface PreviewSwapOptions {
  operation: "swap";
  account: AccountRef;
  offer: Asset;
  request: Asset;
  type?: NoteVisibility;
  paybackType?: NoteVisibility;
}

export interface PreviewPswapCreateOptions {
  operation: "pswapCreate";
  account: AccountRef;
  offer: Asset;
  request: Asset;
  type?: NoteVisibility;
  paybackType?: NoteVisibility;
}

export interface PreviewPswapConsumeOptions {
  operation: "pswapConsume";
  account: AccountRef;
  note: NoteInput;
  fillAmount: number | bigint;
  noteFillAmount?: number | bigint;
}

export interface PreviewPswapCancelOptions {
  operation: "pswapCancel";
  account: AccountRef;
  note: NoteInput;
}

export interface PreviewCustomOptions extends AnchoredOptions {
  operation: "custom";
  account: AccountRef;
  request: TransactionRequest;
}

export type PreviewOptions =
  | PreviewSendOptions
  | PreviewMintOptions
  | PreviewBridgeOptions
  | PreviewConsumeOptions
  | PreviewSwapOptions
  | PreviewPswapCreateOptions
  | PreviewPswapConsumeOptions
  | PreviewPswapCancelOptions
  | PreviewCustomOptions;

/** Status values reported during waitFor polling. */
export type WaitStatus = "pending" | "submitted" | "committed";

export interface WaitOptions {
  /** Wall-clock polling timeout in ms (default: 60_000). Set to 0 to disable timeout and poll indefinitely. */
  timeout?: number;
  /** Polling interval in ms (default: 5_000). */
  interval?: number;
  onProgress?: (status: WaitStatus) => void;
}

/** Result of consumeAll — includes count of remaining notes for pagination. */
export interface ConsumeAllResult {
  txId: TransactionId | null;
  consumed: number;
  remaining: number;
  result?: TransactionResult;
}

/**
 * Discriminated union for transaction queries.
 * Mirrors the underlying WASM TransactionFilter enum.
 */
export type TransactionQuery =
  | { status: "uncommitted" }
  | { ids: (string | TransactionId)[] };

// ════════════════════════════════════════════════════════════════
// Note types
// ════════════════════════════════════════════════════════════════

/** Discriminated union for note queries. */
export type NoteQuery =
  | {
      status:
        | "consumed"
        | "committed"
        | "expected"
        | "processing"
        | "unverified";
    }
  | { ids: (string | NoteId)[] }
  /**
   * Filter received notes by note script root, given as hex strings or Word
   * instances (e.g. from `NoteScript.root()`). Notes match regardless of their
   * state. Only supported by `notes.list`; `notes.listSent` returns an empty
   * list for this query.
   */
  | { scriptRoots: (string | Word)[] };

/** Options for standalone note creation utilities. */
export interface NoteOptions {
  from: AccountRef;
  to: AccountRef;
  assets: Asset | [Asset, ...Asset[]];
  type?: NoteVisibility;
  attachment?: Felt[];
}

export interface P2IDEOptions extends NoteOptions {
  reclaimAfter?: number;
  timelockUntil?: number;
}

export interface ExportNoteOptions {
  /** Export format. Defaults to NoteExportFormat.Full. Use the NoteExportFormat enum. */
  format?: NoteExportFormat;
}

export interface SendPrivateOptions {
  /** The note to relay — a `Note`, or a note id/record resolved from this client's input notes. */
  note: NoteInput;
  /** The recipient. */
  to: AccountRef;
  /**
   * Block the recipient scans FORWARD from for the note's on-chain commitment. Must be at or below
   * the commitment block — a hint above it is never scanned back to, so the recipient silently
   * never receives the note. A safe, always-valid choice is the chain tip when the note's
   * transaction was submitted. For one of this client's own output notes, prefer `sendPrivateOutput`,
   * which derives this block for you.
   */
  scanAfterBlockNum: number;
}

export interface SendPrivateOutputOptions {
  /** Id of one of this client's own output notes (its transaction must have been applied). */
  noteId: NoteInput;
  /** The recipient. */
  to: AccountRef;
}

export interface MockOptions {
  seed?: string | Uint8Array;
  serializedMockChain?: Uint8Array;
  serializedNoteTransport?: Uint8Array;
}

// ════════════════════════════════════════════════════════════════
// Swap tag options
// ════════════════════════════════════════════════════════════════

export interface BuildSwapTagOptions {
  type?: NoteVisibility;
  offer: Asset;
  request: Asset;
}

// ════════════════════════════════════════════════════════════════
// Resource interfaces
// ════════════════════════════════════════════════════════════════

export interface AccountsResource {
  /**
   * Create a new wallet, faucet, or contract account. Defaults to a wallet
   * if no options are provided.
   *
   * @param options - Account creation options. A faucet sets `type`, a
   * contract passes `components`, and a wallet is the default.
   */
  create(options?: CreateAccountOptions): Promise<Account>;
  /**
   * Insert a pre-built account into the local store. Useful for external signer
   * integrations that construct accounts via `AccountBuilder` with custom auth commitments.
   *
   * @param options - Insert options.
   */
  insert(options: InsertAccountOptions): Promise<void>;
  /**
   * Retrieve an account by ID. Returns `null` if not found in the local store.
   *
   * @param accountId - The account to retrieve.
   */
  get(accountId: AccountRef): Promise<Account | null>;
  /**
   * Retrieve an account locally, or import it from the network if not found.
   *
   * @param accountId - The account to retrieve or import.
   */
  getOrImport(accountId: AccountRef): Promise<Account>;
  /**
   * List all accounts in the local store.
   */
  list(): Promise<AccountHeader[]>;
  /**
   * Retrieve detailed account information including vault, storage, code, and keys.
   *
   * @param accountId - The account to retrieve details for.
   */
  getDetails(accountId: AccountRef): Promise<AccountDetails>;
  /**
   * Get the balance of a specific token for an account.
   *
   * @param accountId - The account to check.
   * @param tokenId - The faucet account that identifies the token.
   */
  getBalance(accountId: AccountRef, tokenId: AccountRef): Promise<bigint>;

  /**
   * Import an account from the network by ID, from an exported file, or
   * reconstruct from a seed.
   *
   * @param input - Account reference, file, or seed-based import options.
   */
  import(input: ImportAccountInput): Promise<Account>;
  /**
   * Export an account to an {@link AccountFile} for backup or transfer.
   *
   * @param accountId - The account to export.
   * @param options - Export options (reserved for future use).
   */
  export(
    accountId: AccountRef,
    options?: ExportAccountOptions
  ): Promise<AccountFile>;

  /**
   * Associate a Bech32 address with an account.
   *
   * @param accountId - The account to add the address to.
   * @param address - The Bech32 address string.
   */
  addAddress(accountId: AccountRef, address: string): Promise<void>;
  /**
   * Remove a Bech32 address from an account.
   *
   * @param accountId - The account to remove the address from.
   * @param address - The Bech32 address string to remove.
   */
  removeAddress(accountId: AccountRef, address: string): Promise<void>;
}

export interface TransactionsResource {
  /**
   * Send tokens to another account by creating a pay-to-ID note. Set
   * `returnNote: true` to get the created note back.
   *
   * @param options - Send options including sender, recipient, token, and amount.
   */
  send(
    options: SendOptionsDefault
  ): Promise<{ txId: TransactionId; note: null; result: TransactionResult }>;
  send(
    options: SendOptionsReturnNote
  ): Promise<{ txId: TransactionId; note: Note; result: TransactionResult }>;
  send(options: SendOptions): Promise<SendResult>;
  /**
   * Mint new tokens from a faucet account.
   *
   * @param options - Mint options including the faucet, recipient, and amount.
   */
  mint(options: MintOptions): Promise<TransactionSubmitResult>;
  /**
   * Builds a Public custom-script note carrying a `NetworkAccountTarget`
   * attachment, submits it as an own output note, and (optionally) waits for
   * confirmation. The submitted note satisfies `Note.isNetworkNote()`, so a
   * public network account will auto-consume it.
   */
  createNetworkNote(options: NetworkNoteOptions): Promise<NetworkNoteResult>;
  /**
   * Bridge a fungible asset out to another network via the AggLayer. Emits a
   * single public B2AGG (Bridge-to-AggLayer) note that the bridge account
   * consumes, burning the asset so it can be claimed at the destination
   * Ethereum address on the destination network.
   *
   * @param options - Sender, bridge account, token, amount, and destination.
   */
  bridge(options: BridgeOptions): Promise<TransactionSubmitResult>;
  /**
   * Consume one or more notes for an account.
   *
   * @param options - Consume options including the account and notes to consume.
   */
  consume(options: ConsumeOptions): Promise<TransactionSubmitResult>;
  /**
   * Execute an atomic swap between two assets.
   *
   * @param options - Swap options including the account, offered asset, and requested asset.
   */
  swap(options: SwapOptions): Promise<TransactionSubmitResult>;
  /**
   * Create a partial-swap (PSWAP) note offering one fungible asset for
   * another. Unlike `swap`, the resulting note can be filled by multiple
   * consumers; each fill emits a payback note to the creator and, on a
   * partial fill, a remainder PSWAP note carrying the unfilled amount.
   *
   * @param options - Creator, offered asset, requested asset, and visibility.
   */
  pswapCreate(options: PswapCreateOptions): Promise<TransactionSubmitResult>;
  /**
   * Consume (fully or partially fill) an existing PSWAP note. The consumer
   * supplies `fillAmount` of the requested asset and receives a proportional
   * share of the offered asset. A full fill (`fillAmount` equal to the
   * note's requested amount) produces only the payback note; a partial fill
   * also produces a remainder PSWAP note.
   *
   * @param options - Consumer account, PSWAP note, and fill amount.
   */
  pswapConsume(options: PswapConsumeOptions): Promise<TransactionSubmitResult>;
  /**
   * Cancel a PSWAP note as the creator and reclaim the offered asset.
   *
   * @param options - Creator account and PSWAP note to cancel.
   */
  pswapCancel(options: PswapCancelOptions): Promise<TransactionSubmitResult>;
  /**
   * Consume all available notes for an account, up to an optional limit.
   * Returns the count of remaining notes for pagination.
   *
   * @param options - Options including the account and optional max notes limit.
   */
  consumeAll(options: ConsumeAllOptions): Promise<ConsumeAllResult>;
  /**
   * Execute a custom transaction script with optional foreign account references.
   *
   * @param options - Execute options including the account, compiled script, and foreign accounts.
   */
  execute(options: ExecuteOptions): Promise<TransactionSubmitResult>;

  /**
   * Dry-run a transaction to obtain the {@link TransactionSummary} the
   * account is being asked to authorize, without submitting anything to the
   * network.
   *
   * The summary only exists while authorization is pending: it is returned
   * when the account's auth procedure aborts with the unauthorized event
   * (e.g. a multisig below its signing threshold), so it can be signed
   * out-of-band. If the transaction is already fully authorized, execution
   * succeeds without producing a summary and this method rejects with an
   * error whose `code` is `"TRANSACTION_ALREADY_AUTHORIZED"` (on Node.js the
   * code prefixes the error message instead) — submit the transaction with
   * `execute` instead.
   *
   * To collect signatures over the summary and submit afterwards, preview with
   * `operation: "custom"` and pass the *same* `TransactionRequest` object to
   * both this call and the submission. Every other operation builds its request
   * from the options given, and two builds are not identical — output note
   * serial numbers and the fee conversion info's salt are both drawn from the
   * client's RNG — so the summary signed here would not be the summary the
   * submitted transaction produces.
   *
   * @param options - Preview options discriminated by `operation` field.
   */
  preview(options: PreviewOptions): Promise<TransactionSummary>;

  /**
   * Submit a pre-built TransactionRequest. Note: WASM requires accountId
   * separately, so `account` is the first argument.
   *
   * The request is yours, so paying protocol 0.16's verification fee is yours
   * too — build it from {@link MidenClient.feeAwareTransactionRequestBuilder}
   * rather than `new TransactionRequestBuilder()`, or it aborts with
   * `ERR_FEE_CONVERSION_INFO_MISSING` on a chain that charges one. Raises the
   * same fee error codes {@link executeRequest} does.
   *
   * @param account - The account executing the transaction.
   * @param request - The pre-built transaction request.
   * @param options - Optional transaction options (prover, confirmation, anchor).
   */
  submit(
    account: AccountRef,
    request: TransactionRequest,
    options?: TransactionOptions & AnchoredOptions
  ): Promise<TransactionSubmitResult>;

  /**
   * Capture a {@link ChainAnchor} at the current sync height for `request`,
   * pinning the reference block that a later execution can replay against.
   *
   * The anchor tracks the creation blocks of the request's authenticated input
   * notes, so it stays valid for that request once the chain advances. Pass it
   * back through the `anchor` option on {@link preview}, {@link executeRequest},
   * or {@link submit}; serialize it with `anchor.serialize()` to ship it
   * alongside a summary awaiting signatures.
   *
   * ```ts
   * const anchor  = await client.transactions.captureAnchor(request);
   * const summary = await client.transactions.preview({
   *   operation: "custom", account, request, anchor,
   * });
   * // ... collect signatures over `summary`, shipping `anchor.serialize()` ...
   * await client.transactions.submit(account, request, { anchor });
   * ```
   *
   * @throws An error with `code` `"INVALID_CHAIN_ANCHOR"` (on Node.js the code
   * prefixes the message instead) if a sync lands mid-capture and leaves the
   * anchor internally inconsistent. Retry.
   *
   * The caller owns the returned anchor. It carries a partial blockchain, so in
   * a flow that captures repeatedly, call `anchor.free()` once done rather than
   * leaving it to the finalizer.
   *
   * @param request - The request the anchor is captured for.
   * @returns An anchor pinned to the current sync height.
   */
  captureAnchor(request: TransactionRequest): Promise<ChainAnchor>;

  /**
   * Execute a transaction request locally — nothing is proven, submitted, or
   * persisted. Returns a {@link TransactionExecution} handle; advance the
   * lifecycle by chaining `.prove()` → `.submit()` → `.apply()`, benchmarking
   * or error-handling each stage independently:
   *
   * ```ts
   * const executed  = await client.transactions.executeRequest(account, request);
   * const proven    = await executed.prove({ prover });
   * const submitted = await proven.submit();
   * await submitted.apply();
   * ```
   *
   * {@link submit} runs every stage in one call. The stages are not atomic as a
   * group: awaiting other mutating calls on the same account between them can
   * interleave state — drive the chain as an uninterrupted sequence per account.
   *
   * The request is yours, so paying protocol 0.16's verification fee is yours
   * too — build it from {@link MidenClient.feeAwareTransactionRequestBuilder}
   * rather than `new TransactionRequestBuilder()`, or it aborts with
   * `ERR_FEE_CONVERSION_INFO_MISSING` on a chain that charges one.
   *
   * @param account - The account executing the transaction.
   * @param request - The pre-built transaction request.
   * @param options - Pass `anchor` to execute against a pinned reference block
   *   instead of the current sync height.
   * @returns A handle to the executed transaction, ready to prove.
   * @throws With `code: "FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN"` when
   *   `TransactionRequest.withAuthArg` replaced the auth argument a declared fee
   *   commitment lives in, leaving its preimage keyed by the old one.
   * @throws With `code: "FEE_CONVERSION_INFO_UNCLASSIFIABLE"` when the request
   *   declares fee conversion info and the account carries anything other than
   *   exactly one standard auth component, which miden-client cannot validate
   *   the declaration against.
   *
   *   Both codes arrive as an `error.code` property in the browser and as a
   *   `"CODE: "` prefix on the message under the Node bindings, which cannot
   *   attach a property. {@link preview} raises the same two.
   */
  executeRequest(
    account: AccountRef,
    request: TransactionRequest,
    options?: AnchoredOptions
  ): Promise<TransactionExecution>;

  /**
   * Submit a proof produced somewhere that shares nothing with this client —
   * e.g. a detached prover that never saw the local store. Returns a
   * {@link TransactionSubmission} handle; call `.apply()` on it to persist
   * locally. For the in-process flow prefer
   * `executeRequest(...)` → `.prove()` → `.submit()`, which threads the proof
   * and result for you.
   *
   * @param proof - A proof for `result`, proven elsewhere.
   * @param result - The matching execution result.
   * @returns A handle to the submitted transaction, ready to apply.
   */
  submitProven(
    proof: ProvenTransaction,
    result: TransactionResult
  ): Promise<TransactionSubmission>;

  /**
   * Execute a heterogeneous batch of operations against a single account.
   * Each operation is built, proven individually and as a batch, and all
   * operations are submitted atomically — either every tx in the batch
   * lands or none does.
   *
   * V1 supports only same-account batches (mirrors the underlying Rust
   * `Client::new_transaction_batch()` constraint).
   *
   * The named operations attach fee conversion info themselves; a request you
   * supply through the `custom` operation is subject to the fee checks
   * described on {@link submitBatch}, which this delegates to.
   *
   * @param options - Batch options including the account and operations.
   */
  batch(options: BatchOptions): Promise<BatchSubmitResult>;

  /**
   * Submit pre-built TransactionRequests as an atomic batch. Plural
   * counterpart of {@link submit} — for callers that already have built
   * requests in hand and want to skip the high-level operation builders.
   *
   * Fee conversion info is never attached for you here, but the batch is
   * checked before anything is proven. miden-client validates the same thing
   * while preparing the batch, so what this adds is timing: pushing a batch
   * proves each transaction as it goes, and a rejection discovered mid-push has
   * already cost the proofs ahead of it. A batch is rejected whole, before any
   * proving, when a request in it declares fee conversion info and either:
   *
   * - `TransactionRequest.withAuthArg` replaced the auth argument the
   *   commitment lives in, leaving its preimage keyed by the old one — error
   *   code `FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN`;
   * - the executing account's auth procedure pays the fee from the chain's
   *   native fee asset and discards auth arguments entirely, so the declared
   *   asset and rate would have no effect — error code
   *   `FEE_CONVERSION_INFO_IGNORED`. No-auth and network accounts are the two
   *   that do this; or
   * - the account carries anything other than exactly one standard auth
   *   component, so miden-client cannot validate the declaration against it —
   *   error code `FEE_CONVERSION_INFO_UNCLASSIFIABLE`, the same code
   *   {@link executeRequest} raises for it.
   *
   * The account's code is read once for the whole batch, not once per request,
   * since a batch is single-account by contract.
   *
   * @param account - The account executing every transaction in the batch.
   * @param requests - Pre-built transaction requests (must be non-empty).
   * @param options - Optional batch settings (waitForConfirmation, timeout, prover).
   */
  submitBatch(
    account: AccountRef,
    requests: TransactionRequest[],
    options?: Omit<BatchOptions, "account" | "operations">
  ): Promise<BatchSubmitResult>;

  /** Execute a program (view call) and return the resulting stack output. */
  executeProgram(options: ExecuteProgramOptions): Promise<FeltArray>;

  /**
   * List transactions, optionally filtered by status or IDs.
   *
   * Omitting `query`, or passing a shape this method does not recognise, returns every
   * stored transaction.
   *
   * @param query - Optional filter for transaction status or IDs.
   * @throws If `query` carries a defined `expiredBefore` and neither `status: "uncommitted"`
   * nor `ids` — the two shapes that outranked the expiry filter before it was removed.
   * That filter was removed upstream — expiry is decided during state sync — and silently
   * widening it to the unfiltered query would return a superset of what was asked for.
   * Compare {@link TransactionRecord.expirationBlockNum} against the height you care about
   * instead.
   */
  list(query?: TransactionQuery): Promise<TransactionRecord[]>;

  /**
   * Poll until a transaction is confirmed on-chain. Throws on rejection
   * or timeout.
   *
   * @param txId - The transaction ID to wait for.
   * @param options - Optional polling timeout, interval, and progress callback.
   */
  waitFor(txId: string | TransactionId, options?: WaitOptions): Promise<void>;
}

export interface PswapResource {
  /**
   * Returns every partial-swap (PSWAP) lineage tracked by this client. A
   * lineage records how a PSWAP note has been filled round by round, from the
   * original note through each remainder to the current tip.
   */
  lineages(): Promise<PswapLineageRecord[]>;
  /**
   * Returns the PSWAP lineages created by a specific local account.
   *
   * @param account - Creator account (hex, bech32, `Account`, or `AccountId`).
   */
  lineagesFor(account: AccountRef): Promise<PswapLineageRecord[]>;
  /**
   * Returns the lineage for a single order, or `null` if this client is not
   * tracking it — either because the order was not created by this client, or
   * because tracking did not register when it was created. Registration runs as
   * a transaction observer at create time and does not block the create
   * transaction if it fails.
   *
   * @param orderId - Stable order id (decimal string or bigint). `number` is
   *   rejected: a PSWAP order id is `u64`-shaped and routinely exceeds
   *   `Number.MAX_SAFE_INTEGER`, which a JS `number` cannot represent without
   *   silent precision loss.
   */
  lineage(orderId: string | bigint): Promise<PswapLineageRecord | null>;
  /**
   * Reclaim the unfilled offered asset on the current tip of an active
   * lineage, identified by its stable order id. Builds the cancel transaction,
   * resolves the creator account from the tracked lineage, and submits it
   * through the same prove/submit path as the other transaction helpers.
   * Throws if no lineage is tracked for the order.
   *
   * This is the one request-building path the SDK does not attach fee
   * conversion info to: miden-client builds the request internally from a bare
   * builder. On a chain whose `BlockHeader.verificationBaseFee()` is non-zero
   * that leaves the outcome to the creator's auth component — a single-sig
   * creator is rescued by miden-client's native injection and pays normally,
   * while a multisig or guarded-multisig creator fails with
   * `FeeConversionInfoRequired`. For those, cancel by note with
   * {@link TransactionsResource.pswapCancel}, which commits conversion info
   * against the creator before submitting.
   *
   * @param options - Order id and optional transaction options.
   */
  cancelByOrder(
    options: PswapCancelByOrderOptions
  ): Promise<TransactionSubmitResult>;
}

export interface NotesResource {
  /**
   * List received (input) notes, optionally filtered by status, IDs, or note
   * script roots.
   *
   * @param query - Optional filter by note status, note IDs, or script roots.
   */
  list(query?: NoteQuery): Promise<InputNoteRecord[]>;
  /**
   * Retrieve a note by ID. Returns `null` if not found.
   *
   * @param noteId - The note to retrieve.
   */
  get(noteId: NoteInput): Promise<InputNoteRecord | null>;

  /**
   * List sent (output) notes, optionally filtered by status or IDs. A script
   * root query returns an empty list, since script roots are only tracked for
   * received notes.
   *
   * @param query - Optional filter by note status or note IDs.
   */
  listSent(query?: NoteQuery): Promise<OutputNoteRecord[]>;

  /**
   * List notes that are available for consumption by a specific account.
   *
   * @param options - Options containing the account to check availability for.
   */
  listAvailable(options: { account: AccountRef }): Promise<InputNoteRecord[]>;

  /**
   * Import a note from a {@link NoteFile}.
   *
   * @param noteFile - The note file to import.
   * @returns The imported note's id (hex) when the file carries metadata (a
   *   note id or a full note with proof); for a details-only file, which has no
   *   note id yet, the note's details commitment (hex) is returned instead.
   *   In both cases the value is a hex string, not a `NoteId` object — pass it
   *   to {@link NoteId.fromHex} if a `NoteId` instance is required.
   */
  import(noteFile: NoteFile): Promise<string>;
  /**
   * Export a note to a {@link NoteFile} for transfer or backup.
   *
   * @param noteId - The note to export.
   * @param options - Optional export format options.
   */
  export(noteId: NoteInput, options?: ExportNoteOptions): Promise<NoteFile>;

  /**
   * Fetch private notes from the note transport service.
   *
   * Fetches incrementally: only notes past the stored pagination cursor are
   * downloaded. Historical notes for a newly tracked tag sit below that cursor
   * and are recovered automatically by {@link MidenClient.sync}, which
   * backfills each newly tracked tag.
   */
  fetchPrivate(): Promise<void>;
  /**
   * Relay a private note to a recipient via the note transport service, with an explicit block
   * hint (`scanAfterBlockNum`) the recipient scans forward from for the note's on-chain commitment.
   *
   * The hint must be at or below the commitment block; a hint above it is never scanned back to and
   * the recipient silently never receives the note. This is the agnostic form for relaying an
   * arbitrary note; for one of this client's own output notes prefer {@link NotesResource.sendPrivateOutput},
   * which derives the block from the note's stored expected height.
   *
   * @param options - The note, the recipient, and `scanAfterBlockNum`.
   */
  sendPrivate(options: SendPrivateOptions): Promise<void>;
  /**
   * Relay one of this client's own private output notes via the note transport service.
   *
   * The recipient's scan-start block is derived from the note's stored `expected_height` (the chain
   * tip when its transaction was submitted), so delivery is correct regardless of how far this
   * client has since synced past the note — a bare sync-height hint would overshoot the commitment
   * once the sender advances past it (e.g. relaying after waiting for commit) and silently drop
   * delivery. The note must exist in this client's store as an output note.
   *
   * @param options - The output note id and the recipient.
   */
  sendPrivateOutput(options: SendPrivateOutputOptions): Promise<void>;
}

// ════════════════════════════════════════════════════════════════
// Compiler types
// ════════════════════════════════════════════════════════════════

export interface CompileComponentOptions {
  /** MASM source code for the component. */
  code: string;
  /**
   * Module path used to derive procedure identities. Use the same namespace when
   * linking this component into transaction scripts.
   */
  namespace?: string;
  /** Initial storage slots for the component. */
  slots?: StorageSlot[];
  /**
   * When true, the component accepts all input types for Falcon-signed
   * transactions by automatically adding `exec.auth::auth_tx_rpo_falcon512`
   * to a library context. Default: true.
   *
   * **BREAKING (v0.12):** This flag was added in v0.12 and defaults to `true`.
   * Set to `false` if you compile a component that already includes its own
   * auth transaction kernel invocation or intentionally omits one.
   */
  supportAllTypes?: boolean;
}

export interface CompileTxScriptLibrary {
  /** MASM namespace for the library (e.g. "counter::module"). */
  namespace: string;
  /** MASM source code for the library. */
  code: string;
  /**
   * `Linking.Dynamic` (default) — procedures are linked via DYNCALL at runtime.
   * `Linking.Static` — procedures are inlined at compile time.
   */
  linking?: Linking;
}

/** Links the exact compiled code installed by an account component. */
export interface CompileAccountComponentLibrary {
  /** Account component whose installed code should be linked. */
  component: AccountComponent;
  /**
   * `Linking.Dynamic` (default) — procedures are linked via DYNCALL at runtime.
   * `Linking.Static` — procedures are inlined at compile time.
   */
  linking?: Linking;
}

/** A script library supplied inline, pre-built, or from an installed account component. */
export type CompileScriptLibrary =
  | CompileTxScriptLibrary
  | CompileAccountComponentLibrary
  | Library;

export interface CompileTxScriptOptions {
  /** MASM source code for the transaction script. */
  code: string;
  /** Component libraries to link. */
  libraries?: CompileScriptLibrary[];
}

export interface CompileNoteScriptOptions {
  /** MASM source code for the note script. */
  code: string;
  /** Component libraries to link. */
  libraries?: CompileScriptLibrary[];
}

export declare class CompilerResource {
  /**
   * Create a standalone `CompilerResource` over a WASM `WebClient` proxy.
   *
   * Normally accessed as `client.compile` on a `MidenClient`; construct
   * directly only when you need the compiler surface without the full
   * `MidenClient` wrapper (e.g. inside a framework-specific hook).
   *
   * @param inner - The WASM `WebClient` (e.g. the `WasmWebClient` proxy).
   * @param getWasm - Async accessor for the WASM module, used to reach
   *   `AccountComponent.compile` at runtime. `getWasmOrThrow` satisfies this.
   * @param client - Optional wrapper with `assertNotTerminated()`; used
   *   internally by `MidenClient` and may be omitted by external callers.
   */
  constructor(
    inner: WasmExports.WebClient,
    getWasm: () => Promise<typeof WasmExports>,
    client?: { assertNotTerminated(): void } | null
  );

  /**
   * Compile MASM source into an AccountComponent.
   *
   * @param options - Component source code, storage slots, and auth options.
   */
  component(options: CompileComponentOptions): Promise<AccountComponent>;
  /**
   * Compile MASM source into a TransactionScript.
   *
   * @param options - Script source code and optional libraries to link.
   */
  txScript(options: CompileTxScriptOptions): Promise<TransactionScript>;
  /**
   * Compile MASM source into a NoteScript.
   *
   * @param options - Script source code and optional libraries to link.
   */
  noteScript(options: CompileNoteScriptOptions): Promise<NoteScript>;
}

export interface TagsResource {
  /**
   * Add a note tag to listen for during sync.
   *
   * @param tag - The numeric note tag to register.
   */
  add(tag: number): Promise<void>;
  /**
   * Remove a note tag so it is no longer tracked during sync.
   *
   * @param tag - The numeric note tag to unregister.
   */
  remove(tag: number): Promise<void>;
  /**
   * List all registered note tags.
   */
  list(): Promise<number[]>;
}

export interface SettingsResource {
  /**
   * Get a setting value by key. Returns `null` if not found.
   *
   * @param key - The setting key.
   */
  get<T = unknown>(key: string): Promise<T | null>;
  /**
   * Set a setting value.
   *
   * @param key - The setting key.
   * @param value - The value to store.
   */
  set(key: string, value: unknown): Promise<void>;
  /**
   * Remove a setting.
   *
   * @param key - The setting key to remove.
   */
  remove(key: string): Promise<void>;
  /**
   * List all setting keys.
   */
  listKeys(): Promise<string[]>;
}

export interface KeystoreResource {
  /** Inserts a secret key into the keystore, associating it with the given account ID. */
  insert(accountId: AccountId, secretKey: AuthSecretKey): Promise<void>;
  /** Retrieves a secret key by its public key commitment. Returns null if not found. */
  get(pubKeyCommitment: Word): Promise<AuthSecretKey | null>;
  /** Removes a key from the keystore by its public key commitment. */
  remove(pubKeyCommitment: Word): Promise<void>;
  /** Returns all public key commitments associated with the given account ID. */
  getCommitments(accountId: AccountId): Promise<Word[]>;
  /** Returns the account ID associated with a public key commitment, or null if not found. */
  getAccountId(pubKeyCommitment: Word): Promise<AccountId | null>;
}

// ════════════════════════════════════════════════════════════════
// MidenClient
// ════════════════════════════════════════════════════════════════

export declare class MidenClient {
  /** Creates and initializes a new MidenClient. */
  static create(options?: ClientOptions): Promise<MidenClient>;
  /** Creates a client preconfigured for testnet (rpc, prover, note transport, autoSync). */
  static createTestnet(options?: ClientOptions): Promise<MidenClient>;
  /** Creates a client preconfigured for devnet (rpc, prover, note transport, autoSync). */
  static createDevnet(options?: ClientOptions): Promise<MidenClient>;
  /** Creates a mock client for testing. */
  static createMock(options?: MockOptions): Promise<MidenClient>;
  /**
   * Resolves once the WASM module is initialized and safe to use.
   *
   * Idempotent and shared across callers — concurrent invocations await the
   * same in-flight promise, and post-init callers resolve immediately.
   * Primarily useful on the `/lazy` entry (Next.js / Capacitor) where no
   * top-level await runs at import time; harmless on the eager entry.
   */
  static ready(): Promise<void>;

  readonly accounts: AccountsResource;
  readonly transactions: TransactionsResource;
  readonly notes: NotesResource;
  readonly tags: TagsResource;
  readonly settings: SettingsResource;
  readonly compile: CompilerResource;
  readonly keystore: KeystoreResource;
  readonly pswap: PswapResource;

  /** Syncs the client: fetches private notes from the Note Transport Layer, then syncs on-chain state. Fails fast on either. */
  sync(): Promise<SyncSummary>;
  /** Syncs on-chain state only (no NTL fetch). */
  syncChain(): Promise<SyncSummary>;
  /** Fetches private notes from the Note Transport Layer. */
  syncNoteTransport(): Promise<void>;
  /** Returns the current sync height. */
  getSyncHeight(): Promise<number>;
  /**
   * Resolves once every serialized WASM call that was already on the
   * internal call chain when `waitForIdle()` was called (execute, submit,
   * prove, apply, sync, or account creation) has settled. Use this from
   * callers that need to perform a non-WASM-side action — e.g. clearing
   * an in-memory auth key on wallet lock — after the kernel finishes, so
   * its auth callback doesn't race with the key being cleared. Does NOT
   * wait for calls enqueued after `waitForIdle()` returns.
   *
   * Caveat for `sync`: a `syncState` blocked on its sync lock (Web
   * Locks) has not yet reached the internal chain, so `waitForIdle`
   * does not await it. Other serialized methods are always observed.
   *
   * Returns immediately if nothing was in flight.
   */
  waitForIdle(): Promise<void>;
  /**
   * Returns the raw JS value that the most recent sign-callback invocation
   * threw, or `null` if the last sign call succeeded (or no call has
   * happened yet). Useful for recovering structured metadata (e.g. a
   * `reason: 'locked'` property) that the kernel-level `auth::request`
   * diagnostic would otherwise erase.
   *
   * Meaningful only with `useWorker: false` (the worker shim's keystore
   * lives in the worker WASM instance, so this reads `null` there). On
   * the Node.js binding it always returns `null` — signing goes through
   * the filesystem keystore, never a JS callback.
   */
  lastAuthError(): unknown;
  /** Returns the client-level default prover. */
  readonly defaultProver: TransactionProver | null;
  /** Terminates the underlying Web Worker. After this, all method calls throw. */
  terminate(): void;

  /** Returns the identifier of the underlying store (e.g. IndexedDB database name, file path). */
  storeIdentifier(): Promise<string>;

  /**
   * Returns a `TransactionRequestBuilder` that already carries the chain's fee
   * conversion info for the account that will execute the request.
   *
   * Since protocol 0.16 the verification fee is paid inside the account's auth
   * procedure, and `fee::pay_fee` requires the transaction's auth argument to
   * be `hash(CONVERSION_INFO || SALT)` with the preimage reachable in the
   * advice map. A request assembled from `new TransactionRequestBuilder()`
   * carries neither, and what happens then depends on the executing account:
   *
   * - **Single-sig** — miden-client injects native 1:1 conversion info for you
   *   when the auth argument is empty, so the transaction pays and nothing
   *   fails. Using this method changes only *which* asset and rate are
   *   committed, and lets you set the salt.
   * - **Multisig and guarded multisig** — miden-client refuses to guess, and
   *   the transaction fails with `FeeConversionInfoRequired` naming the
   *   component. This method is what makes those accounts work at all on a
   *   fee-charging chain.
   * - **A custom auth procedure that reads conversion info** — nothing injects
   *   anything, and the transaction aborts in the VM with
   *   `ERR_FEE_CONVERSION_INFO_MISSING`.
   *
   * The `new*TransactionRequest` constructors attach it, and so does every
   * `client.transactions` operation that builds its own request — but the ones
   * that take a request from you (`submit`, `executeRequest`, `submitBatch`,
   * and the `custom` operation of `batch` / `preview`) never attach it for you,
   * so those are exactly the paths this method exists for.
   *
   * `account` is the account that **executes** the request — the one whose
   * auth procedure pays the fee — not the recipient or a note's sender.
   *
   * Safe as a drop-in: the info is attached only when the chain charges a fee
   * *and* the executing account's auth component can read it. A no-auth or
   * network account pays the fee natively and miden-client rejects a request
   * that declares conversion info against one, so for those — and on any
   * zero-fee chain — the builder comes back untouched and the request is
   * byte-identical to one built from a bare builder.
   *
   * Calling `withAuthArg` on the result overwrites the auth argument the
   * commitment lives in, so `build()` refuses it with error code
   * `FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN`. Build one request per auth
   * argument, or call `withFeeConversionInfo` last — it writes the commitment
   * and its preimage together, so it wins outright.
   *
   * @param account - The account that will execute the request.
   *
   * @example
   * ```js
   * const builder = await client.feeAwareTransactionRequestBuilder(wallet);
   * const request = builder.withCustomScript(script).build();
   * ```
   */
  feeAwareTransactionRequestBuilder(
    account: AccountRef
  ): Promise<TransactionRequestBuilder>;

  /** Advances the mock chain by one block. Only available on mock clients. */
  proveBlock(): Promise<void>;
  /** Returns true if this client uses a mock chain. */
  usesMockChain(): boolean;
  /** Serializes the mock chain state for snapshot/restore in tests. */
  serializeMockChain(): Promise<Uint8Array>;
  /** Serializes the mock note transport node state. */
  serializeMockNoteTransportNode(): Promise<Uint8Array>;

  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

// ════════════════════════════════════════════════════════════════
// Standalone utilities (tree-shakeable)
// ════════════════════════════════════════════════════════════════

/** Creates a P2ID (Pay-to-ID) note. */
export declare function createP2IDNote(
  options: NoteOptions
): ReturnType<WasmModule["Note"]["createP2IDNote"]>;

/** Creates a P2IDE (Pay-to-ID with Expiration) note. */
export declare function createP2IDENote(
  options: P2IDEOptions
): ReturnType<WasmModule["Note"]["createP2IDENote"]>;

/**
 * Builds (without submitting) a Public custom-script note carrying a
 * `NetworkAccountTarget` attachment. Provide exactly one of `recipient` or
 * `script`.
 */
export declare function buildNetworkNote(opts: NetworkNoteOptions): Note;

/** Builds a swap tag for note matching. Returns a NoteTag (use `.asU32()` for the numeric value). */
export declare function buildSwapTag(
  options: BuildSwapTagOptions
): ReturnType<WasmModule["WebClient"]["buildSwapTag"]>;

/** Exports the entire contents of an IndexedDB store as a JSON string. */
export declare function exportStore(storeName: string): Promise<string>;

/** Imports store contents from a JSON string, replacing all existing data. */
export declare function importStore(
  storeName: string,
  storeDump: string
): Promise<void>;

/** Returns the initialized WASM module. Throws if WASM is unavailable. */
export declare function getWasmOrThrow(): Promise<typeof WasmExports>;
