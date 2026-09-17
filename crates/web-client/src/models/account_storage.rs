use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::account::{
    AccountStorage as NativeAccountStorage,
    StorageMapKey,
    StorageSlotContent,
    StorageSlotName,
};
#[cfg(feature = "nodejs")]
use napi_derive::napi;
#[cfg(feature = "browser")]
use wasm_bindgen::prelude::*;

use crate::models::word::Word;

#[cfg_attr(feature = "browser", wasm_bindgen(getter_with_clone, inspectable))]
#[cfg_attr(feature = "nodejs", napi(object))]
#[derive(Clone)]
pub struct StorageMapEntry {
    #[cfg_attr(feature = "browser", wasm_bindgen(js_name = "root"))]
    pub root: String,
    #[cfg_attr(feature = "browser", wasm_bindgen(js_name = "key"))]
    pub key: String,
    #[cfg_attr(feature = "browser", wasm_bindgen(js_name = "value"))]
    pub value: String,
}

/// Account storage is composed of a variable number of index-addressable storage slots up to 255
/// slots in total.
///
/// Each slot has a type which defines its size and structure. Currently, the following types are
/// supported:
/// - `StorageSlot::Value`: contains a single Word of data (i.e., 32 bytes).
/// - `StorageSlot::Map`: contains a `StorageMap` which is a key-value map where both keys and
///   values are Words. The value of a storage slot containing a map is the commitment to the
///   underlying map.
#[derive(Clone)]
#[js_export]
pub struct AccountStorage(NativeAccountStorage);

#[js_export]
impl AccountStorage {
    /// Returns the commitment to the full account storage.
    pub fn commitment(&self) -> Word {
        self.0.to_commitment().into()
    }

    /// Returns the value stored at the given slot name, if any.
    #[js_export(js_name = "getItem")]
    pub fn get_item(&self, slot_name: String) -> Option<Word> {
        let slot_name = StorageSlotName::new(slot_name).ok()?;
        self.0.get_item(&slot_name).ok().map(Into::into)
    }

    /// Returns the names of all storage slots on this account.
    #[js_export(js_name = "getSlotNames")]
    pub fn get_slot_names(&self) -> Vec<String> {
        self.0.slots().iter().map(|slot| slot.name().as_str().to_string()).collect()
    }

    /// Returns the value for a key in the map stored at the given slot, if any.
    #[js_export(js_name = "getMapItem")]
    pub fn get_map_item(&self, slot_name: String, key: &Word) -> Option<Word> {
        match StorageSlotName::new(slot_name) {
            Ok(slot_name) => {
                let key = StorageMapKey::new(NativeWord::from(key));
                self.0.get_map_item(&slot_name, key).ok().map(Into::into)
            },
            Err(_) => None,
        }
    }

    /// Get all key-value pairs from the map slot identified by `slot_name`.
    /// Returns `undefined` if the slot isn't a map or doesn't exist.
    /// Returns `[]` if the map exists but is empty.
    #[js_export(js_name = "getMapEntries")]
    pub fn get_map_entries(&self, slot_name: String) -> Option<Vec<StorageMapEntry>> {
        let slot = self.0.slots().iter().find(|slot| slot.name().as_str() == slot_name.as_str())?;
        let StorageSlotContent::Map(map) = slot.content() else {
            return None;
        };

        Some(
            map.entries()
                .map(|(key, value)| StorageMapEntry {
                    root: map.root().to_hex(),
                    key: key.to_hex(),
                    value: value.to_hex(),
                })
                .collect(),
        )
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeAccountStorage> for AccountStorage {
    fn from(native_account_storage: NativeAccountStorage) -> Self {
        AccountStorage(native_account_storage)
    }
}

impl From<&NativeAccountStorage> for AccountStorage {
    fn from(native_account_storage: &NativeAccountStorage) -> Self {
        AccountStorage(native_account_storage.clone())
    }
}

impl From<AccountStorage> for NativeAccountStorage {
    fn from(account_storage: AccountStorage) -> Self {
        account_storage.0
    }
}

// Unlike `impl_napi_from_value!`, this accepts both a native `AccountStorage` and a facade
// wrapper (the JS `StorageView` returned by `account.storage()`) that exposes the native
// storage behind a `raw` property. The napi class statics are frozen, so the JS facade
// cannot unwrap `StorageView` before the call the way the browser facade does.
#[cfg(feature = "nodejs")]
impl napi::bindgen_prelude::FromNapiValue for AccountStorage {
    unsafe fn from_napi_value(
        env: napi::bindgen_prelude::sys::napi_env,
        napi_val: napi::bindgen_prelude::sys::napi_value,
    ) -> napi::Result<Self> {
        use napi::bindgen_prelude::{FromNapiRef, Object};

        if let Ok(storage) =
            unsafe { <AccountStorage as FromNapiRef>::from_napi_ref(env, napi_val) }
        {
            return Ok(storage.clone());
        }

        let object = unsafe { Object::from_napi_value(env, napi_val)? };
        object.get("raw")?.ok_or_else(|| {
            napi::Error::from_reason(
                "expected an AccountStorage or an object exposing one via `raw`",
            )
        })
    }
}
