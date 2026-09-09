import { AuthScheme } from "@miden-sdk/miden-sdk";
import type { AccountRef } from "../utils/accountParsing";
import type { TransactionRequestInput } from "../utils/transactions";
import type {
  WasmWebClient as WebClient,
  Account,
  AccountHeader,
  AccountId,
  AccountFile,
  InputNoteRecord,
  ConsumableNoteRecord,
  TransactionFilter,
  TransactionId,
  TransactionRecord,
  TransactionRequest,
  TransactionScript,
  TransactionSummary,
  ChainAnchor,
  AdviceInputs,
  AccountStorageRequirements,
  NoteType,
  NoteId,
  AccountStorageMode,
  Note,
  NoteInput,
  NoteVisibility,
  NoteExecutionHint,
  NoteRecipient,
  NoteScript,
  StorageMode,
  PswapLineageRecord,
} from "@miden-sdk/miden-sdk";

// Re-export SDK types for convenience
export { AuthScheme };
export type {
  WebClient,
  Account,
  AccountHeader,
  AccountId,
  AccountFile,
  InputNoteRecord,
  ConsumableNoteRecord,
  TransactionFilter,
  TransactionId,
  TransactionRecord,
  TransactionRequest,
  TransactionSummary,
  ChainAnchor,
  NoteType,
  Note,
  AccountStorageMode,
  PswapLineageRecord,
};

export type { AccountRef } from "../utils/accountParsing";

// Re-export signer types for external signer providers
export type {
  SignCallback,
  SignerAccountType,
  SignerAccountConfig,
  SignerContextValue,
} from "../context/SignerContext";

export type RpcUrlConfig =
  | string
  | "devnet"
  | "testnet"
  | "localhost"
  | "local";

/** Single prover target — a well-known name, custom URL, or object with URL + timeout. */
export type ProverTarget =
  | "local"
  | "localhost"
  | "devnet"
  | "testnet"
  | string
  | {
      url: string;
      timeoutMs?: number | bigint;
    };

export type ProverConfig =
  | ProverTarget
  | {
      /** Primary prover to try first */
      primary: ProverTarget;
      /** Fallback prover if primary fails (e.g. "local") */
      fallback?: ProverTarget;
      /** Return true to skip the fallback (e.g. on mobile where local proving is too slow) */
      disableFallback?: () => boolean;
      /** Called when the primary prover fails and the fallback is used */
      onFallback?: () => void;
    };

export type ProverUrls = {
  devnet?: string;
  testnet?: string;
};

// Provider configuration
export interface MidenConfig {
  /** RPC node URL or network name (devnet/testnet/localhost). Defaults to testnet. */
  rpcUrl?: RpcUrlConfig;
  /** Note transport URL for streaming notes. */
  noteTransportUrl?: string;
  /** Auto-sync interval in milliseconds. Set to 0 to disable. Default: 15000ms */
  autoSyncInterval?: number;
  /** Initial seed for deterministic RNG (must be 32 bytes if provided) */
  seed?: Uint8Array;
  /** Transaction prover selection (local/devnet/testnet or a remote URL). */
  prover?: ProverConfig;
  /** Optional override URLs for network provers. */
  proverUrls?: ProverUrls;
  /** Default timeout for remote prover requests in milliseconds. */
  proverTimeoutMs?: number | bigint;
  /**
   * Enable the Web Worker shim that runs WASM calls off the main thread.
   * Defaults to `true` — leave it that way in browsers/extensions so the UI
   * stays responsive while WASM is busy.
   *
   * Set to `false` when:
   * - You pass a `CallbackProver` (e.g. a native iOS/Android prover via
   *   a Capacitor plugin). The worker boundary serializes the prover with
   *   `TransactionProver.serialize()`, which has no encoding for the
   *   callback variant and silently downgrades to `"local"` — your
   *   callback would never fire.
   * - You're embedding the client in a single-WebView native shell
   *   (Capacitor host, Tauri, Electron preload), where the UI thread
   *   isn't competing with the WASM thread anyway.
   */
  useWorker?: boolean;
}

// Provider state
export interface MidenState {
  client: WebClient | null;
  isReady: boolean;
  isInitializing: boolean;
  error: Error | null;
}

// Transaction stages for mutation hooks
export type TransactionStage =
  | "idle"
  | "executing"
  | "proving"
  | "submitting"
  | "complete";

// Query hook result pattern
export interface QueryResult<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

// Mutation hook result pattern
export interface MutationResult<TData, TVariables> {
  mutate: (variables: TVariables) => Promise<TData>;
  data: TData | null;
  isLoading: boolean;
  stage: TransactionStage;
  error: Error | null;
  reset: () => void;
}

// Sync state
export interface SyncState {
  syncHeight: number;
  isSyncing: boolean;
  lastSyncTime: number | null;
  error: Error | null;
}

// Account types
export interface AccountsResult {
  accounts: AccountHeader[];
  /**
   * @deprecated Protocol 0.15 removed faucet-vs-wallet from the account id, so
   * accounts can no longer be split from headers alone. `wallets` mirrors
   * `accounts`. Use `accounts` and detect faucets per-account from its components.
   */
  wallets: AccountHeader[];
  /**
   * @deprecated Always empty as of protocol 0.15 (see `wallets`). Detect faucets
   * per-account from its components instead.
   */
  faucets: AccountHeader[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export interface AccountResult {
  account: Account | null;
  assets: AssetBalance[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  getBalance: (assetId: string) => bigint;
}

export interface AssetBalance {
  assetId: string;
  amount: bigint;
  symbol?: string;
  decimals?: number;
}

// Notes types
export interface NotesFilter {
  status?: "all" | "consumed" | "committed" | "expected" | "processing";
  accountId?: AccountRef;
  /** Only notes from this sender (any format, normalized internally) */
  sender?: string;
  /** Exclude these note IDs */
  excludeIds?: string[];
}

export interface NotesResult {
  notes: InputNoteRecord[];
  consumableNotes: ConsumableNoteRecord[];
  noteSummaries: NoteSummary[];
  consumableNoteSummaries: NoteSummary[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export type TransactionStatus = "pending" | "committed" | "discarded";

export interface TransactionHistoryOptions {
  /** Single transaction ID to look up. */
  id?: string | TransactionId;
  /** List of transaction IDs to look up. */
  ids?: Array<string | TransactionId>;
  /** Custom transaction filter (overrides id/ids). */
  filter?: TransactionFilter;
  /** Refresh after provider syncs. Default: true */
  refreshOnSync?: boolean;
}

export interface TransactionHistoryResult {
  records: TransactionRecord[];
  /** Convenience record when a single ID is provided. */
  record: TransactionRecord | null;
  /** Convenience status when a single ID is provided. */
  status: TransactionStatus | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export interface AssetMetadata {
  assetId: string;
  symbol?: string;
  decimals?: number;
}

export interface NoteAsset {
  assetId: string;
  amount: bigint;
  symbol?: string;
  decimals?: number;
}

export interface NoteSummary {
  id: string;
  assets: NoteAsset[];
  sender?: string;
}

// Wallet creation options
export interface CreateWalletOptions {
  /** Storage mode. Default: private */
  storageMode?: StorageMode;
  /** Auth scheme. Default: AuthScheme.AuthRpoFalcon512 */
  authScheme?: AuthScheme;
  /** Initial seed for deterministic account ID */
  initSeed?: Uint8Array;
}

// Faucet creation options
export interface CreateFaucetOptions {
  /** Token symbol (e.g., "TEST") */
  tokenSymbol: string;
  /** Human-readable token name. Defaults to `tokenSymbol` when omitted. */
  tokenName?: string;
  /** Number of decimals. Default: 8 */
  decimals?: number;
  /** Maximum supply */
  maxSupply: bigint | number;
  /** Storage mode. Default: private */
  storageMode?: StorageMode;
  /** Auth scheme. Default: AuthScheme.AuthRpoFalcon512 */
  authScheme?: AuthScheme;
}

// Account import options
export type ImportAccountOptions =
  | {
      type: "file";
      file: AccountFile | Uint8Array | ArrayBuffer;
    }
  | {
      type: "id";
      accountId: AccountRef;
    }
  | {
      type: "seed";
      seed: Uint8Array;
      authScheme?: AuthScheme;
    };

// Send options
export interface SendOptions {
  /** Sender account ID */
  from: AccountRef;
  /** Recipient account ID */
  to: AccountRef;
  /** Asset ID to send (token id) */
  assetId: AccountRef;
  /** Amount to send (ignored when sendAll is true) */
  amount?: bigint | number;
  /** Note type. Default: private */
  noteType?: NoteVisibility;
  /** Block height after which sender can reclaim note */
  recallHeight?: number;
  /** Block height after which recipient can consume note */
  timelockHeight?: number;
  /** Arbitrary data payload attached to the note */
  attachment?: bigint[] | Uint8Array | number[];
  /** Skip auto-sync before send. Default: false */
  skipSync?: boolean;
  /** Send the full balance of this asset. When true, amount is ignored. */
  sendAll?: boolean;
  /** true = build note in JS and return the Note object (e.g. for out-of-band delivery). Default: false */
  returnNote?: boolean;
}

// Send result — txId always set; note is non-null only when returnNote is true
export interface SendResult {
  txId: string;
  note: Note | null;
}

export interface MultiSendRecipient {
  /** Recipient account ID */
  to: AccountRef;
  /** Amount to send */
  amount: bigint | number;
  /** Per-recipient note type override */
  noteType?: "private" | "public";
  /** Per-recipient attachment */
  attachment?: bigint[] | Uint8Array | number[];
}

export interface MultiSendOptions {
  /** Sender account ID */
  from: AccountRef;
  /** Asset ID to send (token id) */
  assetId: AccountRef;
  /** Recipient list */
  recipients: MultiSendRecipient[];
  /** Default note type for all recipients. Default: private */
  noteType?: NoteVisibility;
  /** Skip auto-sync before send. Default: false */
  skipSync?: boolean;
}

export interface WaitForCommitOptions {
  /** Timeout in milliseconds. Default: 10000 */
  timeoutMs?: number;
  /** Polling interval in milliseconds. Default: 1000 */
  intervalMs?: number;
}

export interface WaitForNotesOptions {
  /** Account ID to check for consumable notes */
  accountId: AccountRef;
  /** Minimum number of notes to wait for. Default: 1 */
  minCount?: number;
  /** Timeout in milliseconds. Default: 10000 */
  timeoutMs?: number;
  /** Polling interval in milliseconds. Default: 1000 */
  intervalMs?: number;
}

// Mint options
export interface MintOptions {
  /** Target account to receive minted tokens */
  targetAccountId: AccountRef;
  /** Faucet account to mint from */
  faucetId: AccountRef;
  /** Amount to mint */
  amount: bigint | number;
  /** Note type. Default: private */
  noteType?: NoteVisibility;
}

// Create-network-note options
export interface CreateNetworkNoteOptions {
  /** Account that creates, funds, and submits the note (executing sender). */
  accountId: AccountRef;
  /** The network account the note targets. */
  target: AccountRef;
  /** Execution hint. Defaults to `always`. */
  executionHint?: NoteExecutionHint;
  /** Recipient carrying the custom script (advanced; else pass `script`). */
  recipient?: NoteRecipient;
  /** Custom consumption script; the recipient is built for you. */
  script?: NoteScript;
  /** Note storage / inputs the script reads (used with `script`). */
  inputs?: bigint[];
  /** Single asset to lock into the note. Optional — omit for a zero-asset note. */
  assetId?: AccountRef;
  /** Amount for `assetId`. */
  amount?: bigint | number;
  /** Extra attachment payload appended after the NetworkAccountTarget. */
  attachment?: bigint[] | Uint8Array | number[];
}

// Create-network-note result — mirrors SendResult (txId + built note)
export interface NetworkNoteResult {
  txId: string;
  note: Note;
}

// Bridge (AggLayer bridge-out) options
export interface BridgeOptions {
  /** Account that creates and funds the bridge note (the sender) */
  from: AccountRef;
  /** Bridge account that consumes the note and burns the bridged assets */
  bridgeAccount: AccountRef;
  /** Faucet/token ID of the fungible asset to bridge */
  assetId: AccountRef;
  /** Amount of the asset to bridge */
  amount: bigint | number;
  /** AggLayer-assigned network ID of the destination chain */
  destinationNetwork: number;
  /** Destination Ethereum address on the destination network (0x-prefixed hex) */
  destinationAddress: string;
  /** Skip auto-sync after bridging. Default: false */
  skipSync?: boolean;
}

// Consume options
export interface ConsumeOptions {
  /** Account ID that will consume the notes */
  accountId: string;
  /** Notes to consume — accepts note IDs (hex strings), NoteId objects, InputNoteRecord, or Note objects */
  notes: (string | NoteId | InputNoteRecord | Note)[];
}

// Swap options
export interface SwapOptions {
  /** Account initiating the swap */
  accountId: AccountRef;
  /** Faucet ID of the offered asset */
  offeredFaucetId: AccountRef;
  /** Amount being offered */
  offeredAmount: bigint | number;
  /** Faucet ID of the requested asset */
  requestedFaucetId: AccountRef;
  /** Amount being requested */
  requestedAmount: bigint | number;
  /** Note type for swap note. Default: private */
  noteType?: NoteVisibility;
  /** Note type for payback note. Default: private */
  paybackNoteType?: NoteVisibility;
}

// PSWAP options — partial-swap notes can be filled by multiple consumers.
export interface PswapCreateOptions {
  /** Account that creates the PSWAP note */
  accountId: AccountRef;
  /** Faucet ID of the offered asset */
  offeredFaucetId: AccountRef;
  /** Amount being offered */
  offeredAmount: bigint | number;
  /** Faucet ID of the requested asset */
  requestedFaucetId: AccountRef;
  /** Amount being requested */
  requestedAmount: bigint | number;
  /** Visibility of the PSWAP note. Default: private */
  noteType?: NoteVisibility;
  /** Visibility of the payback note. Default: private */
  paybackNoteType?: NoteVisibility;
}

export interface PswapConsumeOptions {
  /** Consumer account filling the PSWAP note */
  accountId: AccountRef;
  /**
   * PSWAP note to consume. Accepts a hex string ID, `NoteId` object,
   * `InputNoteRecord`, or `Note` — string/NoteId values are looked up from
   * the local store; record/Note values are used directly.
   */
  note: NoteInput;
  /**
   * Amount of the requested asset the consumer is providing from its own
   * vault. Receives a proportional share of the offered asset; partial fills
   * also produce a remainder PSWAP note carrying the unfilled portion.
   */
  fillAmount: bigint | number;
  /**
   * Amount of the requested asset supplied by other (in-flight) notes routed
   * into the same transaction. Defaults to `0`; most callers should leave
   * this unset.
   */
  noteFillAmount?: bigint | number;
}

export interface PswapCancelOptions {
  /** Creator account reclaiming the offered asset */
  accountId: AccountRef;
  /**
   * PSWAP note to cancel. Accepts a hex string ID, `NoteId` object,
   * `InputNoteRecord`, or `Note` — string/NoteId values are looked up from
   * the local store; record/Note values are used directly.
   */
  note: NoteInput;
}

// Cancel a PSWAP lineage by its stable order id — the creator account and
// current tip note are resolved from the locally tracked lineage.
export interface PswapCancelByOrderOptions {
  /**
   * Stable order id of the lineage to cancel (decimal string or bigint).
   * `number` is not accepted: a PSWAP order id is `u64`-shaped and routinely
   * exceeds `Number.MAX_SAFE_INTEGER`, which a JS `number` cannot represent
   * without silent precision loss.
   */
  orderId: string | bigint;
}

// Result of the PSWAP lineage list query hooks.
export interface PswapLineagesResult {
  /** Tracked PSWAP lineages. */
  lineages: PswapLineageRecord[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

// Result of the single-lineage query hook.
export interface PswapLineageResult {
  /** The tracked lineage, or `null` if not tracked. */
  lineage: PswapLineageRecord | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

// Arbitrary transaction options
export interface ExecuteTransactionOptions {
  /** Account ID the transaction applies to */
  accountId: AccountRef;
  /** Transaction request or builder */
  request: TransactionRequestInput;
  /** Skip auto-sync before transaction. Default: false */
  skipSync?: boolean;
  /**
   * When set, private output notes from this transaction are delivered to the
   * given target account after the transaction is committed. Accepts any
   * AccountRef form (hex string, bech32, AccountId, Account, AccountHeader).
   */
  privateNoteTarget?: AccountRef;
  /**
   * Execute against a pinned reference block instead of the current sync
   * height, so a summary signed at that block reproduces exactly. Capture one
   * with {@link useChainAnchor}.
   */
  anchor?: ChainAnchor;
}

// Chain anchor

/** Options for capturing a {@link ChainAnchor}. */
export interface CaptureAnchorOptions {
  /** The request the anchor is captured for. */
  request: TransactionRequestInput;
}

/** Options for deriving a {@link TransactionSummary} without submitting. */
export interface PreviewTransactionOptions {
  /** Account ID the transaction applies to */
  accountId: AccountRef;
  /** Transaction request or builder */
  request: TransactionRequestInput;
  /**
   * Derive the summary at a pinned reference block. Required when verifying a
   * proposal: the summary binds the reference block commitment, so deriving it
   * at the local sync height produces a different summary.
   */
  anchor?: ChainAnchor;
}

// Transaction result
export interface TransactionResult {
  transactionId: string;
}

// Execute program (view call) options
export interface ExecuteProgramOptions {
  /** Account to execute the program against */
  accountId: string | AccountId;
  /** Compiled TransactionScript */
  script: TransactionScript;
  /** Advice inputs (defaults to empty) */
  adviceInputs?: AdviceInputs;
  /** Foreign accounts referenced by the script */
  foreignAccounts?: (
    | string
    | AccountId
    | { id: string | AccountId; storage?: AccountStorageRequirements }
  )[];
  /** Skip auto-sync before execution. Default: false */
  skipSync?: boolean;
}

// Execute program result
export interface ExecuteProgramResult {
  /** The 16-element stack output as bigint array */
  stack: bigint[];
}

// --- useNoteStream types ---

export interface StreamedNote {
  /** Note ID (hex string) */
  id: string;
  /** Sender account ID (bech32 if available) */
  sender: string;
  /** First fungible asset amount (convenience; 0n if no fungible assets) */
  amount: bigint;
  /** All assets on the note */
  assets: NoteAsset[];
  /** The underlying InputNoteRecord for escape-hatch access */
  record: InputNoteRecord;
  /** Timestamp (ms) when this note was first observed by the SDK */
  firstSeenAt: number;
  /** Pre-decoded attachment values, or null if no attachment */
  attachment: bigint[] | null;
}

export interface UseNoteStreamOptions {
  /** Note status filter. Default: "committed" */
  status?: "all" | "consumed" | "committed" | "expected" | "processing";
  /** Only notes from this sender (any format, normalized internally) */
  sender?: string | null;
  /** Only notes first seen after this timestamp */
  since?: number;
  /** Exclude these note IDs (for cross-phase stale filtering) */
  excludeIds?: Set<string> | string[];
  /** Filter by primary asset amount */
  amountFilter?: (amount: bigint) => boolean;
}

export interface UseNoteStreamReturn {
  /** Notes matching all filter criteria */
  notes: StreamedNote[];
  /** Most recent note (convenience) */
  latest: StreamedNote | null;
  /** Mark a note as handled (excluded from future renders) */
  markHandled: (noteId: string) => void;
  /** Mark all current notes as handled */
  markAllHandled: () => void;
  /** Snapshot current state for passing to next phase */
  snapshot: () => { ids: Set<string>; timestamp: number };
  isLoading: boolean;
  error: Error | null;
}

// --- useSessionAccount types ---

export interface UseSessionAccountOptions {
  /** Callback to fund the session wallet. Receives the session wallet ID. */
  fund: (sessionAccountId: string) => Promise<void>;
  /** Asset ID of the funding token (reserved for future filtering of consumable notes) */
  assetId?: string;
  /** Wallet creation options */
  walletOptions?: {
    storageMode?: "private" | "public";
    authScheme?: AuthScheme;
  };
  /** Polling interval for funding note detection (ms). Default: 3000 */
  pollIntervalMs?: number;
  /** Maximum time to wait for funding note (ms). Default: 60000 */
  maxWaitMs?: number;
  /** localStorage key prefix for persistence. Default: "miden-session" */
  storagePrefix?: string;
}

export type SessionAccountStep =
  | "idle"
  | "creating"
  | "funding"
  | "consuming"
  | "ready";

export interface UseSessionAccountReturn {
  /** Start the create->fund->consume flow */
  initialize: () => Promise<void>;
  /** Session wallet ID (bech32), or null if not yet created */
  sessionAccountId: string | null;
  /** Whether the session wallet is funded and ready */
  isReady: boolean;
  /** Current step */
  step: SessionAccountStep;
  /** Error from any step */
  error: Error | null;
  /** Clear all session data and reset */
  reset: () => void;
}

// Default values
export const DEFAULTS = {
  RPC_URL: undefined, // Will use SDK's testnet default
  AUTO_SYNC_INTERVAL: 15000,
  STORAGE_MODE: "private" as const,
  AUTH_SCHEME: AuthScheme.AuthRpoFalcon512,
  NOTE_TYPE: "private" as const,
  FAUCET_DECIMALS: 8,
} as const;
