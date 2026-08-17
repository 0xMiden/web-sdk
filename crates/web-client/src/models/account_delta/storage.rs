use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::asset::AccountStorageDelta as NativeAccountStorageDelta;

use crate::models::word::Word;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_from_bytes, serialize_to_bytes};

/// `AccountStorageDelta` stores the differences between two states of account storage.
///
/// The delta consists of two maps:
/// - A map containing the updates to value storage slots. The keys in this map are indexes of the
///   updated storage slots and the values are the new values for these slots.
/// - A map containing updates to storage maps. The keys in this map are indexes of the updated
///   storage slots and the values are corresponding storage map delta objects.
#[derive(Clone)]
#[js_export]
pub struct AccountStorageDelta(NativeAccountStorageDelta);

#[js_export]
impl AccountStorageDelta {
    /// Serializes the storage delta into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes a storage delta from bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<AccountStorageDelta, JsErr> {
        deserialize_from_bytes::<NativeAccountStorageDelta>(&bytes).map(AccountStorageDelta)
    }

    /// Returns true if no storage slots are changed.
    #[js_export(js_name = "isEmpty")]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Returns the new values for modified storage value slots.
    ///
    /// The slot name is not attached; use [`AccountStorageDelta::value_deltas`] to
    /// know which slot each value belongs to.
    pub fn values(&self) -> Vec<Word> {
        self.0
            .values()
            .map(|(_slot_name, value)| value)
            .copied()
            .map(Into::into)
            .collect()
    }

    /// Returns the value-slot deltas, each carrying its storage slot name and new value.
    #[js_export(js_name = "valueDeltas")]
    pub fn value_deltas(&self) -> Vec<StorageValueDelta> {
        self.0
            .values()
            .map(|(slot_name, value)| StorageValueDelta {
                slot_name: slot_name.as_str().to_string(),
                value: (*value).into(),
            })
            .collect()
    }

    /// Returns the storage-map deltas, each carrying its storage slot name and its
    /// changed key/value entries.
    pub fn maps(&self) -> Vec<StorageMapSlotDelta> {
        self.0
            .maps()
            .map(|(slot_name, map_delta)| StorageMapSlotDelta {
                slot_name: slot_name.as_str().to_string(),
                entries: map_delta
                    .entries()
                    .iter()
                    .map(|(key, value)| StorageMapDeltaEntry {
                        key: NativeWord::from(*key).into(),
                        value: (*value).into(),
                    })
                    .collect(),
            })
            .collect()
    }
}

/// A single value-slot change: the storage slot name plus its new value word.
#[derive(Clone)]
#[js_export]
pub struct StorageValueDelta {
    slot_name: String,
    value: Word,
}

#[js_export]
impl StorageValueDelta {
    /// The name of the storage value slot that changed.
    #[js_export(getter, js_name = "slotName")]
    pub fn slot_name(&self) -> String {
        self.slot_name.clone()
    }

    /// The new value written to the slot.
    #[js_export(getter)]
    pub fn value(&self) -> Word {
        self.value.clone()
    }
}

/// A single changed entry in a storage map: the map key word and its new value word.
#[derive(Clone)]
#[js_export]
pub struct StorageMapDeltaEntry {
    key: Word,
    value: Word,
}

#[js_export]
impl StorageMapDeltaEntry {
    /// The map key that changed.
    #[js_export(getter)]
    pub fn key(&self) -> Word {
        self.key.clone()
    }

    /// The new value stored at the key.
    #[js_export(getter)]
    pub fn value(&self) -> Word {
        self.value.clone()
    }
}

/// A storage-map slot change: the storage slot name plus its changed key/value entries.
#[derive(Clone)]
#[js_export]
pub struct StorageMapSlotDelta {
    slot_name: String,
    entries: Vec<StorageMapDeltaEntry>,
}

#[js_export]
impl StorageMapSlotDelta {
    /// The name of the storage map slot that changed.
    #[js_export(getter, js_name = "slotName")]
    pub fn slot_name(&self) -> String {
        self.slot_name.clone()
    }

    /// The changed entries in this map slot.
    pub fn entries(&self) -> Vec<StorageMapDeltaEntry> {
        self.entries.clone()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeAccountStorageDelta> for AccountStorageDelta {
    fn from(native_account_storage_delta: NativeAccountStorageDelta) -> Self {
        Self(native_account_storage_delta)
    }
}

impl From<&NativeAccountStorageDelta> for AccountStorageDelta {
    fn from(native_account_storage_delta: &NativeAccountStorageDelta) -> Self {
        Self(native_account_storage_delta.clone())
    }
}

impl From<AccountStorageDelta> for NativeAccountStorageDelta {
    fn from(account_storage_delta: AccountStorageDelta) -> Self {
        account_storage_delta.0
    }
}

impl From<&AccountStorageDelta> for NativeAccountStorageDelta {
    fn from(account_storage_delta: &AccountStorageDelta) -> Self {
        account_storage_delta.0.clone()
    }
}
