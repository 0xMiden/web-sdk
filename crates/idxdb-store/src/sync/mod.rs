use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::{Account, AccountId};
use miden_client::crypto::{Forest, MmrPeaks};
use miden_client::note::{BlockNumber, NoteDetailsCommitment, NoteTag};
use miden_client::store::StoreError;
use miden_client::sync::{
    NoteTagRecord,
    NoteTagSource,
    PartialBlockchainUpdates,
    PublicAccountUpdate,
    StateSyncUpdate,
};
use miden_client::utils::{Deserializable, Serializable};

use super::IdxdbStore;
use super::account::utils::{
    apply_account_patch,
    compute_storage_patch,
    compute_vault_patch,
    update_tracked_storage_roots,
};
use super::chain_data::utils::{
    SerializedPartialBlockchainNodeData,
    serialize_partial_blockchain_node,
};
use super::note::utils::{serialize_input_note, serialize_output_note};
use super::transaction::utils::serialize_transaction_record;
use crate::promise::{await_js, await_js_value};

mod js_bindings;
pub use js_bindings::JsAccountUpdate;
use js_bindings::{
    JsStateSyncUpdate,
    idxdb_add_note_tag,
    idxdb_apply_state_sync,
    idxdb_get_current_blockchain_peaks,
    idxdb_get_note_tags,
    idxdb_get_sync_height,
    idxdb_remove_note_tag,
};

mod models;
use models::{NoteTagIdxdbObject, PartialBlockchainPeaksIdxdbObject, SyncHeightIdxdbObject};

mod flattened_vec;
use flattened_vec::flatten_nested_u8_vec;

impl IdxdbStore {
    pub(crate) async fn get_note_tags(&self) -> Result<Vec<NoteTagRecord>, StoreError> {
        let promise = idxdb_get_note_tags(self.db_id());
        let tags_idxdb: Vec<NoteTagIdxdbObject> =
            await_js(promise, "failed to get note tags").await?;

        let tags = tags_idxdb
            .into_iter()
            .map(|t| -> Result<NoteTagRecord, StoreError> {
                let source =
                    match (t.source_account_id, t.source_note_id, t.source_subscription_key) {
                        (None, None, None) => NoteTagSource::User,
                        (Some(account_id), None, None) => {
                            NoteTagSource::Account(AccountId::from_hex(account_id.as_str())?)
                        },
                        (None, Some(commitment_hex), None) => NoteTagSource::Note(
                            // `NoteDetailsCommitment` wraps a `Word`; round-trip
                            // through `Word::try_from(hex)` (the `WordWrapper`
                            // derive supplies `from_raw` but not `try_from_hex`).
                            NoteDetailsCommitment::from_raw(Word::try_from(
                                commitment_hex.as_str(),
                            )?),
                        ),
                        (None, None, Some(key_hex)) => {
                            NoteTagSource::Subscription(Word::try_from(key_hex.as_str())?)
                        },
                        _ => {
                            return Err(StoreError::ParsingError(
                                "Invalid NoteTagSource".to_string(),
                            ));
                        },
                    };

                Ok(NoteTagRecord {
                    tag: NoteTag::read_from_bytes(&t.tag)?,
                    source,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(tags)
    }

    pub(super) async fn get_sync_height(&self) -> Result<BlockNumber, StoreError> {
        let promise = idxdb_get_sync_height(self.db_id());
        let block_num_idxdb: SyncHeightIdxdbObject =
            await_js(promise, "failed to get sync height").await?;

        Ok(block_num_idxdb.block_num.into())
    }

    pub(crate) async fn get_current_blockchain_peaks(&self) -> Result<MmrPeaks, StoreError> {
        let promise = idxdb_get_current_blockchain_peaks(self.db_id());
        let peaks_idxdb: PartialBlockchainPeaksIdxdbObject =
            await_js(promise, "failed to get current blockchain peaks").await?;

        if peaks_idxdb.peaks.is_empty() {
            return Ok(MmrPeaks::new(Forest::empty(), Vec::new())?);
        }

        let mmr_peaks_nodes: Vec<Word> = Vec::<Word>::read_from_bytes(&peaks_idxdb.peaks)?;
        let forest = Forest::new(
            usize::try_from(peaks_idxdb.block_num).expect("u32 block_num should fit in usize"),
        )?;
        MmrPeaks::new(forest, mmr_peaks_nodes).map_err(StoreError::MmrError)
    }

    pub(super) async fn add_note_tag(&self, tag: NoteTagRecord) -> Result<bool, StoreError> {
        if self.get_note_tags().await?.contains(&tag) {
            return Ok(false);
        }

        let (source_note_id, source_account_id, source_subscription_key) =
            encode_tag_source(&tag.source);

        let promise = idxdb_add_note_tag(
            self.db_id(),
            tag.tag.to_bytes(),
            source_note_id,
            source_account_id,
            source_subscription_key,
        );
        await_js_value(promise, "failed to add note tag").await?;

        Ok(true)
    }

    pub(super) async fn remove_note_tag(&self, tag: NoteTagRecord) -> Result<usize, StoreError> {
        let (source_note_id, source_account_id, source_subscription_key) =
            encode_tag_source(&tag.source);

        let promise = idxdb_remove_note_tag(
            self.db_id(),
            tag.tag.to_bytes(),
            source_note_id,
            source_account_id,
            source_subscription_key,
        );
        let removed_tags: usize = await_js(promise, "failed to remove note tag").await?;

        Ok(removed_tags)
    }

    #[allow(clippy::too_many_lines)]
    pub(super) async fn apply_state_sync(
        &self,
        state_sync_update: StateSyncUpdate,
    ) -> Result<(), StoreError> {
        let StateSyncUpdate {
            block_num,
            partial_blockchain_updates,
            note_updates,
            transaction_updates,
            account_updates,
        } = state_sync_update;

        let (
            block_headers_as_bytes,
            block_nums,
            block_has_relevant_notes,
            serialized_node_ids,
            serialized_nodes,
        ) = serialize_partial_blockchain_updates(&partial_blockchain_updates)?;

        let new_peaks_bytes = partial_blockchain_updates.new_peaks.peaks().to_vec().to_bytes();

        let (serialized_input_notes, serialized_output_notes): (Vec<_>, Vec<_>) = {
            let input_notes = note_updates.updated_input_notes();
            let output_notes = note_updates.updated_output_notes();
            (
                input_notes.into_iter().map(|note| serialize_input_note(note.inner())).collect(),
                output_notes
                    .into_iter()
                    .map(|note| serialize_output_note(note.inner()))
                    .collect(),
            )
        };

        // Tags for tracked expected notes are keyed by the note's details
        // commitment (`NoteTagSource::Note`), which `encode_tag_source` writes
        // into the `tags.sourceNoteId` column. To prune those tags once their
        // notes commit, collect the details-commitment hex of every committed
        // input note so the JS layer can delete the matching rows.
        let committed_note_tag_sources: Vec<String> = note_updates
            .updated_input_notes()
            .filter(|update| update.inner().is_committed())
            .map(|update| update.inner().details_commitment().to_hex())
            .collect();

        for (account_id, digest) in account_updates.mismatched_private_accounts() {
            self.lock_account_on_unexpected_commitment(account_id, digest).await.map_err(
                |err| {
                    StoreError::DatabaseError(format!("failed to check account mismatch: {err:?}"))
                },
            )?;
        }

        let account_states_to_rollback = transaction_updates
            .discarded_transactions()
            .map(|tx_record| tx_record.details.final_account_state)
            .collect::<Vec<_>>();

        // Remove the account states and discard their SMT roots from the forest
        self.rollback_account_states(&account_states_to_rollback).await?;

        // Discard roots for rolled-back accounts
        {
            let mut smt_forest = self.smt_forest.write();
            for tx_record in transaction_updates.discarded_transactions() {
                smt_forest.discard_roots(tx_record.details.account_id);
            }
            // Commit roots for successfully committed transactions
            for tx_record in transaction_updates.committed_transactions() {
                smt_forest.commit_roots(tx_record.details.account_id);
            }
        }

        let transaction_updates: Vec<_> = transaction_updates
            .committed_transactions()
            .chain(transaction_updates.discarded_transactions())
            .map(serialize_transaction_record)
            .collect();

        // Separate full account updates from incremental absolute patches. A full-state patch can
        // also occur when a newly-created account is too large for the node's full-state response;
        // convert it back into an account so it follows the same replacement path.
        let mut full_accounts: Vec<Account> = Vec::new();
        let mut patch_updates = Vec::new();
        for update in account_updates.updated_public_accounts() {
            match update {
                PublicAccountUpdate::Full(account) => full_accounts.push(account.clone()),
                PublicAccountUpdate::Patch { new_header, patch } if patch.is_full_state() => {
                    let account = Account::try_from(patch)?;
                    if account.to_commitment() != new_header.to_commitment() {
                        return Err(StoreError::AccountCommitmentMismatch(account.id()));
                    }
                    full_accounts.push(account);
                },
                PublicAccountUpdate::Patch { new_header, patch } => {
                    patch_updates.push((new_header, patch));
                },
            }
        }

        // Update SMT forest for full account updates (insert nodes + replace roots atomically)
        {
            let mut smt_forest = self.smt_forest.write();
            for account in &full_accounts {
                smt_forest.insert_and_register_account_state(
                    account.id(),
                    account.vault(),
                    account.storage(),
                )?;
            }
        }

        // Apply partial patches incrementally. Their storage and vault values are already absolute,
        // so no full account or relative-delta reconstruction is required.
        for (new_header, patch) in patch_updates {
            let account_id = new_header.id();

            let map_slot_names: Vec<String> =
                patch.storage().maps().map(|(slot_name, _)| slot_name.to_string()).collect();
            let old_map_roots = self.get_storage_map_roots(account_id, map_slot_names).await?;

            let (updated_storage_slots, updated_assets, removed_asset_ids) = {
                let mut smt_forest = self.smt_forest.write();

                let mut final_roots = smt_forest
                    .get_roots(&account_id)
                    .cloned()
                    .ok_or(StoreError::AccountDataNotFound(account_id))?;

                // Storage: compute new map roots via SMT forest and update the tracked root list.
                let updated_storage_slots =
                    compute_storage_patch(&mut smt_forest, &old_map_roots, patch)?;
                update_tracked_storage_roots(
                    &mut final_roots,
                    &old_map_roots,
                    &updated_storage_slots,
                )?;

                // Vault patches already contain absolute final asset values.
                let old_vault_root = final_roots[0];
                let (updated_assets, removed_asset_ids) = compute_vault_patch(patch);
                let new_vault_root = smt_forest.update_asset_nodes(
                    old_vault_root,
                    updated_assets.iter().copied(),
                    removed_asset_ids.iter().copied(),
                )?;
                if new_vault_root != new_header.vault_root() {
                    return Err(StoreError::DatabaseError(format!(
                        "computed vault root {} does not match synced account header {}",
                        new_vault_root.to_hex(),
                        new_header.vault_root().to_hex(),
                    )));
                }
                final_roots[0] = new_vault_root;

                // For sync updates, replace roots directly (not staged)
                smt_forest.replace_roots(account_id, final_roots);

                (updated_storage_slots, updated_assets, removed_asset_ids)
            };

            apply_account_patch(
                self.db_id(),
                account_id,
                new_header,
                &updated_storage_slots,
                &updated_assets,
                &removed_asset_ids,
                patch,
            )
            .await
            .map_err(|err| {
                StoreError::DatabaseError(format!("failed to apply sync account patch: {err:?}"))
            })?;
        }

        let state_update = JsStateSyncUpdate {
            block_num: block_num.as_u32(),
            flattened_new_block_headers: flatten_nested_u8_vec(block_headers_as_bytes),
            new_block_nums: block_nums,
            new_peaks: new_peaks_bytes,
            block_has_relevant_notes,
            serialized_node_ids,
            serialized_nodes,
            committed_note_tag_sources,
            serialized_input_notes,
            serialized_output_notes,
            account_updates: full_accounts
                .iter()
                .map(|account| JsAccountUpdate::from_account(account, None))
                .collect(),
            transaction_updates,
        };
        let promise = idxdb_apply_state_sync(self.db_id(), state_update);
        await_js_value(promise, "failed to apply state sync").await?;

        Ok(())
    }

    /// Rolls back account states by removing them from the DB.
    /// SMT root cleanup is handled separately via `discard_roots`.
    async fn rollback_account_states(
        &self,
        account_commitments: &[Word],
    ) -> Result<(), StoreError> {
        self.undo_account_states(account_commitments).await?;
        Ok(())
    }
}

/// Encodes a [`NoteTagSource`] into the three optional hex-string columns the
/// `tags` `IndexedDB` store uses. Exactly one column is `Some` per non-`User`
/// variant — `get_note_tags` round-trips the variant back via that shape.
fn encode_tag_source(source: &NoteTagSource) -> (Option<String>, Option<String>, Option<String>) {
    match source {
        NoteTagSource::Note(commitment) => (Some(commitment.to_hex()), None, None),
        NoteTagSource::Account(account_id) => (None, Some(account_id.to_hex()), None),
        NoteTagSource::User => (None, None, None),
        NoteTagSource::Subscription(key) => (None, None, Some(key.to_hex())),
    }
}

type SerializedBlockData = (Vec<Vec<u8>>, Vec<u32>, Vec<u8>, Vec<String>, Vec<String>);

fn serialize_partial_blockchain_updates(
    partial_blockchain_updates: &PartialBlockchainUpdates,
) -> Result<SerializedBlockData, StoreError> {
    let mut block_headers_as_bytes = Vec::new();
    let mut block_nums = Vec::new();
    let mut block_has_relevant_notes = Vec::new();

    for (block_header, has_client_notes) in partial_blockchain_updates.block_headers() {
        block_headers_as_bytes.push(block_header.to_bytes());
        block_nums.push(block_header.block_num().as_u32());
        block_has_relevant_notes.push(u8::from(*has_client_notes));
    }

    let auth_nodes_len = partial_blockchain_updates.new_authentication_nodes().len();
    let mut serialized_node_ids = Vec::with_capacity(auth_nodes_len);
    let mut serialized_nodes = Vec::with_capacity(auth_nodes_len);
    for (id, node) in partial_blockchain_updates.new_authentication_nodes() {
        let SerializedPartialBlockchainNodeData { id, node } =
            serialize_partial_blockchain_node(*id, *node)?;
        serialized_node_ids.push(id);
        serialized_nodes.push(node);
    }

    Ok((
        block_headers_as_bytes,
        block_nums,
        block_has_relevant_notes,
        serialized_node_ids,
        serialized_nodes,
    ))
}
