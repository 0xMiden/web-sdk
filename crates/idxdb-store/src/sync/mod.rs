use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::{Account, AccountHeader, AccountId, AccountPatch};
use miden_client::crypto::{Forest, MerkleError, MmrPeaks};
use miden_client::note::{BlockNumber, NoteDetailsCommitment, NoteTag};
use miden_client::store::forest_backend::{
    ForestPrefetchPlan,
    RowForestBackend,
    SmtForestUpdateBatch,
    plan_update,
};
use miden_client::store::{StoreError, add_vault_ops, vault_lineage_id};
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
    AccountForestTargets,
    account_from_full_state_patch,
    add_storage_map_patch_ops,
    build_js_account_patch_update,
    overlay_patch_on_targets,
    parse_post_undo_targets,
    patched_storage_slots,
};
use super::chain_data::utils::{
    SerializedPartialBlockchainNodeData,
    serialize_partial_blockchain_node,
};
use super::note::utils::{serialize_input_note, serialize_output_note};
use super::transaction::utils::serialize_transaction_record;
use crate::forest::cache::{ForestDirtyDelta, ForestRowCache};
use crate::forest::js_bindings::JsForestUpdate;
use crate::forest::{self, CachedAccountForest};
use crate::promise::{await_js, await_js_value};

mod js_bindings;
pub use js_bindings::{JsAccountPatchUpdate, JsAccountUpdate};
use js_bindings::{
    JsPostUndoExpectation,
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

        let account_commitments_to_undo: Vec<String> = transaction_updates
            .discarded_transactions()
            .map(|tx_record| tx_record.details.final_account_state.to_hex())
            .collect();
        let rolled_back_accounts: Vec<AccountId> = transaction_updates
            .discarded_transactions()
            .map(|tx_record| tx_record.details.account_id)
            .collect();

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
                    full_accounts.push(account_from_full_state_patch(patch, new_header)?);
                },
                PublicAccountUpdate::Patch { new_header, patch } => {
                    patch_updates.push((new_header, patch));
                },
            }
        }

        // Sync patches on otherwise-untouched accounts must move the account state forward; a
        // stale or replayed patch would otherwise silently rewind tracked state. Patches on
        // rolled-back or fully-replaced accounts cannot be checked against the pre-sync local
        // header; the write transaction validates them against the restored state instead.
        let reconciled_ids: BTreeSet<AccountId> = rolled_back_accounts
            .iter()
            .copied()
            .chain(full_accounts.iter().map(Account::id))
            .collect();
        for (new_header, _) in &patch_updates {
            let account_id = new_header.id();
            if reconciled_ids.contains(&account_id) {
                continue;
            }
            let (local_header, _) = self
                .get_account_header(account_id)
                .await?
                .ok_or(StoreError::AccountDataNotFound(account_id))?;
            if new_header.nonce().as_canonical_u64() <= local_header.nonce().as_canonical_u64() {
                return Err(StoreError::DatabaseError(format!(
                    "sync account patch nonce {} is not greater than the local nonce {} for account {account_id}",
                    new_header.nonce().as_canonical_u64(),
                    local_header.nonce().as_canonical_u64(),
                )));
            }
        }

        let base_state_update = JsStateSyncUpdate {
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
            account_commitments_to_undo,
            expected_post_undo_states: Vec::new(),
            account_patch_updates: Vec::new(),
            transaction_updates,
        };

        // Compute one reconciled forest delta covering the undo, the full account updates, and
        // the incremental patches, so the whole sync commits it in a single transaction. A
        // conflict (concurrent commit between the snapshot and the write-back, or a stale undo
        // plan) restarts the computation from a fresh snapshot.
        let mut attempt = 0;
        loop {
            attempt += 1;
            let result = match self
                .compute_sync_forest_update(
                    &base_state_update.account_commitments_to_undo,
                    &full_accounts,
                    &patch_updates,
                )
                .await
            {
                Ok((forest_update, account_patch_updates, expected_post_undo_states)) => {
                    let mut state_update = base_state_update.clone();
                    state_update.account_patch_updates = account_patch_updates;
                    state_update.expected_post_undo_states = expected_post_undo_states;
                    let promise = idxdb_apply_state_sync(self.db_id(), state_update, forest_update);
                    await_js_value(promise, "failed to apply state sync").await.map(|_| ())
                },
                Err(err) => Err(err),
            };
            match result {
                Err(err)
                    if attempt < forest::MAX_FOREST_ATTEMPTS
                        && forest::is_forest_conflict(&err) => {},
                result => return result,
            }
        }
    }

    /// Computes the sync's single reconciled forest delta, together with the serialized
    /// per-account patch payloads (whose updated map roots come from the forest's post-apply
    /// state) and the post-undo account states the write transaction must re-validate.
    ///
    /// Rolled-back accounts reconcile to the state the undo restores; full updates reconcile to
    /// the replacement state (winning over a rollback of the same account); patches on
    /// reconciled accounts overlay their absolute values on the reconcile target, while patches
    /// on untouched accounts contribute incremental operations directly.
    #[allow(clippy::too_many_lines)]
    async fn compute_sync_forest_update(
        &self,
        undo_commitments: &[String],
        full_accounts: &[Account],
        patch_updates: &[(&AccountHeader, &AccountPatch)],
    ) -> Result<(JsForestUpdate, Vec<JsAccountPatchUpdate>, Vec<JsPostUndoExpectation>), StoreError>
    {
        // Syncs with no account work carry no forest update at all, so they neither consume a
        // revision nor contend with concurrent account writes.
        if undo_commitments.is_empty() && full_accounts.is_empty() && patch_updates.is_empty() {
            let empty = forest::forest_update_payload(ForestDirtyDelta::default())?;
            return Ok((empty, Vec::new(), Vec::new()));
        }

        let snapshot = forest::load_forest_snapshot(self.db_id()).await?;
        let revision = snapshot.next_revision;
        let cache = ForestRowCache::new(snapshot.trees.clone(), Some(revision));

        // Post-undo baselines for rolled-back accounts. The states resolved here are also the
        // expectations the write transaction re-validates after running the undo, so a
        // concurrent history prune cannot silently change what the undo restores.
        let mut reconcile: BTreeMap<AccountId, AccountForestTargets> = BTreeMap::new();
        let mut expected_post_undo_states = Vec::new();
        for state in self.get_post_undo_account_states(undo_commitments).await? {
            expected_post_undo_states.push(JsPostUndoExpectation {
                account_id: state.account_id.clone(),
                commitment: state.commitment.clone(),
            });
            let targets = parse_post_undo_targets(&state)?;
            reconcile.insert(targets.account_id, targets);
        }

        // Full updates replace the whole account state.
        for account in full_accounts {
            let (vault, maps) = forest::account_forest_targets(account.vault(), account.storage());
            reconcile.insert(
                account.id(),
                AccountForestTargets { account_id: account.id(), vault, maps },
            );
        }

        // Patches overlay reconciled accounts; others apply incrementally.
        let mut incremental: Vec<(&AccountHeader, &AccountPatch)> = Vec::new();
        for (new_header, patch) in patch_updates {
            if let Some(targets) = reconcile.get_mut(&new_header.id()) {
                overlay_patch_on_targets(targets, patch);
            } else {
                incremental.push((new_header, patch));
            }
        }

        // Incremental map patches layer onto the forest's latest trees, which must match the
        // roots recorded in the account tables (same divergence check as the local patch path).
        for (new_header, patch) in &incremental {
            self.check_map_patch_roots(new_header.id(), patch, &snapshot.trees).await?;
        }

        // Build one batch: reconcile ops (with their own full-coverage prefetch), then
        // incremental ops (map resets need their lineage's stored keys).
        let mut batch = SmtForestUpdateBatch::empty();
        let reconcile_targets: Vec<AccountForestTargets> = reconcile.into_values().collect();
        self.add_targets_reconcile_ops(&snapshot, &cache, &mut batch, &reconcile_targets)
            .await?;

        let mut reset_plan = ForestPrefetchPlan::default();
        for (new_header, patch) in &incremental {
            let account_id = new_header.id();
            for (slot_name, map_patch) in patch.storage().maps() {
                let patch_op = map_patch.patch_op();
                let lineage = miden_client::store::storage_map_lineage_id(account_id, slot_name);
                if (patch_op.is_create() || patch_op.is_remove())
                    && snapshot.trees.contains_key(&lineage)
                {
                    reset_plan.full_lineages.insert(lineage);
                }
            }
        }
        forest::prefetch_rows(self.db_id(), &reset_plan, &cache, revision).await?;

        for (new_header, patch) in &incremental {
            let account_id = new_header.id();
            add_vault_ops(
                &mut batch,
                account_id,
                patch.vault().updated_assets(),
                patch.vault().removed_asset_ids().copied(),
            );
            add_storage_map_patch_ops(&cache, account_id, &mut batch, patch)?;
        }

        let plan = plan_update(batch.clone(), &snapshot.trees);
        forest::prefetch_rows(self.db_id(), &plan, &cache, revision).await?;

        let mut smt_forest = CachedAccountForest::new(RowForestBackend::new(cache.clone()))?;
        smt_forest.apply_updates(revision, batch)?;

        // Verify vault roots and build the per-account patch payloads from post-apply roots.
        // Patches on reconciled accounts are included too: inside the write transaction the
        // undo (or full update) runs first, then the patch moves the account rows to the same
        // state the forest target already reflects.
        let mut account_patch_updates = Vec::new();
        for (new_header, patch) in patch_updates {
            let account_id = new_header.id();
            let vault_root = smt_forest
                .latest_root(vault_lineage_id(account_id))
                .ok_or(StoreError::AccountDataNotFound(account_id))?;
            if vault_root != new_header.vault_root() {
                return Err(StoreError::MerkleStoreError(MerkleError::ConflictingRoots {
                    expected_root: new_header.vault_root(),
                    actual_root: vault_root,
                }));
            }
            let updated_assets: Vec<_> = patch.vault().updated_assets().collect();
            let removed_asset_ids: Vec<_> = patch.vault().removed_asset_ids().copied().collect();
            let updated_slots = patched_storage_slots(&smt_forest, account_id, patch)?;
            account_patch_updates.push(build_js_account_patch_update(
                account_id,
                new_header,
                &updated_slots,
                &updated_assets,
                &removed_asset_ids,
                patch,
            ));
        }
        for account in full_accounts {
            let vault_root = smt_forest
                .latest_root(vault_lineage_id(account.id()))
                .ok_or(StoreError::AccountDataNotFound(account.id()))?;
            if vault_root != account.vault().root() {
                return Err(StoreError::MerkleStoreError(MerkleError::ConflictingRoots {
                    expected_root: account.vault().root(),
                    actual_root: vault_root,
                }));
            }
        }

        drop(smt_forest);
        let forest_update = forest::forest_update_payload(cache.into_dirty_delta())?;
        Ok((forest_update, account_patch_updates, expected_post_undo_states))
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
