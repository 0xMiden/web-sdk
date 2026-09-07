use js_export_macro::js_export;
use miden_client::account::AccountPatch as NativeAccountPatch;

use crate::models::account_id::AccountId;
use crate::models::felt::Felt;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_from_bytes, serialize_to_bytes};

pub mod storage;
pub mod vault;

use storage::AccountStoragePatch;
use vault::AccountVaultPatch;

/// Describes the new absolute account state produced by a transaction.
#[derive(Clone)]
#[js_export]
pub struct AccountPatch(NativeAccountPatch);

#[js_export]
impl AccountPatch {
    /// Serializes the account patch into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes an account patch from bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<AccountPatch, JsErr> {
        deserialize_from_bytes::<NativeAccountPatch>(&bytes).map(AccountPatch)
    }

    /// Returns the affected account ID.
    pub fn id(&self) -> AccountId {
        self.0.id().into()
    }

    /// Returns true if this patch contains no state changes.
    #[js_export(js_name = "isEmpty")]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Returns the account storage patch.
    pub fn storage(&self) -> AccountStoragePatch {
        self.0.storage().into()
    }

    /// Returns the account vault patch.
    pub fn vault(&self) -> AccountVaultPatch {
        self.0.vault().into()
    }

    /// Returns the final nonce, or `None` if it was unchanged.
    #[js_export(js_name = "finalNonce")]
    pub fn final_nonce(&self) -> Option<Felt> {
        self.0.final_nonce().map(Into::into)
    }
}

impl From<NativeAccountPatch> for AccountPatch {
    fn from(patch: NativeAccountPatch) -> Self {
        Self(patch)
    }
}

impl From<&NativeAccountPatch> for AccountPatch {
    fn from(patch: &NativeAccountPatch) -> Self {
        Self(patch.clone())
    }
}

impl From<AccountPatch> for NativeAccountPatch {
    fn from(patch: AccountPatch) -> Self {
        patch.0
    }
}

impl From<&AccountPatch> for NativeAccountPatch {
    fn from(patch: &AccountPatch) -> Self {
        patch.0.clone()
    }
}
