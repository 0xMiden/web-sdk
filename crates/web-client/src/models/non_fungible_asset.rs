use js_export_macro::js_export;
use miden_client::asset::{Asset as NativeAsset, NonFungibleAsset as NativeNonFungibleAsset};

use super::account_id::AccountId;
use super::word::Word;
use crate::platform::{JsErr, from_str_err};

/// A non-fungible asset with an issuer and a four-element value word.
///
/// Use both the vault key and the complete value word to compare assets. The key alone does not
/// contain all four value elements.
#[derive(Clone, Copy)]
#[js_export]
pub struct NonFungibleAsset(NativeNonFungibleAsset);

#[js_export]
impl NonFungibleAsset {
    /// Reconstructs an asset from its vault key and value words.
    ///
    /// Returns an error if the key is invalid, the asset composition is not non-fungible, or the
    /// asset class in the key does not match the first two elements of the value word.
    #[js_export(js_name = "fromVaultEntry")]
    pub fn from_vault_entry(key: &Word, value: &Word) -> Result<NonFungibleAsset, JsErr> {
        NativeNonFungibleAsset::from_id_and_value_words(key.into(), value.into())
            .map(NonFungibleAsset)
            .map_err(|err| from_str_err(&format!("Failed to create NonFungibleAsset: {err}")))
    }

    /// Returns the ID of the faucet that issued this asset.
    #[js_export(js_name = "faucetId")]
    pub fn faucet_id(&self) -> AccountId {
        self.0.faucet_id().into()
    }

    /// Returns the complete key word used to store this asset in an account vault.
    ///
    /// Pair this key with `intoWord()` to compare or reconstruct the complete asset.
    #[js_export(js_name = "vaultKey")]
    pub fn vault_key(&self) -> Word {
        self.0.to_id_word().into()
    }

    /// Returns the complete value word stored under `vaultKey()` in an account vault.
    ///
    /// Use `toU64s()` on the returned word to read all four value elements without precision loss.
    #[js_export(js_name = "intoWord")]
    pub fn into_word(&self) -> Word {
        self.0.to_value_word().into()
    }
}

impl From<NativeNonFungibleAsset> for NonFungibleAsset {
    fn from(asset: NativeNonFungibleAsset) -> Self {
        Self(asset)
    }
}

impl From<NonFungibleAsset> for NativeAsset {
    fn from(asset: NonFungibleAsset) -> Self {
        asset.0.into()
    }
}

impl From<&NonFungibleAsset> for NativeAsset {
    fn from(asset: &NonFungibleAsset) -> Self {
        asset.0.into()
    }
}

impl_napi_from_value!(NonFungibleAsset);
