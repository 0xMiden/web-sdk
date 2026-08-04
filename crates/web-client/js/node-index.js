/**
 * Node.js entry point for @miden-sdk/miden-sdk.
 *
 * Loaded automatically when Node.js resolves the package import
 * (via the "node" condition in package.json exports).
 *
 * Provides the same API as the browser entry point (index.js),
 * backed by a native napi addon with SQLite storage.
 */

import { loadNativeModule } from "./node/loader.js";
import { createSdkWrapper } from "./node/napi-compat.js";
import {
  createWasmWebClient,
  createMockWasmWebClient,
} from "./node/client-factory.js";
import { MidenClient } from "./client.js";
import { CompilerResource } from "./resources/compiler.js";
import {
  createP2IDNote,
  createP2IDENote,
  buildSwapTag,
  _setWasm as _setStandaloneWasm,
  _setWebClient as _setStandaloneWebClient,
} from "./standalone.js";

// ── Initialization ───────────────────────────────────────────────────

let _initialized = false;
let _rawSdk = null;
let _wrappedSdk = null;
let _WasmWebClient = null;
let _MockWasmWebClient = null;

function ensureInitialized() {
  if (_initialized) return;

  _rawSdk = loadNativeModule();
  _wrappedSdk = createSdkWrapper(_rawSdk);
  _WasmWebClient = createWasmWebClient(_rawSdk);
  _MockWasmWebClient = createMockWasmWebClient(_rawSdk);

  // Wire MidenClient statics
  MidenClient._WasmWebClient = _WasmWebClient;
  MidenClient._MockWasmWebClient = _MockWasmWebClient;
  MidenClient._getWasmOrThrow = async () => _wrappedSdk;

  // Wire standalone functions
  _setStandaloneWasm(_wrappedSdk);
  _setStandaloneWebClient(_WasmWebClient);

  _initialized = true;
}

// Initialize on import
ensureInitialized();

// ── Enum constants (matching browser entry point) ────────────────────

export const AccountType = Object.freeze({
  FungibleFaucet: "FungibleFaucet",
  NonFungibleFaucet: "NonFungibleFaucet",
});

export const AuthScheme = Object.freeze({
  Falcon: "falcon",
  ECDSA: "ecdsa",
});

export const NoteVisibility = Object.freeze({
  Public: "public",
  Private: "private",
});

export const StorageMode = Object.freeze({
  Public: "public",
  Private: "private",
});

export const Linking = Object.freeze({
  Dynamic: "dynamic",
  Static: "static",
});

// ── Re-exports ───────────────────────────────────────────────────────

export { MidenClient };
export { createP2IDNote, createP2IDENote, buildSwapTag };

// Internal exports (matching browser entry point)
export {
  _WasmWebClient as WasmWebClient,
  _MockWasmWebClient as MockWasmWebClient,
  _MockWasmWebClient as MockWebClient,
};

// Re-export all napi SDK types (equivalent to browser's `export * from "../Cargo.toml"`).
// Since we can't statically export dynamic napi bindings, we re-export common types explicitly
// and provide getNativeModule()/getWrappedSdk() for anything else.

export function getNativeModule() {
  ensureInitialized();
  return _rawSdk;
}

export function getWrappedSdk() {
  ensureInitialized();
  return _wrappedSdk;
}

// JS-layer exports the browser entry also provides (these are not napi classes,
// so they can't go through `_reexport`). `CompilerResource` already backs
// `MidenClient.compile` on Node, and `getWasmOrThrow` resolves to the wrapped
// napi sdk — the Node analogue of the browser's WASM-module accessor. Both are
// imported by `@miden-sdk/react` (e.g. `useCompile`).
export { CompilerResource };
export const getWasmOrThrow = async () => {
  ensureInitialized();
  return _wrappedSdk;
};

// ── napi re-exports ─────────────────────────────────────
// Lazy getter so the native module loads on first access.
function _reexport(name) {
  return {
    get [name]() {
      ensureInitialized();
      return _wrappedSdk[name] ?? _rawSdk[name];
    },
  }[name];
}

// Manual re-exports that aren't plain 1:1 napi passthroughs:
//   - AuthSchemeNative: the napi `AuthScheme` class under a name that does not
//     collide with the JS `AuthScheme` enum above.
//   - Rpo / exportStore / importStore: legacy export names kept for back-compat.
export const AuthSchemeNative = /* @__PURE__ */ _reexport("AuthScheme");
export const Rpo = /* @__PURE__ */ _reexport("Rpo");
export const exportStore = /* @__PURE__ */ _reexport("exportStore");
export const importStore = /* @__PURE__ */ _reexport("importStore");

// Every other public napi class. GENERATED — do not edit by hand. Run
// `pnpm --filter @miden-sdk/miden-sdk gen:node-reexports` to regenerate from the
// native module; CI's `check:node-reexports` keeps it in lockstep with napi.
// <generated:napi-reexports>
export const Account = /* @__PURE__ */ _reexport("Account");
export const AccountBuilder = /* @__PURE__ */ _reexport("AccountBuilder");
export const AccountBuilderResult = /* @__PURE__ */ _reexport(
  "AccountBuilderResult"
);
export const AccountCode = /* @__PURE__ */ _reexport("AccountCode");
export const AccountComponent = /* @__PURE__ */ _reexport("AccountComponent");
export const AccountComponentCode = /* @__PURE__ */ _reexport(
  "AccountComponentCode"
);
export const AccountDelta = /* @__PURE__ */ _reexport("AccountDelta");
export const AccountFile = /* @__PURE__ */ _reexport("AccountFile");
export const AccountHeader = /* @__PURE__ */ _reexport("AccountHeader");
export const AccountId = /* @__PURE__ */ _reexport("AccountId");
export const AccountInterface = /* @__PURE__ */ _reexport("AccountInterface");
export const AccountPatch = /* @__PURE__ */ _reexport("AccountPatch");
export const AccountProof = /* @__PURE__ */ _reexport("AccountProof");
export const AccountReader = /* @__PURE__ */ _reexport("AccountReader");
export const AccountStatus = /* @__PURE__ */ _reexport("AccountStatus");
export const AccountStorage = /* @__PURE__ */ _reexport("AccountStorage");
export const AccountStorageMode =
  /* @__PURE__ */ _reexport("AccountStorageMode");
export const AccountStoragePatch = /* @__PURE__ */ _reexport(
  "AccountStoragePatch"
);
export const AccountStorageRequirements = /* @__PURE__ */ _reexport(
  "AccountStorageRequirements"
);
export const AccountVaultDelta = /* @__PURE__ */ _reexport("AccountVaultDelta");
export const AccountVaultPatch = /* @__PURE__ */ _reexport("AccountVaultPatch");
export const Address = /* @__PURE__ */ _reexport("Address");
export const AddressInterface = /* @__PURE__ */ _reexport("AddressInterface");
export const AdviceInputs = /* @__PURE__ */ _reexport("AdviceInputs");
export const AdviceMap = /* @__PURE__ */ _reexport("AdviceMap");
export const AssetCallbackFlag = /* @__PURE__ */ _reexport("AssetCallbackFlag");
export const AssetVault = /* @__PURE__ */ _reexport("AssetVault");
export const AuthFalcon512RpoMultisigConfig = /* @__PURE__ */ _reexport(
  "AuthFalcon512RpoMultisigConfig"
);
export const AuthSecretKey = /* @__PURE__ */ _reexport("AuthSecretKey");
export const BasicFungibleFaucetComponent = /* @__PURE__ */ _reexport(
  "BasicFungibleFaucetComponent"
);
export const BlockHeader = /* @__PURE__ */ _reexport("BlockHeader");
export const CodeBuilder = /* @__PURE__ */ _reexport("CodeBuilder");
export const CommittedNote = /* @__PURE__ */ _reexport("CommittedNote");
export const ConsumableNoteRecord = /* @__PURE__ */ _reexport(
  "ConsumableNoteRecord"
);
export const Endpoint = /* @__PURE__ */ _reexport("Endpoint");
export const EthAddress = /* @__PURE__ */ _reexport("EthAddress");
export const ExecutedTransaction = /* @__PURE__ */ _reexport(
  "ExecutedTransaction"
);
export const Felt = /* @__PURE__ */ _reexport("Felt");
export const FetchedAccount = /* @__PURE__ */ _reexport("FetchedAccount");
export const FetchedNote = /* @__PURE__ */ _reexport("FetchedNote");
export const ForeignAccount = /* @__PURE__ */ _reexport("ForeignAccount");
export const FungibleAsset = /* @__PURE__ */ _reexport("FungibleAsset");
export const FungibleAssetDelta =
  /* @__PURE__ */ _reexport("FungibleAssetDelta");
export const FungibleAssetDeltaItem = /* @__PURE__ */ _reexport(
  "FungibleAssetDeltaItem"
);
export const GetProceduresResultItem = /* @__PURE__ */ _reexport(
  "GetProceduresResultItem"
);
export const InputNote = /* @__PURE__ */ _reexport("InputNote");
export const InputNoteRecord = /* @__PURE__ */ _reexport("InputNoteRecord");
export const InputNoteState = /* @__PURE__ */ _reexport("InputNoteState");
export const InputNotes = /* @__PURE__ */ _reexport("InputNotes");
export const Library = /* @__PURE__ */ _reexport("Library");
export const MerklePath = /* @__PURE__ */ _reexport("MerklePath");
export const NetworkAccountTarget = /* @__PURE__ */ _reexport(
  "NetworkAccountTarget"
);
export const NetworkId = /* @__PURE__ */ _reexport("NetworkId");
export const NetworkNoteStatusInfo = /* @__PURE__ */ _reexport(
  "NetworkNoteStatusInfo"
);
export const NetworkType = /* @__PURE__ */ _reexport("NetworkType");
export const Note = /* @__PURE__ */ _reexport("Note");
export const NoteAndArgs = /* @__PURE__ */ _reexport("NoteAndArgs");
export const NoteAssets = /* @__PURE__ */ _reexport("NoteAssets");
export const NoteAttachment = /* @__PURE__ */ _reexport("NoteAttachment");
export const NoteAttachmentScheme = /* @__PURE__ */ _reexport(
  "NoteAttachmentScheme"
);
export const NoteConsumability = /* @__PURE__ */ _reexport("NoteConsumability");
export const NoteConsumptionStatus = /* @__PURE__ */ _reexport(
  "NoteConsumptionStatus"
);
export const NoteDetails = /* @__PURE__ */ _reexport("NoteDetails");
export const NoteDetailsAndTag = /* @__PURE__ */ _reexport("NoteDetailsAndTag");
export const NoteExecutionHint = /* @__PURE__ */ _reexport("NoteExecutionHint");
export const NoteExportFormat = /* @__PURE__ */ _reexport("NoteExportFormat");
export const NoteFile = /* @__PURE__ */ _reexport("NoteFile");
export const NoteFilter = /* @__PURE__ */ _reexport("NoteFilter");
export const NoteFilterTypes = /* @__PURE__ */ _reexport("NoteFilterTypes");
export const NoteHeader = /* @__PURE__ */ _reexport("NoteHeader");
export const NoteId = /* @__PURE__ */ _reexport("NoteId");
export const NoteIdAndArgs = /* @__PURE__ */ _reexport("NoteIdAndArgs");
export const NoteInclusionProof =
  /* @__PURE__ */ _reexport("NoteInclusionProof");
export const NoteLocation = /* @__PURE__ */ _reexport("NoteLocation");
export const NoteMetadata = /* @__PURE__ */ _reexport("NoteMetadata");
export const NoteRecipient = /* @__PURE__ */ _reexport("NoteRecipient");
export const NoteScript = /* @__PURE__ */ _reexport("NoteScript");
export const NoteStorage = /* @__PURE__ */ _reexport("NoteStorage");
export const NoteSyncBlock = /* @__PURE__ */ _reexport("NoteSyncBlock");
export const NoteSyncInfo = /* @__PURE__ */ _reexport("NoteSyncInfo");
export const NoteTag = /* @__PURE__ */ _reexport("NoteTag");
export const NoteType = /* @__PURE__ */ _reexport("NoteType");
export const OutputNote = /* @__PURE__ */ _reexport("OutputNote");
export const OutputNoteRecord = /* @__PURE__ */ _reexport("OutputNoteRecord");
export const OutputNoteState = /* @__PURE__ */ _reexport("OutputNoteState");
export const OutputNotes = /* @__PURE__ */ _reexport("OutputNotes");
export const Package = /* @__PURE__ */ _reexport("Package");
export const PartialNote = /* @__PURE__ */ _reexport("PartialNote");
export const Poseidon2 = /* @__PURE__ */ _reexport("Poseidon2");
export const ProcedureThreshold =
  /* @__PURE__ */ _reexport("ProcedureThreshold");
export const Program = /* @__PURE__ */ _reexport("Program");
export const ProvenTransaction = /* @__PURE__ */ _reexport("ProvenTransaction");
export const PswapLineageRecord =
  /* @__PURE__ */ _reexport("PswapLineageRecord");
export const PswapLineageState = /* @__PURE__ */ _reexport("PswapLineageState");
export const PublicKey = /* @__PURE__ */ _reexport("PublicKey");
export const RpcClient = /* @__PURE__ */ _reexport("RpcClient");
export const Rpo256 = /* @__PURE__ */ _reexport("Rpo256");
export const Signature = /* @__PURE__ */ _reexport("Signature");
export const SigningInputs = /* @__PURE__ */ _reexport("SigningInputs");
export const SigningInputsType = /* @__PURE__ */ _reexport("SigningInputsType");
export const SlotAndKeys = /* @__PURE__ */ _reexport("SlotAndKeys");
export const SparseMerklePath = /* @__PURE__ */ _reexport("SparseMerklePath");
export const StorageMap = /* @__PURE__ */ _reexport("StorageMap");
export const StorageMapEntryJs = /* @__PURE__ */ _reexport("StorageMapEntryJs");
export const StorageMapInfo = /* @__PURE__ */ _reexport("StorageMapInfo");
export const StorageMapUpdate = /* @__PURE__ */ _reexport("StorageMapUpdate");
export const StorageSlot = /* @__PURE__ */ _reexport("StorageSlot");
export const SyncSummary = /* @__PURE__ */ _reexport("SyncSummary");
export const TokenSymbol = /* @__PURE__ */ _reexport("TokenSymbol");
export const TransactionArgs = /* @__PURE__ */ _reexport("TransactionArgs");
export const TransactionFilter = /* @__PURE__ */ _reexport("TransactionFilter");
export const TransactionId = /* @__PURE__ */ _reexport("TransactionId");
export const TransactionProver = /* @__PURE__ */ _reexport("TransactionProver");
export const TransactionRecord = /* @__PURE__ */ _reexport("TransactionRecord");
export const TransactionRequest =
  /* @__PURE__ */ _reexport("TransactionRequest");
export const TransactionRequestBuilder = /* @__PURE__ */ _reexport(
  "TransactionRequestBuilder"
);
export const TransactionResult = /* @__PURE__ */ _reexport("TransactionResult");
export const TransactionScript = /* @__PURE__ */ _reexport("TransactionScript");
export const TransactionScriptInputPair = /* @__PURE__ */ _reexport(
  "TransactionScriptInputPair"
);
export const TransactionStatus = /* @__PURE__ */ _reexport("TransactionStatus");
export const TransactionStoreUpdate = /* @__PURE__ */ _reexport(
  "TransactionStoreUpdate"
);
export const TransactionSummary =
  /* @__PURE__ */ _reexport("TransactionSummary");
export const Word = /* @__PURE__ */ _reexport("Word");
export const createAuthFalcon512RpoMultisig = /* @__PURE__ */ _reexport(
  "createAuthFalcon512RpoMultisig"
);
// </generated:napi-reexports>
