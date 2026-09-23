use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::asset::{
    Asset as NativeAsset,
    FungibleAsset as NativeFungibleAsset,
    NonFungibleAsset as NativeNonFungibleAsset,
};

use super::account_id::AccountId;
use super::fungible_asset::FungibleAsset;
use super::non_fungible_asset::NonFungibleAsset;
use super::word::Word;
use crate::platform::{JsErr, from_str_err, js_u64_to_u64};

/// A fungible or non-fungible asset.
///
/// Create assets with `VaultAsset.fungible(faucetId, amount)` or
/// `VaultAsset.nonFungible({ key, value })`. Both variants can be passed to `NoteAssets`.
#[derive(Clone, Copy)]
#[js_export]
pub struct VaultAsset(NativeAsset);

#[js_export]
impl VaultAsset {
    /// Creates a fungible asset. The amount must fit the protocol's asset amount range.
    pub fn fungible(faucet_id: &AccountId, amount: JsU64) -> Result<VaultAsset, JsErr> {
        NativeFungibleAsset::new(faucet_id.into(), js_u64_to_u64(amount))
            .map(|asset| VaultAsset(asset.into()))
            .map_err(|err| from_str_err(&format!("Failed to create fungible asset: {err}")))
    }

    /// Creates a non-fungible asset from `{ key: Word, value: Word }`.
    ///
    /// The key includes the issuer. The value contains all four value limbs. Both words remain
    /// usable after this call. Returns an error for an invalid key, a fungible entry, or an asset
    /// class that does not match the first two value limbs.
    #[js_export(js_name = "nonFungible")]
    pub fn non_fungible(input: NonFungibleAssetInput) -> Result<VaultAsset, JsErr> {
        let (key, value) = input.words()?;
        NativeNonFungibleAsset::from_id_and_value_words(key, value)
            .map(|asset| VaultAsset(asset.into()))
            .map_err(|err| from_str_err(&format!("Failed to create non-fungible asset: {err}")))
    }

    /// Reconstructs either asset variant from a complete vault entry.
    /// The key determines the variant. Returns an error if the entry is invalid.
    #[js_export(js_name = "fromVaultEntry")]
    pub fn from_vault_entry(key: &Word, value: &Word) -> Result<VaultAsset, JsErr> {
        NativeAsset::from_id_and_value_words(key.into(), value.into())
            .map(VaultAsset)
            .map_err(|err| from_str_err(&format!("Failed to create asset: {err}")))
    }

    /// Returns `"fungible"` or `"nonFungible"`.
    pub fn kind(&self) -> String {
        match self.0 {
            NativeAsset::Fungible(_) => "fungible".into(),
            NativeAsset::NonFungible(_) => "nonFungible".into(),
        }
    }

    /// Returns the issuer account ID.
    #[js_export(js_name = "faucetId")]
    pub fn faucet_id(&self) -> AccountId {
        self.0.faucet_id().into()
    }

    /// Returns the complete asset key. Compare both this key and `intoWord()` to verify an asset.
    #[js_export(js_name = "vaultKey")]
    pub fn vault_key(&self) -> Word {
        self.0.to_id_word().into()
    }

    /// Returns the complete value word. Use `toU64s()` to read all four limbs as bigint values.
    #[js_export(js_name = "intoWord")]
    pub fn into_word(&self) -> Word {
        self.0.to_value_word().into()
    }

    /// Returns a fungible asset copy. Throws if this asset is non-fungible.
    #[js_export(js_name = "asFungible")]
    pub fn as_fungible(&self) -> Result<FungibleAsset, JsErr> {
        match self.0 {
            NativeAsset::Fungible(asset) => Ok(asset.into()),
            NativeAsset::NonFungible(_) => Err(from_str_err("Asset is not fungible")),
        }
    }

    /// Returns a non-fungible asset copy. Throws if this asset is fungible.
    #[js_export(js_name = "asNonFungible")]
    pub fn as_non_fungible(&self) -> Result<NonFungibleAsset, JsErr> {
        match self.0 {
            NativeAsset::NonFungible(asset) => Ok(asset.into()),
            NativeAsset::Fungible(_) => Err(from_str_err("Asset is not non-fungible")),
        }
    }
}

impl From<NativeAsset> for VaultAsset {
    fn from(asset: NativeAsset) -> Self {
        Self(asset)
    }
}

impl_napi_from_value!(VaultAsset);

// Browser inputs read copies of the words. This preserves the source wrappers and supports the
// existing FungibleAsset class without changing its public API.
#[cfg(feature = "browser")]
mod browser {
    use wasm_bindgen::prelude::*;

    use super::{JsErr, NativeAsset, NativeWord, from_str_err};

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(typescript_type = "VaultAsset | FungibleAsset | NonFungibleAsset")]
        pub type AssetInput;

        #[wasm_bindgen(method, structural, catch, js_name = vaultKey)]
        fn input_key(this: &AssetInput) -> Result<InputWord, JsValue>;

        #[wasm_bindgen(method, structural, catch, js_name = intoWord)]
        fn input_value(this: &AssetInput) -> Result<InputWord, JsValue>;

        #[wasm_bindgen(typescript_type = "{ key: Word; value: Word }")]
        pub type NonFungibleAssetInput;

        #[wasm_bindgen(method, structural, getter, catch, js_name = key)]
        fn key(this: &NonFungibleAssetInput) -> Result<InputWord, JsValue>;

        #[wasm_bindgen(method, structural, getter, catch, js_name = value)]
        fn value(this: &NonFungibleAssetInput) -> Result<InputWord, JsValue>;

        #[wasm_bindgen(typescript_type = "Word")]
        type InputWord;

        #[wasm_bindgen(method, structural, catch, js_name = toHex)]
        fn to_hex(this: &InputWord) -> Result<String, JsValue>;
    }

    impl InputWord {
        fn native(&self) -> Result<NativeWord, JsErr> {
            NativeWord::try_from(self.to_hex()?.as_str())
                .map_err(|err| from_str_err(&format!("Invalid asset word: {err}")))
        }
    }

    impl NonFungibleAssetInput {
        pub(super) fn words(&self) -> Result<(NativeWord, NativeWord), JsErr> {
            Ok((self.key()?.native()?, self.value()?.native()?))
        }
    }

    impl AssetInput {
        pub(crate) fn native(&self) -> Result<NativeAsset, JsErr> {
            NativeAsset::from_id_and_value_words(
                self.input_key()?.native()?,
                self.input_value()?.native()?,
            )
            .map_err(|err| from_str_err(&format!("Invalid note asset: {err}")))
        }
    }
}

#[cfg(feature = "browser")]
pub use browser::{AssetInput, NonFungibleAssetInput};

#[cfg(feature = "nodejs")]
pub type AssetInput = napi::bindgen_prelude::Either3<VaultAsset, FungibleAsset, NonFungibleAsset>;

// Either3 requires validation for owned values. Use each class's generated reference validator
// before the existing FromNapiValue implementation copies the value.
#[cfg(feature = "nodejs")]
mod node_validation {
    use napi::bindgen_prelude::{ValidateNapiValue, sys};

    use super::{FungibleAsset, NonFungibleAsset, VaultAsset};

    macro_rules! validate_owned_asset {
        ($asset:ty) => {
            impl ValidateNapiValue for $asset {
                unsafe fn validate(
                    env: sys::napi_env,
                    value: sys::napi_value,
                ) -> napi::Result<sys::napi_value> {
                    unsafe { <&Self as ValidateNapiValue>::validate(env, value) }
                }
            }
        };
    }

    validate_owned_asset!(VaultAsset);
    validate_owned_asset!(FungibleAsset);
    validate_owned_asset!(NonFungibleAsset);
}

#[cfg(feature = "nodejs")]
#[napi_derive::napi(object)]
pub struct NonFungibleAssetInput {
    pub key: Word,
    pub value: Word,
}

#[cfg(feature = "nodejs")]
impl NonFungibleAssetInput {
    fn words(&self) -> Result<(NativeWord, NativeWord), JsErr> {
        Ok(((&self.key).into(), (&self.value).into()))
    }
}

pub(crate) fn native_asset(input: &AssetInput) -> Result<NativeAsset, JsErr> {
    #[cfg(feature = "browser")]
    {
        input.native()
    }
    #[cfg(feature = "nodejs")]
    {
        use napi::bindgen_prelude::Either3;

        Ok(match input {
            Either3::A(asset) => asset.0,
            Either3::B(asset) => asset.into(),
            Either3::C(asset) => asset.into(),
        })
    }
}
