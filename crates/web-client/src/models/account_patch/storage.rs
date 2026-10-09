use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::account::{
    AccountStoragePatch as NativeAccountStoragePatch,
    StorageMapPatch as NativeStorageMapPatch,
    StorageSlotName,
    StorageValuePatch as NativeStorageValuePatch,
};
use miden_protocol::account::StoragePatchOperation as NativeStoragePatchOperation;

use crate::models::word::Word;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_from_bytes, serialize_to_bytes};

/// Absolute updates to named account storage slots.
#[derive(Clone)]
#[js_export]
pub struct AccountStoragePatch(NativeAccountStoragePatch);

#[js_export]
impl AccountStoragePatch {
    /// Serializes the storage patch into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes a storage patch from bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<AccountStoragePatch, JsErr> {
        deserialize_from_bytes::<NativeAccountStoragePatch>(&bytes).map(Self)
    }

    /// Returns true if no storage slots are changed.
    #[js_export(js_name = "isEmpty")]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Returns the final values for created or updated value slots.
    ///
    /// The slot names and removed slots are not included; use `valueSlots()` for those.
    pub fn values(&self) -> Vec<Word> {
        self.0
            .values()
            .filter_map(|(_slot_name, patch)| patch.value())
            .map(Into::into)
            .collect()
    }

    /// Returns the patch of every changed value slot, with its slot name and operation, in
    /// ascending slot ID order.
    #[js_export(js_name = "valueSlots")]
    pub fn value_slots(&self) -> Vec<StorageValueSlotPatch> {
        self.0
            .values()
            .map(|(slot_name, patch)| StorageValueSlotPatch {
                slot_name: slot_name.clone(),
                patch: patch.clone(),
            })
            .collect()
    }

    /// Returns the patch of every changed map slot, with its slot name, operation and changed
    /// entries, in ascending slot ID order.
    #[js_export(js_name = "mapSlots")]
    pub fn map_slots(&self) -> Vec<StorageMapSlotPatch> {
        self.0
            .maps()
            .map(|(slot_name, patch)| StorageMapSlotPatch {
                slot_name: slot_name.clone(),
                patch: patch.clone(),
            })
            .collect()
    }
}

/// Whether a storage slot was created, updated or removed by an `AccountStoragePatch`.
#[js_export]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum StoragePatchOperation {
    /// The slot was created. Every slot of a new account is reported as created.
    Create = 0,

    /// An existing slot was changed.
    Update = 1,

    /// An existing slot was removed.
    Remove = 2,
}

// Compile-time check to keep enum values aligned with
// `miden_protocol::account::StoragePatchOperation`.
const _: () = {
    assert!(NativeStoragePatchOperation::Create.as_u8() == StoragePatchOperation::Create as u8);
    assert!(NativeStoragePatchOperation::Update.as_u8() == StoragePatchOperation::Update as u8);
    assert!(NativeStoragePatchOperation::Remove.as_u8() == StoragePatchOperation::Remove as u8);
};

impl From<NativeStoragePatchOperation> for StoragePatchOperation {
    fn from(value: NativeStoragePatchOperation) -> Self {
        match value {
            NativeStoragePatchOperation::Create => StoragePatchOperation::Create,
            NativeStoragePatchOperation::Update => StoragePatchOperation::Update,
            NativeStoragePatchOperation::Remove => StoragePatchOperation::Remove,
        }
    }
}

/// The patch of one named value slot.
#[derive(Clone)]
#[js_export]
pub struct StorageValueSlotPatch {
    slot_name: StorageSlotName,
    patch: NativeStorageValuePatch,
}

#[js_export]
impl StorageValueSlotPatch {
    /// The name of the changed value slot.
    #[js_export(getter, js_name = "slotName")]
    pub fn slot_name(&self) -> String {
        self.slot_name.as_str().to_string()
    }

    /// Whether the slot was created, updated or removed.
    #[js_export(getter)]
    pub fn operation(&self) -> StoragePatchOperation {
        self.patch.patch_op().into()
    }

    /// The final value of a created or updated slot, or `undefined` for a removed slot.
    #[js_export(getter)]
    pub fn value(&self) -> Option<Word> {
        self.patch.value().map(Into::into)
    }
}

/// The patch of one named map slot.
#[derive(Clone)]
#[js_export]
pub struct StorageMapSlotPatch {
    slot_name: StorageSlotName,
    patch: NativeStorageMapPatch,
}

#[js_export]
impl StorageMapSlotPatch {
    /// The name of the changed map slot.
    #[js_export(getter, js_name = "slotName")]
    pub fn slot_name(&self) -> String {
        self.slot_name.as_str().to_string()
    }

    /// Whether the map slot was created, updated or removed.
    #[js_export(getter)]
    pub fn operation(&self) -> StoragePatchOperation {
        self.patch.patch_op().into()
    }

    /// The changed entries, sorted by key.
    ///
    /// For a created map these are all of its entries, and a map created empty has none. A
    /// removed map has none.
    pub fn entries(&self) -> Vec<StorageMapPatchEntry> {
        self.patch
            .entries()
            .into_iter()
            .flat_map(|entries| entries.as_map().iter())
            .map(|(key, value)| StorageMapPatchEntry {
                key: NativeWord::from(*key).into(),
                value: (*value).into(),
            })
            .collect()
    }
}

/// One changed entry of a storage map patch.
#[derive(Clone)]
#[js_export]
pub struct StorageMapPatchEntry {
    key: Word,
    value: Word,
}

#[js_export]
impl StorageMapPatchEntry {
    /// The map key.
    #[js_export(getter)]
    pub fn key(&self) -> Word {
        self.key.clone()
    }

    /// The final value at the key. A cleared entry has the empty word (all four elements zero).
    #[js_export(getter)]
    pub fn value(&self) -> Word {
        self.value.clone()
    }
}

impl From<NativeAccountStoragePatch> for AccountStoragePatch {
    fn from(patch: NativeAccountStoragePatch) -> Self {
        Self(patch)
    }
}

impl From<&NativeAccountStoragePatch> for AccountStoragePatch {
    fn from(patch: &NativeAccountStoragePatch) -> Self {
        Self(patch.clone())
    }
}

impl From<AccountStoragePatch> for NativeAccountStoragePatch {
    fn from(patch: AccountStoragePatch) -> Self {
        patch.0
    }
}
