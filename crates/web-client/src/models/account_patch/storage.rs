use js_export_macro::js_export;
use miden_client::account::AccountStoragePatch as NativeAccountStoragePatch;

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
    pub fn values(&self) -> Vec<Word> {
        self.0
            .values()
            .filter_map(|(_slot_name, patch)| patch.value())
            .map(Into::into)
            .collect()
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
