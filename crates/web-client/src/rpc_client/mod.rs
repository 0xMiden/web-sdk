//! RPC Client for Web Applications
//!
//! This module provides a WebAssembly-compatible RPC client for interacting with Miden nodes.

use alloc::collections::BTreeSet;
use alloc::sync::Arc;
use alloc::vec::Vec;

use js_export_macro::js_export;
use miden_client::block::BlockNumber;
use miden_client::builder::DEFAULT_GRPC_TIMEOUT_MS;
use miden_client::note::{NoteId as NativeNoteId, Nullifier};
use miden_client::rpc::domain::account::{GetAccountRequest, StorageMapFetch, VaultFetch};
use miden_client::rpc::domain::note::FetchedNote as NativeFetchedNote;
use miden_client::rpc::{AccountStateAt, GrpcClient, NodeRpcClient};
use note::FetchedNote;

use crate::js_error_with_context;
use crate::models::account_id::AccountId;
use crate::models::account_proof::AccountProof;
use crate::models::account_storage_requirements::AccountStorageRequirements;
use crate::models::block_header::BlockHeader;
use crate::models::endpoint::Endpoint;
use crate::models::fetched_account::FetchedAccount;
use crate::models::network_note_status::NetworkNoteStatusInfo;
use crate::models::note_id::NoteId;
use crate::models::note_script::NoteScript;
use crate::models::note_sync::NoteSyncInfo;
use crate::models::note_tag::NoteTag;
use crate::models::storage_map_info::StorageMapInfo;
use crate::models::word::Word;
use crate::platform::JsErr;

mod note;

/// RPC Client for interacting with Miden nodes directly.
#[js_export]
pub struct RpcClient {
    inner: Arc<dyn NodeRpcClient>,
}

#[js_export]
impl RpcClient {
    /// Creates a new RPC client instance.
    ///
    /// @param endpoint - Endpoint to connect to.
    #[js_export(constructor)]
    pub fn new(endpoint: Endpoint) -> Result<RpcClient, JsErr> {
        let rpc_client = Arc::new(GrpcClient::new(&endpoint.into(), DEFAULT_GRPC_TIMEOUT_MS));

        Ok(RpcClient { inner: rpc_client })
    }

    /// Returns the endpoint URL this RPC client is configured to talk to, or `undefined` if its
    /// transport doesn't track one.
    #[js_export(js_name = "endpoint")]
    pub fn endpoint(&self) -> Option<String> {
        self.inner.endpoint().map(str::to_string)
    }

    /// Fetches notes by their IDs from the connected Miden node.
    ///
    /// @param note_ids - Array of [`NoteId`] objects to fetch
    /// @returns Promise that resolves to different data depending on the note type:
    /// - Private notes: Returns the `noteHeader`, and the  `inclusionProof`. The `note` field will
    ///   be `null`.
    /// - Public notes: Returns the full `note` with `inclusionProof`, alongside its header.
    #[allow(clippy::doc_markdown)]
    #[js_export(js_name = "getNotesById")]
    pub async fn get_notes_by_id(&self, note_ids: Vec<NoteId>) -> Result<Vec<FetchedNote>, JsErr> {
        let native_note_ids: Vec<NativeNoteId> =
            note_ids.into_iter().map(NativeNoteId::from).collect();

        let fetched_notes = self
            .inner
            .get_notes_by_id(&native_note_ids)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get notes by ID"))?;

        let web_notes: Vec<FetchedNote> = fetched_notes
            .into_iter()
            .map(|native_note| match native_note {
                // 0.15 surface: private fetched notes carry the note ID, metadata, and
                // attachment content alongside the inclusion proof (the body stays off-chain).
                NativeFetchedNote::Private(note_id, metadata, attachments, inclusion_proof) => {
                    let attachments = attachments.iter().map(Into::into).collect();
                    FetchedNote::with_attachments(
                        note_id.into(),
                        metadata.into(),
                        inclusion_proof.into(),
                        None,
                        attachments,
                    )
                },
                NativeFetchedNote::Public(note, inclusion_proof) => {
                    let note_id = note.id();
                    let metadata = *note.metadata();
                    let attachments = note.attachments().iter().map(Into::into).collect();
                    FetchedNote::with_attachments(
                        note_id.into(),
                        metadata.into(),
                        inclusion_proof.into(),
                        Some(note.into()),
                        attachments,
                    )
                },
            })
            .collect();

        Ok(web_notes)
    }

    /// Fetches a note script by its root hash from the connected Miden node.
    ///
    /// @param script_root - The root hash of the note script to fetch.
    /// @returns Promise that resolves to the `NoteScript`, or `undefined` if the node has no
    ///   script for that root.
    #[allow(clippy::doc_markdown)]
    #[js_export(js_name = "getNoteScriptByRoot")]
    pub async fn get_note_script_by_root(
        &self,
        script_root: &Word,
    ) -> Result<Option<NoteScript>, JsErr> {
        let native_script_root = script_root.into();

        // 0.15 surface: the node returns `Option<NoteScript>` — `None` when the script root is
        // unknown — rather than erroring. Surface that as `Option<NoteScript>` on the JS side.
        let note_script = self
            .inner
            .get_note_script_by_root(native_script_root)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get note script by root"))?;

        Ok(note_script.map(Into::into))
    }

    /// Fetches a block header by number. When `block_num` is undefined, returns the latest header.
    ///
    /// @param `block_num` - Optional block number. When `undefined`, returns the latest header.
    /// @param `include_mmr_proof` - When `true`, includes the MMR proof in the response. Defaults
    ///   to `false` when `undefined`.
    #[js_export(js_name = "getBlockHeaderByNumber")]
    pub async fn get_block_header_by_number(
        &self,
        block_num: Option<u32>,
        include_mmr_proof: Option<bool>,
    ) -> Result<BlockHeader, JsErr> {
        let native_block_num = block_num.map(BlockNumber::from);
        let (header, _proof) = self
            .inner
            .get_block_header_by_number(native_block_num, include_mmr_proof.unwrap_or(false))
            .await
            .map_err(|err| js_error_with_context(err, "failed to get block header by number"))?;

        Ok(header.into())
    }

    /// Fetches account details for a specific account ID.
    #[js_export(js_name = "getAccountDetails")]
    pub async fn get_account_details(
        &self,
        account_id: &AccountId,
    ) -> Result<FetchedAccount, JsErr> {
        let native_id: miden_client::account::AccountId = account_id.into();

        // `get_account_details` returns only `Option<Account>`, without the commitment or block
        // height. Issue the underlying `get_account` request directly (full storage maps + vault)
        // so `FetchedAccount` can report the account commitment and last block height.
        let request = GetAccountRequest::new()
            .with_storage(StorageMapFetch::All)
            .with_vault(VaultFetch::Always);

        let (block_num, proof) = self
            .inner
            .get_account(native_id, request)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get account details"))?;

        FetchedAccount::from_proof(block_num, proof)
    }

    /// Fetches an account proof from the node.
    ///
    /// This is a lighter-weight alternative to `getAccountDetails` that makes a single RPC call
    /// and returns the account proof alongside the account header, storage slot values, and
    /// account code without reconstructing the full account state.
    ///
    /// For private accounts, the proof is returned but account details will not be available
    /// since they are not stored on-chain.
    ///
    /// Useful for reading storage slot values (e.g., faucet metadata) or specific storage map
    /// entries without the overhead of fetching the complete account with all vault assets and
    /// storage map entries.
    ///
    /// @param `account_id` - The account to fetch the proof for.
    /// @param `storage_requirements` - Optional storage requirements specifying which storage
    ///   maps and keys to include. When `undefined`, no storage map data is requested.
    /// @param `block_num` - Optional block number to fetch the account state at. When `undefined`,
    ///   fetches the latest state (chain tip).
    /// @param `known_vault_commitment` - Optional known vault commitment. When provided,
    ///   vault data is returned only if the account's current vault root differs from this
    ///   value. Use `Word.new([0, 0, 0, 0])` to always fetch. When `undefined`, vault data
    ///   is not requested.
    #[js_export(js_name = "getAccountProof")]
    pub async fn get_account_proof(
        &self,
        account_id: &AccountId,
        storage_requirements: Option<AccountStorageRequirements>,
        block_num: Option<u32>,
        known_vault_commitment: Option<Word>,
    ) -> Result<AccountProof, JsErr> {
        let native_id: miden_client::account::AccountId = account_id.into();

        // Storage requirements are wrapped in a `StorageMapFetch` policy: named slots map to
        // `Slots(..)`, and their absence maps to `Skip` (request only the storage header).
        let storage_fetch = match storage_requirements {
            Some(reqs) => StorageMapFetch::Slots(reqs.into()),
            None => StorageMapFetch::Skip,
        };

        let account_state = match block_num {
            Some(num) => AccountStateAt::Block(BlockNumber::from(num)),
            None => AccountStateAt::ChainTip,
        };

        // 0.15 surface: `get_account_proof` was renamed/reshaped to `get_account` taking a
        // `GetAccountRequest` builder. The semantics carry over 1:1 — storage requirements,
        // a target block, and an optional known vault commitment to short-circuit re-sending
        // unchanged vault data. `known_code` is left at its `None` default, so the node always
        // re-sends the account code, matching the previous call.
        let vault = match known_vault_commitment {
            Some(commitment) => VaultFetch::IfChangedFrom(commitment.into()),
            None => VaultFetch::Skip,
        };

        let request = GetAccountRequest::new()
            .with_storage(storage_fetch)
            .at(account_state)
            .with_vault(vault);

        let (block_num, proof) = self
            .inner
            .get_account(native_id, request)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get account proof"))?;

        Ok(AccountProof::new(proof, block_num))
    }

    /// Syncs storage map updates for an account within a block range.
    ///
    /// This is used when `AccountProof.hasStorageMapTooManyEntries()` returns `true` for a
    /// slot, indicating the storage map was too large to return inline. This endpoint fetches
    /// the full storage map data with pagination support.
    ///
    /// @param `block_from` - The starting block number.
    /// @param `block_to` - Optional ending block number. When `undefined`, the current chain tip
    ///   is fetched with an extra RPC call and used as the bound (the node rejects values greater
    ///   than the tip).
    /// @param `account_id` - The account to sync storage maps for.
    #[js_export(js_name = "syncStorageMaps")]
    pub async fn sync_storage_maps(
        &self,
        block_from: u32,
        block_to: Option<u32>,
        account_id: &AccountId,
    ) -> Result<StorageMapInfo, JsErr> {
        let native_id: miden_client::account::AccountId = account_id.into();
        let block_from = BlockNumber::from(block_from);
        let block_to = if let Some(block_to) = block_to {
            BlockNumber::from(block_to)
        } else {
            let (chain_tip, _) = self
                .inner
                .get_block_header_by_number(None, false)
                .await
                .map_err(|err| js_error_with_context(err, "failed to fetch chain tip"))?;
            chain_tip.block_num()
        };

        let info = self
            .inner
            .sync_storage_maps(block_from, block_to, native_id)
            .await
            .map_err(|err| js_error_with_context(err, "failed to sync storage maps"))?;

        Ok(info.into())
    }

    /// Fetches notes matching the provided tags from the node.
    #[js_export(js_name = "syncNotes")]
    pub async fn sync_notes(
        &self,
        block_from: u32,
        block_to: u32,
        note_tags: Vec<NoteTag>,
    ) -> Result<NoteSyncInfo, JsErr> {
        let mut tags = BTreeSet::new();
        for tag in note_tags {
            tags.insert(tag.into());
        }

        let block_from = BlockNumber::from(block_from);
        let block_to = BlockNumber::from(block_to);

        let blocks = self
            .inner
            .sync_notes(block_from, block_to, &tags)
            .await
            .map_err(|err| js_error_with_context(err, "failed to sync notes"))?;

        Ok(NoteSyncInfo::new(blocks, block_to))
    }

    /// Fetches the processing status of a network note by its ID.
    ///
    /// Returns information about the note's current status in the network,
    /// including whether it is pending, processed, discarded, or committed,
    /// along with error details and attempt count.
    ///
    /// @param `note_id` - The ID of the note to query.
    /// @returns Promise that resolves to a `NetworkNoteStatusInfo` object.
    #[js_export(js_name = "getNetworkNoteStatus")]
    pub async fn get_network_note_status(
        &self,
        note_id: &NoteId,
    ) -> Result<NetworkNoteStatusInfo, JsErr> {
        let native_note_id: NativeNoteId = note_id.into();

        let status_info = self
            .inner
            .get_network_note_status(native_note_id)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get network note status"))?;

        Ok(status_info.into())
    }

    // TODO: This can be generalized to retrieve multiple nullifiers
    /// Fetches the block height at which a nullifier was committed, if any.
    #[js_export(js_name = "getNullifierCommitHeight")]
    pub async fn get_nullifier_commit_height(
        &self,
        nullifier: &Word,
        block_num: u32,
    ) -> Result<Option<u32>, JsErr> {
        let native_word: miden_client::Word = nullifier.into();
        // TODO: nullifier JS binding
        let nullifier = Nullifier::from_raw(native_word);
        let block_num = BlockNumber::from(block_num);

        let mut requested_nullifiers = BTreeSet::new();
        requested_nullifiers.insert(nullifier);

        let height = self
            .inner
            .get_nullifier_commit_heights(requested_nullifiers, block_num)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get nullifier commit height"))?
            .into_iter()
            .next()
            .and_then(|(_, height)| height);

        Ok(height.map(|height| height.as_u32()))
    }
}
