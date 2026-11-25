use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::{Account, AccountHeader, AccountId, AccountPatch};
use miden_client::crypto::{Forest, MmrPeaks};
use miden_client::note::{BlockNumber, NoteDetailsCommitment, NoteTag, NoteUpdateTracker};
use miden_client::protocol_config::{ProtocolConfig, protocol_config_setting_key};
use miden_client::store::{SettingScope, StoreError};
use miden_client::sync::{
    AccountUpdates,
    NoteTagRecord,
    NoteTagSource,
    PartialBlockchainUpdates,
    PublicAccountUpdate,
    StateSyncUpdate,
    TransactionUpdateTracker,
};
use miden_client::utils::{Deserializable, Serializable};
use miden_client_proto::{decode_mmr_peaks, encode, encode_mmr_peaks};

use super::IdxdbStore;
use super::account::utils::creation_account_from_patch;
use super::chain_data::utils::{
    SerializedPartialBlockchainNodeData,
    serialize_partial_blockchain_node,
};
use super::note::utils::{
    SerializedInputNoteData,
    SerializedOutputNoteData,
    serialize_input_note,
    serialize_output_note,
};
use super::transaction::utils::serialize_transaction_record;
use crate::promise::{await_js, await_js_value};

mod js_bindings;
pub use js_bindings::{JsAccountPatchUpdate, JsAccountUpdate};
use js_bindings::{
    JsAccountWitnessUpdate,
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

        let forest = Forest::new(
            usize::try_from(peaks_idxdb.block_num).expect("u32 block_num should fit in usize"),
        )?;
        Ok(decode_mmr_peaks(forest, &peaks_idxdb.peaks)?)
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

    /// Persists a sync result in one `IndexedDB` transaction (`applyStateSync`): the sync height,
    /// block headers and MMR nodes, notes, transactions, account replacements and witnesses,
    /// incremental account patches, the undo of discarded transactions and account locks. A
    /// failure anywhere rolls the whole write back, so the height never moves past rows that were
    /// not written.
    ///
    /// Everything that needs a read, the forest or WASM work is therefore done here, before the
    /// call: Dexie auto-commits a transaction that awaits anything but its own requests, so the
    /// transaction body cannot call back into WASM. The one write outside it is the protocol
    /// configuration, which lands first (see [`Self::persist_protocol_config`]). The SMT forest
    /// is rebuilt for replaced accounts only after the write landed.
    pub(super) async fn apply_state_sync(
        &self,
        state_sync_update: StateSyncUpdate,
    ) -> Result<(), StoreError> {
        let (
            block_num,
            partial_blockchain_updates,
            note_updates,
            transaction_updates,
            account_updates,
            protocol_config,
        ) = state_sync_update.into_parts();

        let (
            block_headers_as_bytes,
            block_nums,
            block_has_relevant_notes,
            serialized_node_ids,
            serialized_nodes,
        ) = serialize_partial_blockchain_updates(&partial_blockchain_updates)?;

        let new_peaks_bytes = encode_mmr_peaks(&partial_blockchain_updates.new_peaks);

        let (serialized_input_notes, serialized_output_notes, committed_note_tag_sources) =
            serialize_note_updates(&note_updates);

        let locked_account_ids = self.accounts_to_lock(&account_updates).await?;

        let (undo_account_commitments, discarded_account_ids) = undo_plan(&transaction_updates);

        let transaction_updates: Vec<_> = transaction_updates
            .committed_transactions()
            .chain(transaction_updates.discarded_transactions())
            .map(serialize_transaction_record)
            .collect();

        let (full_accounts, patch_updates) = split_public_account_updates(&account_updates)?;
        let account_patches = self
            .prepare_account_patches(
                patch_updates,
                &discarded_account_ids,
                &undo_account_commitments,
            )
            .await?;

        self.persist_protocol_config(protocol_config).await?;

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
            account_witnesses: account_updates
                .account_witnesses()
                .iter()
                .map(|(account_id, witness)| JsAccountWitnessUpdate {
                    account_id: account_id.to_string(),
                    witness: encode(witness),
                })
                .collect(),
            account_patches,
            undo_account_commitments,
            locked_account_ids,
        };
        let promise = idxdb_apply_state_sync(self.db_id(), state_update);
        await_js_value(promise, "failed to apply state sync").await?;

        // Rebuild the forest for the accounts the write just replaced. Deferred until the write
        // landed so a failed sync leaves the forest untouched instead of ahead of the tables.
        for account in &full_accounts {
            self.smt_forest.write().rebuild_account(account)?;
        }

        Ok(())
    }

    /// The mismatched private accounts that should be locked, as hex ids. Locked inside the sync
    /// transaction.
    async fn accounts_to_lock(
        &self,
        account_updates: &AccountUpdates,
    ) -> Result<Vec<String>, StoreError> {
        let mut locked_account_ids = Vec::new();
        for (account_id, digest) in account_updates.mismatched_private_accounts() {
            let lock_check = self.should_lock_on_unexpected_commitment(account_id, digest).await;
            let should_lock = lock_check.map_err(|err| {
                StoreError::DatabaseError(format!("failed to check account mismatch: {err:?}"))
            })?;
            if should_lock {
                locked_account_ids.push(account_id.to_string());
            }
        }
        Ok(locked_account_ids)
    }

    /// Prepares the incremental patches for the sync transaction: checks each moves its account
    /// forward from the state it will apply to, and advances the forest. The values are already
    /// absolute, so no account reconstruction is required; the write happens in `applyStateSync`.
    async fn prepare_account_patches(
        &self,
        patch_updates: Vec<(&AccountHeader, &AccountPatch)>,
        discarded_account_ids: &BTreeSet<AccountId>,
        undo_account_commitments: &[String],
    ) -> Result<Vec<JsAccountPatchUpdate>, StoreError> {
        // A patch for an account with a discarded transaction applies to the state after the undo,
        // which is written with the sync, so read that state without persisting the undo.
        let overlapping: Vec<AccountId> = patch_updates
            .iter()
            .map(|(header, _)| header.id())
            .filter(|id| discarded_account_ids.contains(id))
            .collect();
        let mut post_undo_headers = if overlapping.is_empty() {
            BTreeMap::new()
        } else {
            self.headers_after_undo(undo_account_commitments.to_vec(), &overlapping).await?
        };

        let mut account_patches = Vec::with_capacity(patch_updates.len());
        for (new_header, patch) in patch_updates {
            let account_id = new_header.id();

            // Sync patches must move the account state forward; a stale or replayed patch would
            // otherwise silently rewind tracked state.
            let initial = match post_undo_headers.remove(&account_id) {
                Some(header) => header,
                None => self.current_account_header(account_id).await?,
            };
            if new_header.nonce().as_canonical_u64() <= initial.nonce().as_canonical_u64() {
                return Err(StoreError::DatabaseError(format!(
                    "sync account patch nonce {} is not greater than the local nonce {} for account {account_id}",
                    new_header.nonce().as_canonical_u64(),
                    initial.nonce().as_canonical_u64(),
                )));
            }

            account_patches
                .push(self.prepare_incremental_account_patch(new_header, patch, &initial)?);
        }
        Ok(account_patches)
    }

    /// Persists the protocol configuration the node sent before the chain state that commits to
    /// it lands. A failed write here fails the sync, which retries from the same height and is
    /// delivered the configuration again; a configuration stored ahead of a failed state write
    /// is only an unused row keyed by its commitment.
    async fn persist_protocol_config(
        &self,
        protocol_config: Option<ProtocolConfig>,
    ) -> Result<(), StoreError> {
        if let Some(config) = protocol_config {
            self.set_setting(
                SettingScope::Client,
                protocol_config_setting_key(config.to_commitment()),
                config.to_bytes(),
            )
            .await?;
        }
        Ok(())
    }
}

/// Serializes the updated notes for the sync transaction, and lists the details commitments whose
/// tags it prunes.
///
/// Tags for tracked expected notes are keyed by the note's details commitment
/// (`NoteTagSource::Note`), which `encode_tag_source` writes into the `tags.sourceNoteId` column.
/// They are pruned once the note is no longer inclusion-pending (committed, consumed, or
/// invalidated), matching sqlite-store. Collecting only `is_committed()` missed notes that went
/// expected -> consumed during catch-up without a committed sync update, which left shared
/// pair-tag rows forever (#525).
fn serialize_note_updates(
    note_updates: &NoteUpdateTracker,
) -> (Vec<SerializedInputNoteData>, Vec<SerializedOutputNoteData>, Vec<String>) {
    let serialized_input_notes = note_updates
        .updated_input_notes()
        .map(|note| serialize_input_note(note.inner()))
        .collect();
    let serialized_output_notes = note_updates
        .updated_output_notes()
        .map(|note| serialize_output_note(note.inner()))
        .collect();
    let committed_note_tag_sources = note_updates
        .updated_input_notes()
        .filter(|update| !update.inner().is_inclusion_pending())
        .map(|update| update.inner().details_commitment().to_hex())
        .collect();
    (serialized_input_notes, serialized_output_notes, committed_note_tag_sources)
}

/// The commitments of the account states the discarded transactions produced, to undo inside the
/// sync transaction, and the accounts they belong to.
///
/// Undoing restores the previous account states. The forest keeps the undone roots until a reader
/// sees them differ from the tables and refreshes the account.
fn undo_plan(transaction_updates: &TransactionUpdateTracker) -> (Vec<String>, BTreeSet<AccountId>) {
    let undo_account_commitments = transaction_updates
        .discarded_transactions()
        .map(|tx_record| tx_record.details.final_account_state.to_string())
        .collect();
    let discarded_account_ids = transaction_updates
        .discarded_transactions()
        .map(|tx_record| tx_record.details.account_id)
        .collect();
    (undo_account_commitments, discarded_account_ids)
}

/// Full accounts to replace, and the incremental patches with the header each advances to.
type SplitAccountUpdates<'a> = (Vec<Account>, Vec<(&'a AccountHeader, &'a AccountPatch)>);

/// Separates full account updates from incremental absolute patches. An oversized newly created
/// account (final nonce 1) arrives as a creation patch rather than a full account; it is rebuilt
/// so it follows the same replacement path. Code on a later nonce is an upgrade and stays on the
/// incremental path.
fn split_public_account_updates(
    account_updates: &AccountUpdates,
) -> Result<SplitAccountUpdates<'_>, StoreError> {
    let mut full_accounts: Vec<Account> = Vec::new();
    let mut patch_updates = Vec::new();
    for update in account_updates.updated_public_accounts() {
        match update {
            PublicAccountUpdate::Full(account) => full_accounts.push(account.clone()),
            PublicAccountUpdate::Patch { new_header, patch } => {
                if let Some(account) = creation_account_from_patch(patch, new_header)? {
                    full_accounts.push(account);
                } else {
                    patch_updates.push((new_header, patch));
                }
            },
        }
    }
    Ok((full_accounts, patch_updates))
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
        block_headers_as_bytes.push(encode(block_header));
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
