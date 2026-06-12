use alloc::string::String;
use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

use crate::base64_to_vec_u8_required;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHeightIdxdbObject {
    pub block_num: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagIdxdbObject {
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub tag: Vec<u8>,
    /// Hex of a [`miden_client::note::NoteDetailsCommitment`] — set when the
    /// tag's source is [`miden_client::sync::NoteTagSource::Note`].
    pub source_note_id: Option<String>,
    /// Hex of an [`miden_client::account::AccountId`] — set when the tag's
    /// source is [`miden_client::sync::NoteTagSource::Account`].
    pub source_account_id: Option<String>,
    /// Hex of the subscription's anchoring [`miden_client::Word`] key — set
    /// when the tag's source is
    /// [`miden_client::sync::NoteTagSource::Subscription`].
    pub source_subscription_key: Option<String>,
}
