use js_export_macro::js_export;
use miden_client::account::AccountVaultPatch as NativeAccountVaultPatch;
use miden_objects::proto;

use crate::models::fungible_asset::FungibleAsset;
use crate::models::word::Word;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{decode_message, encode_message};

/// Absolute updates to account vault entries.
#[derive(Clone)]
#[js_export]
pub struct AccountVaultPatch(NativeAccountVaultPatch);

#[js_export]
impl AccountVaultPatch {
    /// Serializes the vault patch into the bytes of its `miden-objects` protobuf message.
    pub fn serialize(&self) -> JsBytes {
        encode_message(&proto::account::AccountVaultPatch::from(&self.0))
    }

    /// Deserializes a vault patch from the bytes that [`Self::serialize`] returns.
    ///
    /// Bytes that an earlier SDK version wrote with the Winterfell encoding do not decode.
    pub fn deserialize(bytes: JsBytes) -> Result<AccountVaultPatch, JsErr> {
        decode_message::<proto::account::AccountVaultPatch>(&bytes).map(Self)
    }

    /// Returns true if no vault entries are changed.
    #[js_export(js_name = "isEmpty")]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Returns the number of changed vault entries.
    #[js_export(js_name = "numAssets")]
    pub fn num_assets(&self) -> usize {
        self.0.num_assets()
    }

    /// Returns fungible assets whose final balance was added or updated.
    #[js_export(js_name = "updatedFungibleAssets")]
    pub fn updated_fungible_assets(&self) -> Vec<FungibleAsset> {
        self.0
            .updated_assets()
            .filter(miden_client::asset::Asset::is_fungible)
            .map(|asset| asset.unwrap_fungible().into())
            .collect()
    }

    /// Returns the IDs of removed assets as their canonical words.
    #[js_export(js_name = "removedAssetIds")]
    pub fn removed_asset_ids(&self) -> Vec<Word> {
        self.0.removed_asset_ids().map(|id| id.to_word().into()).collect()
    }
}

impl From<NativeAccountVaultPatch> for AccountVaultPatch {
    fn from(patch: NativeAccountVaultPatch) -> Self {
        Self(patch)
    }
}

impl From<&NativeAccountVaultPatch> for AccountVaultPatch {
    fn from(patch: &NativeAccountVaultPatch) -> Self {
        Self(patch.clone())
    }
}

impl From<AccountVaultPatch> for NativeAccountVaultPatch {
    fn from(patch: AccountVaultPatch) -> Self {
        patch.0
    }
}
