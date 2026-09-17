/**
 * TypeDoc entry point — curated subset of the public API.
 * Only types listed here (or transitively referenced) appear in generated docs.
 * Runtime consumers should import from index.d.ts, not this file.
 */

// Curated WASM re-exports: only types referenced in the public API
export {
  Account,
  AccountCode,
  AccountFile,
  AccountHeader,
  AccountId,
  AccountPatch,
  AccountStorage,
  AccountStoragePatch,
  AccountVaultPatch,
  AdviceMap,
  AssetVault,
  BasicFungibleFaucetComponent,
  BlockHeader,
  ChainAnchor,
  EthAddress,
  ExecutedTransaction,
  Felt,
  InputNoteRecord,
  NetworkAccountTarget,
  Note,
  NoteExportFormat,
  NoteFile,
  NoteId,
  NoteTag,
  ProvenTransaction,
  PswapLineageRecord,
  PswapLineageState,
  RawOutputNote,
  OutputNote,
  OutputNoteRecord,
  OutputNotes,
  SyncSummary,
  TransactionId,
  TransactionProver,
  TransactionRecord,
  TransactionRequest,
  TransactionRequestBuilder,
  TransactionResult,
  TransactionStoreUpdate,
  TransactionSummary,
  Word,
} from "./crates/miden_client_web";

// All simplified API types
export * from "./api-types";

// Storage utilities
export { StorageView, StorageResult, wordToBigInt } from "./index";
