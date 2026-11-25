use alloc::string::{String, ToString};
use alloc::vec::Vec;

use js_export_macro::js_export;
use miden_client::rpc::domain::status::{
    NetworkNoteSponsorship as NativeNetworkNoteSponsorship,
    NetworkNoteStatus as NativeNetworkNoteStatus,
    NetworkNoteStatusInfo as NativeNetworkNoteStatusInfo,
};

use crate::models::asset::VaultAsset;
use crate::models::note_id::NoteId;

/// Status of a network note in the node.
#[js_export(js_name = "NetworkNoteStatusInfo")]
pub struct NetworkNoteStatusInfo {
    status: NativeNetworkNoteStatus,
    last_error: Option<String>,
    attempt_count: u32,
    last_attempt_block_num: Option<u32>,
    sponsorships: Vec<NetworkNoteSponsorship>,
}

#[js_export]
impl NetworkNoteStatusInfo {
    /// Returns the status as a string: `"Pending"`, `"NullifierInflight"`, `"Discarded"`, or
    /// `"NullifierCommitted"`.
    #[js_export(getter)]
    pub fn status(&self) -> String {
        self.status.to_string()
    }

    /// Returns the last error message, if any.
    #[js_export(getter, js_name = "lastError")]
    pub fn last_error(&self) -> Option<String> {
        self.last_error.clone()
    }

    /// Returns the number of processing attempts.
    #[js_export(getter, js_name = "attemptCount")]
    pub fn attempt_count(&self) -> u32 {
        self.attempt_count
    }

    /// Returns the block number of the last processing attempt, if any.
    #[js_export(getter, js_name = "lastAttemptBlockNum")]
    pub fn last_attempt_block_num(&self) -> Option<u32> {
        self.last_attempt_block_num
    }

    /// Returns the fee sponsorship notes that the node binds to this note.
    pub fn sponsorships(&self) -> Vec<NetworkNoteSponsorship> {
        self.sponsorships.clone()
    }
}

/// A fee sponsorship note that pays the fee for a network note.
#[derive(Clone)]
#[js_export(js_name = "NetworkNoteSponsorship")]
pub struct NetworkNoteSponsorship {
    note_id: NoteId,
    fee_asset: VaultAsset,
    reclaim_height: Option<u32>,
    committed_block_num: Option<u32>,
    last_error: Option<String>,
    last_attempt_block_num: Option<u32>,
}

#[js_export]
impl NetworkNoteSponsorship {
    /// Returns the ID of the sponsorship note.
    #[js_export(js_name = "noteId")]
    pub fn note_id(&self) -> NoteId {
        self.note_id
    }

    /// Returns the fee asset that the sponsorship note carries.
    #[js_export(js_name = "feeAsset")]
    pub fn fee_asset(&self) -> VaultAsset {
        self.fee_asset
    }

    /// Returns the block number at or after which the reclaimer can reclaim the note, or
    /// `undefined` if reclaim is disabled.
    #[js_export(getter, js_name = "reclaimHeight")]
    pub fn reclaim_height(&self) -> Option<u32> {
        self.reclaim_height
    }

    /// Returns the block number in which the sponsorship note was consumed, or `undefined` while
    /// the note is not consumed.
    #[js_export(getter, js_name = "committedBlockNum")]
    pub fn committed_block_num(&self) -> Option<u32> {
        self.committed_block_num
    }

    /// Returns the error message of the most recent failed processing attempt of the sponsorship
    /// note, if any.
    #[js_export(getter, js_name = "lastError")]
    pub fn last_error(&self) -> Option<String> {
        self.last_error.clone()
    }

    /// Returns the block number of the last failed processing attempt of the sponsorship note, if
    /// any.
    #[js_export(getter, js_name = "lastAttemptBlockNum")]
    pub fn last_attempt_block_num(&self) -> Option<u32> {
        self.last_attempt_block_num
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNetworkNoteStatusInfo> for NetworkNoteStatusInfo {
    fn from(native: NativeNetworkNoteStatusInfo) -> Self {
        Self {
            status: native.status,
            last_error: native.last_error,
            attempt_count: native.attempt_count,
            last_attempt_block_num: native.last_attempt_block_num,
            sponsorships: native.sponsorships.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<NativeNetworkNoteSponsorship> for NetworkNoteSponsorship {
    fn from(native: NativeNetworkNoteSponsorship) -> Self {
        Self {
            note_id: native.note_id.into(),
            fee_asset: native.fee_asset.into(),
            reclaim_height: native.reclaim_height,
            committed_block_num: native.committed_block_num,
            last_error: native.last_error,
            last_attempt_block_num: native.last_attempt_block_num,
        }
    }
}
