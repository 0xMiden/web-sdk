use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::{Account, StorageSlotContent};
use miden_client::utils::Serializable;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::js_sys;

use super::flattened_vec::FlattenedU8Vec;
use crate::account::{JsStorageMapEntry, JsStorageSlot, JsVaultAsset};
use crate::forest::js_bindings::JsForestUpdate;
use crate::note::utils::{SerializedInputNoteData, SerializedOutputNoteData};
use crate::transaction::utils::SerializedTransactionData;

// Sync IndexedDB Operations
#[wasm_bindgen(module = "/src/js/sync.js")]
extern "C" {
    // GETS
    // --------------------------------------------------------------------------------------------

    #[wasm_bindgen(js_name = getSyncHeight)]
    pub fn idxdb_get_sync_height(db_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_name = getCurrentBlockchainPeaks)]
    pub fn idxdb_get_current_blockchain_peaks(db_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_name = getNoteTags)]
    pub fn idxdb_get_note_tags(db_id: &str) -> js_sys::Promise;

    // INSERTS
    // --------------------------------------------------------------------------------------------

    #[wasm_bindgen(js_name = addNoteTag)]
    pub fn idxdb_add_note_tag(
        db_id: &str,
        tag: Vec<u8>,
        source_note_id: Option<String>,
        source_account_id: Option<String>,
        source_subscription_key: Option<String>,
    ) -> js_sys::Promise;

    #[wasm_bindgen(js_name = applyStateSync)]
    pub fn idxdb_apply_state_sync(
        db_id: &str,
        state_update: JsStateSyncUpdate,
        forest_update: JsForestUpdate,
    ) -> js_sys::Promise;

    // DELETES
    // --------------------------------------------------------------------------------------------
    #[wasm_bindgen(js_name = removeNoteTag)]
    pub fn idxdb_remove_note_tag(
        db_id: &str,
        tag: Vec<u8>,
        source_note_id: Option<String>,
        source_account_id: Option<String>,
        source_subscription_key: Option<String>,
    ) -> js_sys::Promise;

    #[wasm_bindgen(js_name = discardTransactions)]
    pub fn idxdb_discard_transactions(db_id: &str, transactions: Vec<String>) -> js_sys::Promise;
}

/// An object that contains data for a sync update,
/// which will be received by the applyStateSync JS function.
/// under sync.js
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsStateSyncUpdate {
    /// The block number for this update.
    #[wasm_bindgen(js_name = "blockNum")]
    pub block_num: u32,

    /// The new block headers for this state update, serialized into a flattened byte array.
    #[wasm_bindgen(js_name = "flattenedNewBlockHeaders")]
    pub flattened_new_block_headers: FlattenedU8Vec,

    /// The block numbers corresponding to each header in `flattened_new_block_headers`.
    /// This vec should have the same length as the number of headers, with each index
    /// representing the block number for the header at that same index.
    #[wasm_bindgen(js_name = "newBlockNums")]
    pub new_block_nums: Vec<u32>,

    /// Serialized MMR peaks at the new sync height. The only peaks persisted by the
    /// client (peaks for intermediate note blocks are never read, so they are not stored).
    #[wasm_bindgen(js_name = "newPeaks")]
    pub new_peaks: Vec<u8>,

    /// For each block in this update, stores a boolean (as u8) indicating whether
    /// that block contains notes relevant to this client. Index i corresponds to
    /// the ith block, with 1 meaning relevant and 0 meaning not relevant.
    #[wasm_bindgen(js_name = "blockHasRelevantNotes")]
    pub block_has_relevant_notes: Vec<u8>,

    /// Serialized IDs for new authentication nodes required to verify block headers.
    #[wasm_bindgen(js_name = "serializedNodeIds")]
    pub serialized_node_ids: Vec<String>,

    /// The actual authentication node data corresponding to the IDs above.
    #[wasm_bindgen(js_name = "serializedNodes")]
    pub serialized_nodes: Vec<String>,

    /// Details-commitment hex of committed notes whose tracking tags
    /// (`NoteTagSource::Note`) should be removed from the client's local state.
    #[wasm_bindgen(js_name = "committedNoteTagSources")]
    pub committed_note_tag_sources: Vec<String>,

    /// Input notes for this state update in serialized form.
    #[wasm_bindgen(js_name = "serializedInputNotes")]
    pub serialized_input_notes: Vec<SerializedInputNoteData>,

    /// Output notes created in this state update in serialized form.
    #[wasm_bindgen(js_name = "serializedOutputNotes")]
    pub serialized_output_notes: Vec<SerializedOutputNoteData>,

    /// Account state updates included in this sync.
    #[wasm_bindgen(js_name = "accountUpdates")]
    pub account_updates: Vec<JsAccountUpdate>,

    /// Commitments of the account states to undo (discarded local transactions), rolled back
    /// inside the same transaction before the account updates are applied.
    #[wasm_bindgen(js_name = "accountCommitmentsToUndo")]
    pub account_commitments_to_undo: Vec<String>,

    /// Incremental account patches included in this sync, applied after the undo.
    #[wasm_bindgen(js_name = "accountPatchUpdates")]
    pub account_patch_updates: Vec<JsAccountPatchUpdate>,

    /// Transaction data for transactions included in this update.
    #[wasm_bindgen(js_name = "transactionUpdates")]
    pub transaction_updates: Vec<SerializedTransactionData>,
}

/// One incremental account patch applied within a state sync, mirroring the per-account
/// arguments of the standalone `applyAccountPatch` JS function.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsAccountPatchUpdate {
    #[wasm_bindgen(js_name = "accountId")]
    pub account_id: String,
    pub nonce: String,
    #[wasm_bindgen(js_name = "updatedSlots")]
    pub updated_slots: Vec<JsStorageSlot>,
    #[wasm_bindgen(js_name = "changedMapEntries")]
    pub changed_map_entries: Vec<JsStorageMapEntry>,
    #[wasm_bindgen(js_name = "changedAssets")]
    pub changed_assets: Vec<JsVaultAsset>,
    #[wasm_bindgen(js_name = "codeRoot")]
    pub code_root: String,
    #[wasm_bindgen(js_name = "storageRoot")]
    pub storage_root: String,
    #[wasm_bindgen(js_name = "vaultRoot")]
    pub vault_root: String,
    pub committed: bool,
    pub commitment: String,
}

/// Represents an update to a single account's state.
///
/// `inspectable` is intentionally omitted (see #2183). When `inspectable` is
/// set on a struct with public fields, wasm-bindgen auto-generates a
/// `toJSON()` method that reads every field-getter — each of which calls
/// back into WASM via `__wbg_get_<class>_<field>(this.__wbg_ptr)`. Under
/// Next.js 16.2 dev-mode the patched `console.*` runs every non-primitive
/// argument through `safe-stable-stringify`, which invokes `toJSON()`
/// automatically. If the underlying pointer has been freed (or another
/// WASM call is in flight) the resulting `"null pointer passed to rust"`
/// trap propagates out of the user's `console.log` and crashes the
/// caller. Without `inspectable`, no `toJSON()` is emitted; JSON.stringify
/// falls back to `{}` (the wasm-bindgen wrapper has no own enumerable
/// data — it's all behind the `__wbg_ptr`), and the re-entry never
/// happens. Field access via the named getters still works exactly as
/// before; only the auto-stringification path is muted.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsAccountUpdate {
    /// The merkle root of the account's storage trie.
    #[wasm_bindgen(js_name = "storageRoot")]
    pub storage_root: String,

    /// Serialized storage slot data for this account.
    #[wasm_bindgen(js_name = "storageSlots")]
    pub storage_slots: Vec<JsStorageSlot>,

    /// Serialized storage map entries for this account.
    #[wasm_bindgen(js_name = "storageMapEntries")]
    pub storage_map_entries: Vec<JsStorageMapEntry>,

    /// The merkle root of the account's asset vault.
    #[wasm_bindgen(js_name = "vaultRoot")]
    pub vault_root: String,

    /// The account's asset vault.
    #[wasm_bindgen(js_name = "assets")]
    pub assets: Vec<JsVaultAsset>,

    /// ID for this account.
    #[wasm_bindgen(js_name = "accountId")]
    pub account_id: String,

    /// The merkle root of the account's executable code.
    #[wasm_bindgen(js_name = "codeRoot")]
    pub code_root: String,

    /// Whether this account update has been committed.
    #[wasm_bindgen(js_name = "committed")]
    pub committed: bool,

    /// The account's transaction nonce as a string.
    #[wasm_bindgen(js_name = "nonce")]
    pub nonce: String,

    /// The cryptographic commitment representing this account's current state.
    #[wasm_bindgen(js_name = "accountCommitment")]
    pub account_commitment: String,

    /// Optional seed data for the account.
    #[wasm_bindgen(js_name = "accountSeed")]
    pub account_seed: Option<Vec<u8>>,
}

impl JsAccountUpdate {
    pub fn from_account(account: &Account, account_seed: Option<Word>) -> Self {
        let asset_vault = account.vault();
        Self {
            storage_root: account.storage().to_commitment().to_string(),
            storage_slots: account.storage().slots().iter().map(JsStorageSlot::from_slot).collect(),
            storage_map_entries: account
                .storage()
                .slots()
                .iter()
                .filter_map(|slot| {
                    if let StorageSlotContent::Map(map) = slot.content() {
                        Some(JsStorageMapEntry::from_map(map, slot.name().as_str()))
                    } else {
                        None
                    }
                })
                .flatten()
                .collect(),
            vault_root: asset_vault.root().to_string(),
            assets: asset_vault.assets().map(|asset| JsVaultAsset::from_asset(&asset)).collect(),
            account_id: account.id().to_string(),
            code_root: account.code().commitment().to_string(),
            committed: account.is_public(),
            nonce: account.nonce().to_string(),
            account_commitment: account.to_commitment().to_string(),
            account_seed: account_seed.map(|seed| seed.to_bytes()),
        }
    }
}
