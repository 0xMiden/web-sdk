use alloc::string::String;
use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

use crate::{base64_to_vec_u8_optional, base64_to_vec_u8_required};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCodeIdxdbObject {
    pub root: String,
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub code: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_field_names)]
pub struct AccountStorageIdxdbObject {
    pub slot_name: String,
    pub slot_value: String,
    pub slot_type: u8,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMapEntryIdxdbObject {
    pub slot_name: String,
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAssetIdxdbObject {
    pub vault_key: String,
    pub asset: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecordIdxdbObject {
    pub id: String,
    pub nonce: String,
    pub vault_root: String,
    pub storage_root: String,
    pub code_root: String,
    #[serde(deserialize_with = "base64_to_vec_u8_optional", default)]
    pub account_seed: Option<Vec<u8>>,
    pub locked: bool,
    #[serde(default)]
    pub watched: bool,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddressIdxdbObject {
    pub address: Vec<u8>,
    pub id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignAccountCodeIdxdbObject {
    pub account_id: String,
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub code: Vec<u8>,
}

/// Post-undo state of one account, from `getPostUndoAccountStates`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostUndoAccountStateIdxdbObject {
    pub account_id: String,
    pub vault_assets: Vec<PostUndoVaultAssetIdxdbObject>,
    pub storage_map_entries: Vec<PostUndoMapEntryIdxdbObject>,
    pub storage_slots: Vec<PostUndoStorageSlotIdxdbObject>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostUndoVaultAssetIdxdbObject {
    pub vault_key: String,
    pub asset: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostUndoMapEntryIdxdbObject {
    pub slot_name: String,
    pub key: String,
    pub value: String,
}

// Field names mirror the JS row shape.
#[allow(clippy::struct_field_names)]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostUndoStorageSlotIdxdbObject {
    pub slot_name: String,
    pub slot_value: String,
    pub slot_type: u8,
}
