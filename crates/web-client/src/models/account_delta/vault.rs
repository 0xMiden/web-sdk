use js_export_macro::js_export;
use miden_client::asset::{AccountVaultDelta as NativeAccountVaultDelta, Asset};

use crate::models::fungible_asset::FungibleAsset;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_from_bytes, serialize_to_bytes};

/// `AccountVaultDelta` stores the difference between the initial and final account vault states.
///
/// The difference is a set of whole assets added to or removed from the vault, keyed by asset ID.
/// An asset appears at most once, on one side or the other: a delta carrying the same asset ID
/// twice is rejected when it is built.
#[derive(Clone)]
#[js_export]
pub struct AccountVaultDelta(NativeAccountVaultDelta);

#[js_export]
impl AccountVaultDelta {
    /// Serializes the vault delta into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes a vault delta from bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<AccountVaultDelta, JsErr> {
        deserialize_from_bytes::<NativeAccountVaultDelta>(&bytes).map(AccountVaultDelta)
    }

    /// Returns true if no assets are changed.
    #[js_export(js_name = "isEmpty")]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Returns the number of assets changed by this delta, added and removed together.
    #[js_export(js_name = "numAssets")]
    pub fn num_assets(&self) -> usize {
        self.0.num_assets()
    }

    /// Returns the fungible assets this delta adds to the vault.
    #[js_export(js_name = "addedFungibleAssets")]
    pub fn added_fungible_assets(&self) -> Vec<FungibleAsset> {
        self.0
            .added_assets()
            .filter(Asset::is_fungible)
            .map(|asset| asset.unwrap_fungible().into())
            .collect()
    }

    /// Returns the fungible assets this delta removes from the vault.
    #[js_export(js_name = "removedFungibleAssets")]
    pub fn removed_fungible_assets(&self) -> Vec<FungibleAsset> {
        self.0
            .removed_assets()
            .filter(Asset::is_fungible)
            .map(|asset| asset.unwrap_fungible().into())
            .collect()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeAccountVaultDelta> for AccountVaultDelta {
    fn from(native_account_vault_delta: NativeAccountVaultDelta) -> Self {
        Self(native_account_vault_delta)
    }
}

impl From<&NativeAccountVaultDelta> for AccountVaultDelta {
    fn from(native_account_vault_delta: &NativeAccountVaultDelta) -> Self {
        Self(native_account_vault_delta.clone())
    }
}

impl From<AccountVaultDelta> for NativeAccountVaultDelta {
    fn from(account_vault_delta: AccountVaultDelta) -> Self {
        account_vault_delta.0
    }
}

impl From<&AccountVaultDelta> for NativeAccountVaultDelta {
    fn from(account_vault_delta: &AccountVaultDelta) -> Self {
        account_vault_delta.0.clone()
    }
}
