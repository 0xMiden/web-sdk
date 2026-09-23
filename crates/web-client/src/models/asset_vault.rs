use js_export_macro::js_export;
use miden_client::account::AccountId as NativeAccountId;
use miden_client::asset::AssetVault as NativeAssetVault;

use super::account_id::AccountId;
use super::asset::Asset;
use super::fungible_asset::FungibleAsset;
use super::non_fungible_asset::NonFungibleAsset;
use super::word::Word;

/// A container for an unlimited number of assets.
///
/// Assets are stored in a Sparse Merkle Tree. Each leaf uses the hash of an asset key as its
/// index and stores a separate value word:
/// - A fungible asset key identifies the issuing faucet and callback flag. Its value stores the
///   amount.
/// - A non-fungible asset key identifies the issuing faucet and asset class. Its value stores all
///   four elements of the asset data commitment.
///
/// An asset vault can be reduced to a single hash which is the root of the Sparse Merkle Tree.
#[derive(Clone)]
#[js_export]
pub struct AssetVault(NativeAssetVault);

#[js_export]
impl AssetVault {
    /// Returns all fungible and non-fungible assets in this local vault snapshot.
    /// Returns an empty array if the vault is empty. The order is unspecified.
    pub fn assets(&self) -> Vec<Asset> {
        self.0.assets().map(Into::into).collect()
    }

    /// Returns the root commitment of the asset vault tree.
    pub fn root(&self) -> Word {
        self.0.root().into()
    }

    /// Returns the balance for the given fungible faucet, or zero if absent.
    ///
    /// Matches by faucet id across the vault's fungible assets, so the balance is
    /// found regardless of the asset's callback flag.
    #[js_export(js_name = "getBalance")]
    pub fn get_balance(&self, faucet_id: &AccountId) -> u64 {
        let native_faucet_id: NativeAccountId = faucet_id.into();
        self.0
            .assets()
            .filter_map(|asset| {
                if asset.is_fungible() {
                    Some(asset.unwrap_fungible())
                } else {
                    None
                }
            })
            .find(|fungible| fungible.faucet_id() == native_faucet_id)
            .map_or(0, |fungible| u64::from(fungible.amount()))
    }

    /// Returns the fungible assets contained in this vault.
    #[js_export(js_name = "fungibleAssets")]
    pub fn fungible_assets(&self) -> Vec<FungibleAsset> {
        self.0
            .assets()
            .filter_map(|asset| {
                if asset.is_fungible() {
                    Some(asset.unwrap_fungible().into())
                } else {
                    None
                }
            })
            .collect()
    }

    /// Returns all non-fungible assets in this vault, or an empty array if none are present.
    ///
    /// Fungible assets are excluded. The order is unspecified. Each returned asset exposes its
    /// issuer, complete vault key, and all four value elements. This reads the current vault
    /// snapshot and does not fetch data from the network.
    #[js_export(js_name = "nonFungibleAssets")]
    pub fn non_fungible_assets(&self) -> Vec<NonFungibleAsset> {
        self.0
            .assets()
            .filter_map(|asset| {
                if asset.is_non_fungible() {
                    Some(asset.unwrap_non_fungible().into())
                } else {
                    None
                }
            })
            .collect()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeAssetVault> for AssetVault {
    fn from(native_asset_vault: NativeAssetVault) -> Self {
        AssetVault(native_asset_vault)
    }
}

impl From<&NativeAssetVault> for AssetVault {
    fn from(native_asset_vault: &NativeAssetVault) -> Self {
        AssetVault(native_asset_vault.clone())
    }
}
