use js_export_macro::js_export;
use miden_client::account::AccountPatch as NativeAccountPatch;
use miden_objects::proto;

use crate::models::account_id::AccountId;
use crate::models::felt::Felt;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{decode_message, encode_message};

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
    /// Serializes the account patch into the bytes of its `miden-objects` protobuf message.
    pub fn serialize(&self) -> JsBytes {
        encode_message(&proto::account::AccountPatch::from(&self.0))
    }

    /// Deserializes an account patch from the bytes that [`Self::serialize`] returns.
    ///
    /// Bytes that an earlier SDK version wrote with the Winterfell encoding do not decode.
    pub fn deserialize(bytes: JsBytes) -> Result<AccountPatch, JsErr> {
        decode_message::<proto::account::AccountPatch>(&bytes).map(AccountPatch)
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
