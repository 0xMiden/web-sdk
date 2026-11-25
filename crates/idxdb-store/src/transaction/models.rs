use alloc::string::String;
use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

use crate::{base64_to_vec_u8_optional, base64_to_vec_u8_required};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionIdxdbObject {
    pub id: String,
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub details: Vec<u8>,
    #[serde(deserialize_with = "base64_to_vec_u8_optional", default)]
    pub script_root: Option<Vec<u8>>,
    #[serde(deserialize_with = "base64_to_vec_u8_optional", default)]
    pub tx_script: Option<Vec<u8>>,
    pub block_num: u32,
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub status: Vec<u8>,
}

/// A stored transaction log. The topic and the content are base64 strings of their byte
/// encodings.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionLogIdxdbObject {
    pub emitter: String,
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub topic: Vec<u8>,
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub content: Vec<u8>,
}
