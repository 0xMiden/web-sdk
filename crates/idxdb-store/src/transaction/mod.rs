use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::StorageSlotContent;
use miden_client::store::{StoreError, TransactionFilter};
use miden_client::sync::NoteTagSource;
use miden_client::transaction::{
    TransactionDetails,
    TransactionId,
    TransactionRecord,
    TransactionScript,
    TransactionStatus,
    TransactionStoreUpdate,
};
use miden_client::utils::Serializable;
use miden_client_proto::{decode_unchecked, encode};
use serde::Serialize;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::js_sys;

use super::IdxdbStore;
use super::account::utils::{
    build_account_patch_payload,
    creation_account_from_patch,
    patch_code_bytes,
};
use super::account::{JsStorageMapEntry, JsStorageSlot, JsVaultAsset};
use super::note::utils::{
    SerializedInputNoteData,
    SerializedOutputNoteData,
    serialize_input_note,
    serialize_output_note,
};
use crate::promise::await_js;

mod js_bindings;
use js_bindings::{idxdb_apply_transaction_batch, idxdb_get_transactions};

mod models;
use models::TransactionIdxdbObject;

pub mod utils;
use utils::{SerializedTransactionData, build_transaction_record, serialize_transaction_record};

// BATCH PAYLOAD TYPES
// ================================================================================================

/// Serializable representation of the TS `JsFullAccountState` interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchFullAccountState {
    account_id: String,
    nonce: String,
    storage_slots: Vec<JsStorageSlot>,
    storage_map_entries: Vec<JsStorageMapEntry>,
    assets: Vec<JsVaultAsset>,
    code_root: String,
    storage_root: String,
    vault_root: String,
    committed: bool,
    account_commitment: String,
    #[serde(with = "serde_bytes", skip_serializing_if = "Option::is_none")]
    account_seed: Option<Vec<u8>>,
    #[serde(with = "serde_bytes", skip_serializing_if = "Vec::is_empty")]
    code: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum BatchAccountState {
    Full {
        account: BatchFullAccountState,
    },
    Delta {
        #[serde(rename = "accountId")]
        account_id: String,
        nonce: String,
        #[serde(rename = "updatedSlots")]
        updated_slots: Vec<JsStorageSlot>,
        #[serde(rename = "changedMapEntries")]
        changed_map_entries: Vec<JsStorageMapEntry>,
        #[serde(rename = "changedAssets")]
        changed_assets: Vec<JsVaultAsset>,
        #[serde(rename = "codeRoot")]
        code_root: String,
        #[serde(rename = "storageRoot")]
        storage_root: String,
        #[serde(rename = "vaultRoot")]
        vault_root: String,
        committed: bool,
        commitment: String,
        #[serde(with = "serde_bytes", skip_serializing_if = "Vec::is_empty")]
        code: Vec<u8>,
    },
}

/// Serializable representation of the TS `JsBatchNoteTag` interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchNoteTag {
    #[serde(with = "serde_bytes")]
    tag: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_note_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_subscription_key: Option<String>,
}

/// Serializable representation of the TS `JsBatchUpdatePayload` interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchUpdatePayload {
    initial_account_commitment: String,
    transaction_record: SerializedTransactionData,
    account_state: BatchAccountState,
    input_notes: Vec<SerializedInputNoteData>,
    output_notes: Vec<SerializedOutputNoteData>,
    tags: Vec<BatchNoteTag>,
}

impl IdxdbStore {
    pub async fn get_transactions(
        &self,
        filter: TransactionFilter,
    ) -> Result<Vec<TransactionRecord>, StoreError> {
        let filter_as_str = match filter {
            TransactionFilter::All => "All",
            TransactionFilter::Uncommitted => "Uncommitted",
            TransactionFilter::Ids(ids) => &{
                let ids_str =
                    ids.iter().map(ToString::to_string).collect::<Vec<String>>().join(",");
                format!("Ids:{ids_str}")
            },
        };

        let promise = idxdb_get_transactions(self.db_id(), filter_as_str.to_string());
        let transactions_idxdb: Vec<TransactionIdxdbObject> =
            await_js(promise, "failed to get transactions").await?;

        let transaction_records: Result<Vec<TransactionRecord>, StoreError> = transactions_idxdb
            .into_iter()
            .map(|tx_idxdb| {
                let id: Word = tx_idxdb.id.try_into()?;

                let details: TransactionDetails = decode_unchecked(&tx_idxdb.details)?;

                let script: Option<TransactionScript> = if tx_idxdb.script_root.is_some() {
                    let tx_script = tx_idxdb
                        .tx_script
                        .map(|script| decode_unchecked::<TransactionScript>(&script))
                        .transpose()?
                        .ok_or(StoreError::DatabaseError(
                            "transaction script missing from store despite script_root being set"
                                .into(),
                        ))?;

                    Some(tx_script)
                } else {
                    None
                };

                let status: TransactionStatus = decode_unchecked(&tx_idxdb.status)?;

                Ok(TransactionRecord {
                    id: TransactionId::from_raw(id),
                    details,
                    script,
                    status,
                })
            })
            .collect();

        transaction_records
    }

    pub async fn apply_transaction(
        &self,
        tx_update: TransactionStoreUpdate,
    ) -> Result<(), StoreError> {
        self.apply_transaction_batch_atomic(vec![tx_update]).await
    }

    /// Applies multiple transaction updates atomically in a single Dexie transaction.
    pub async fn apply_transaction_batch_atomic(
        &self,
        tx_updates: Vec<TransactionStoreUpdate>,
    ) -> Result<(), StoreError> {
        if tx_updates.is_empty() {
            return Ok(());
        }
        let mut touched_accounts = BTreeSet::new();
        let result = async {
            let mut expected = BTreeMap::new();
            // Read every persisted input before staging any forest updates.
            for update in &tx_updates {
                let tx = update.executed_transaction();
                let id = tx.account_id();
                let commitment = if let Some(commitment) = expected.get(&id) {
                    *commitment
                } else {
                    touched_accounts.insert(id);
                    self.current_account_header(id).await?.to_commitment()
                };
                if tx.initial_account().to_commitment() != commitment {
                    return Err(StoreError::DatabaseError(format!(
                        "transaction input account commitment does not match state for {id}",
                    )));
                }
                expected.insert(id, tx.final_account().to_commitment());
            }
            let serializer = serde_wasm_bindgen::Serializer::new();
            let js_array = js_sys::Array::new();
            for update in &tx_updates {
                let payload = self.prepare_update_for_batch(update)?;
                let value = payload.serialize(&serializer).map_err(|error| {
                    StoreError::DatabaseError(format!("serialization error: {error}"))
                })?;
                js_array.push(&value);
            }
            let promise = idxdb_apply_transaction_batch(self.db_id(), JsValue::from(js_array));
            crate::promise::await_ok(promise, "batch apply").await
        }
        .await;
        if let Err(error) = result {
            let mut cleanup_error = None;
            for id in touched_accounts {
                if let Err(rebuild_error) = self.rebuild_account_forest(id).await {
                    cleanup_error.get_or_insert(rebuild_error);
                }
            }
            return Err(cleanup_error.unwrap_or(error));
        }
        Ok(())
    }

    /// Pre-computes all SMT work for a single update and builds the serializable payload
    /// for the batch JS call. Mirrors `apply_transaction` but without the JS writes.
    #[allow(clippy::too_many_lines)]
    fn prepare_update_for_batch(
        &self,
        update: &TransactionStoreUpdate,
    ) -> Result<BatchUpdatePayload, StoreError> {
        let executed_tx = update.executed_transaction();
        let patch = executed_tx.account_patch();
        let final_header = executed_tx.final_account();
        let account_id = executed_tx.account_id();

        // Build transaction record payload via the shared serializer.
        let record = build_transaction_record(executed_tx, update.submission_height());
        let transaction_record = serialize_transaction_record(&record);

        // Build the payload and advance the forest. Later updates in the batch read the forest, so
        // each sees the earlier ones' state even though nothing has been written yet.
        let account_state = if let Some(account) = creation_account_from_patch(patch, final_header)?
        {
            self.smt_forest.write().rebuild_account(&account)?;

            let storage_slots: Vec<JsStorageSlot> =
                account.storage().slots().iter().map(JsStorageSlot::from_slot).collect();

            let storage_map_entries: Vec<JsStorageMapEntry> = account
                .storage()
                .slots()
                .iter()
                .filter_map(|slot| match slot.content() {
                    StorageSlotContent::Map(map) => {
                        Some(JsStorageMapEntry::from_map(map, &slot.name().to_string()))
                    },
                    StorageSlotContent::Value(_) => None,
                })
                .flatten()
                .collect();

            let assets: Vec<JsVaultAsset> =
                account.vault().assets().map(|a| JsVaultAsset::from_asset(&a)).collect();

            BatchAccountState::Full {
                account: BatchFullAccountState {
                    account_id: account.id().to_string(),
                    nonce: account.nonce().to_string(),
                    storage_slots,
                    storage_map_entries,
                    assets,
                    code_root: account.code().commitment().to_string(),
                    storage_root: account.storage().to_commitment().to_string(),
                    vault_root: account.vault().root().to_string(),
                    committed: account.is_public(),
                    account_commitment: account.to_commitment().to_string(),
                    account_seed: account.seed().map(|seed| seed.to_bytes()),
                    code: encode(account.code()),
                },
            }
        } else {
            let code = patch_code_bytes(patch, final_header)?;
            let new_map_roots = self.apply_patch_to_forest(final_header, patch)?;

            let (js_slots, js_map_entries, js_assets) =
                build_account_patch_payload(&new_map_roots, patch);

            BatchAccountState::Delta {
                account_id: account_id.to_string(),
                nonce: final_header.nonce().to_string(),
                updated_slots: js_slots,
                changed_map_entries: js_map_entries,
                changed_assets: js_assets,
                code_root: final_header.code_commitment().to_string(),
                storage_root: final_header.storage_commitment().to_string(),
                vault_root: final_header.vault_root().to_string(),
                committed: account_id.is_public(),
                commitment: final_header.to_commitment().to_string(),
                code,
            }
        };

        let input_notes: Vec<SerializedInputNoteData> = update
            .note_updates()
            .updated_input_notes()
            .map(|u| serialize_input_note(u.inner()))
            .collect();

        let output_notes: Vec<SerializedOutputNoteData> = update
            .note_updates()
            .updated_output_notes()
            .map(|u| serialize_output_note(u.inner()))
            .collect();

        let tags: Vec<BatchNoteTag> = update
            .new_tags()
            .iter()
            .map(|tag_record| {
                let (source_note_id, source_account_id, source_subscription_key) =
                    match &tag_record.source {
                        NoteTagSource::Note(note_id) => (Some(note_id.to_hex()), None, None),
                        NoteTagSource::Account(acc_id) => (None, Some(acc_id.to_hex()), None),
                        NoteTagSource::Subscription(key) => (None, None, Some(key.to_hex())),
                        NoteTagSource::User => (None, None, None),
                    };
                BatchNoteTag {
                    tag: tag_record.tag.to_bytes(),
                    source_note_id,
                    source_account_id,
                    source_subscription_key,
                }
            })
            .collect();

        let payload = BatchUpdatePayload {
            initial_account_commitment: executed_tx.initial_account().to_commitment().to_string(),
            transaction_record,
            account_state,
            input_notes,
            output_notes,
            tags,
        };

        Ok(payload)
    }
}
