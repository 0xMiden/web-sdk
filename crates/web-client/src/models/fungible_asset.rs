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

    /// Reconstructs a fungible asset from its vault entry — the `(key, value)`
    /// word pair as stored in an account vault, i.e. the outputs of
    /// [`vaultKey`](Self::vault_key) and [`intoWord`](Self::into_word). The key
    /// word carries the faucet id and the callback flag; the value word carries
    /// the amount. This is the inverse of those getters, so
    /// `FungibleAsset.fromVaultEntry(a.vaultKey(), a.intoWord())` round-trips an
    /// asset read from vault data (callback flag included). Errors if the words
    /// don't describe a valid fungible asset (e.g. a malformed key, non-zero
    /// upper limbs in the value word, or an amount above the maximum fungible
    /// asset amount, `2^63 - 2^31`).
    #[js_export(js_name = "fromVaultEntry")]
    pub fn from_vault_entry(key: &Word, value: &Word) -> Result<FungibleAsset, JsErr> {
        FungibleAssetNative::from_key_value_words(key.into(), value.into())
            .map(FungibleAsset)
            .map_err(|e| from_str_err(&format!("Failed to create FungibleAsset: {e}")))
    }

    /// Reconstructs a fungible asset from its vault key word and a scalar amount.
    ///
    /// A convenience over [`fromVaultEntry`](Self::from_vault_entry) for when you
    /// hold the key word (from [`vaultKey`](Self::vault_key)) and the amount as a
    /// number rather than the value word: the key supplies the faucet id and
    /// callback flag, and the amount is encoded into the value word for you. Use
    /// `fromVaultEntry` when you already have both vault words. Errors on a
    /// malformed key or an amount above the maximum fungible asset amount,
    /// `2^63 - 2^31`.
    #[js_export(js_name = "fromVaultKey")]
    pub fn from_vault_key(key: &Word, amount: JsU64) -> Result<FungibleAsset, JsErr> {
        let amount = AssetAmount::new(js_u64_to_u64(amount))
            .map_err(|e| from_str_err(&format!("Failed to create FungibleAsset: {e}")))?;
        // Value-word layout mirrors native `FungibleAsset::to_value_word`
        // ([amount, 0, 0, 0]); keep the two in lockstep if that layout changes.
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

    /// Returns the key word under which this asset is stored in an account vault.
    ///
    /// The key encodes the faucet id and the callback flag; the amount lives in
    /// the paired value word from [`intoWord`](Self::into_word). Pass both back
    /// into [`fromVaultEntry`](Self::from_vault_entry) to reconstruct the asset.
    #[js_export(js_name = "vaultKey")]
    pub fn vault_key(&self) -> Word {
        self.0.to_key_word().into()
    }

    /// Returns the value word stored under [`vaultKey`](Self::vault_key) in an
    /// account vault. For a fungible asset the value word encodes the amount.
    ///
    /// This is the value half of the vault entry; pair it with `vaultKey()` and
    /// pass both to [`fromVaultEntry`](Self::from_vault_entry) to reconstruct the
    /// asset.
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
