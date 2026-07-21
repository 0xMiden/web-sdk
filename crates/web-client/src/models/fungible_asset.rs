use js_export_macro::js_export;
use miden_client::account::AccountId as NativeAccountId;
use miden_client::asset::{
    Asset as NativeAsset,
    AssetAmount,
    FungibleAsset as FungibleAssetNative,
};
use miden_client::{Felt as NativeFelt, Word as NativeWord};

use super::account_id::AccountId;
use super::asset_callback_flag::AssetCallbackFlag;
use super::word::Word;
use crate::platform::{JsErr, from_str_err, js_u64_to_u64, u64_to_js_u64};

/// A fungible asset.
///
/// A fungible asset consists of a faucet ID of the faucet which issued the asset as well as the
/// asset amount. Asset amount is guaranteed to be 2^63 - 1 or smaller.
#[derive(Clone, Copy)]
#[js_export]
pub struct FungibleAsset(FungibleAssetNative);

#[js_export]
impl FungibleAsset {
    /// Creates a fungible asset for the given faucet and amount.
    #[js_export(constructor)]
    pub fn new(faucet_id: &AccountId, amount: JsU64) -> Result<FungibleAsset, JsErr> {
        FungibleAsset::new_inner(faucet_id, js_u64_to_u64(amount))
    }

    /// Creates a fungible asset from its word-encoded vault key and amount.
    #[js_export(js_name = "fromVaultKey")]
    pub fn from_vault_key(key: &Word, amount: JsU64) -> Result<FungibleAsset, JsErr> {
        let amount = AssetAmount::new(js_u64_to_u64(amount))
            .map_err(|e| from_str_err(&format!("Failed to create FungibleAsset: {e}")))?;
        let value = NativeWord::new([
            NativeFelt::from(amount),
            NativeFelt::ZERO,
            NativeFelt::ZERO,
            NativeFelt::ZERO,
        ]);

        FungibleAssetNative::from_key_value_words(key.into(), value)
            .map(FungibleAsset)
            .map_err(|e| from_str_err(&format!("Failed to create FungibleAsset: {e}")))
    }

    /// Returns the amount of fungible units.
    pub fn amount(&self) -> JsU64 {
        // `FungibleAsset::amount()` now returns `AssetAmount`, not `u64`.
        u64_to_js_u64(self.0.amount().as_u64())
    }

    /// Returns the faucet account that minted this asset.
    #[js_export(js_name = "faucetId")]
    pub fn faucet_id(&self) -> AccountId {
        self.0.faucet_id().into()
    }

    /// Returns whether this asset invokes its faucet's callbacks.
    pub fn callbacks(&self) -> AssetCallbackFlag {
        self.0.callbacks().into()
    }

    /// Returns a copy of this asset carrying the given callback flag.
    ///
    /// The flag is part of the asset's vault key, so it must match the flag the issuing faucet
    /// applies — an asset built with the wrong flag addresses a different vault slot than the one
    /// holding the balance. The constructor always produces `Disabled`; pass `Enabled` only for
    /// assets from a faucet that registers transfer policies.
    #[js_export(js_name = "withCallbacks")]
    pub fn with_callbacks(&self, callbacks: AssetCallbackFlag) -> FungibleAsset {
        FungibleAsset(self.0.with_callbacks(callbacks.into()))
    }

    /// Returns the word-encoded key used to store this asset in an account vault.
    #[js_export(js_name = "vaultKey")]
    pub fn vault_key(&self) -> Word {
        self.0.to_key_word().into()
    }

    /// Encodes this asset into the word layout used in the vault.
    #[js_export(js_name = "intoWord")]
    pub fn into_word(&self) -> Word {
        let native_word: NativeWord = self.0.to_value_word();
        native_word.into()
    }
}

impl FungibleAsset {
    /// Internal constructor that takes a native u64 amount, usable from both platforms.
    pub(crate) fn new_inner(faucet_id: &AccountId, amount: u64) -> Result<FungibleAsset, JsErr> {
        let native_faucet_id: NativeAccountId = faucet_id.into();
        let native_asset = FungibleAssetNative::new(native_faucet_id, amount)
            .map_err(|e| from_str_err(&format!("Failed to create FungibleAsset: {e}")))?;
        Ok(FungibleAsset(native_asset))
    }
}

// CONVERSIONS
// ================================================================================================

impl From<FungibleAsset> for NativeAsset {
    fn from(fungible_asset: FungibleAsset) -> Self {
        fungible_asset.0.into()
    }
}

impl From<&FungibleAsset> for NativeAsset {
    fn from(fungible_asset: &FungibleAsset) -> Self {
        fungible_asset.0.into()
    }
}

impl From<FungibleAssetNative> for FungibleAsset {
    fn from(native_asset: FungibleAssetNative) -> Self {
        FungibleAsset(native_asset)
    }
}

impl From<&FungibleAssetNative> for FungibleAsset {
    fn from(native_asset: &FungibleAssetNative) -> Self {
        FungibleAsset(*native_asset)
    }
}

impl_napi_from_value!(FungibleAsset);
