use js_export_macro::js_export;
use miden_client::transaction::AccountInputs as NativeAccountInputs;

use super::account_id::AccountId;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_from_bytes, serialize_to_bytes};

/// State and inclusion witness of a foreign account, fetched at a specific block.
#[derive(Clone)]
#[js_export]
pub struct AccountInputs(NativeAccountInputs);

#[js_export]
impl AccountInputs {
    /// Returns the ID of the account these inputs describe.
    #[js_export(js_name = "accountId")]
    pub fn account_id(&self) -> AccountId {
        self.0.id().into()
    }

    /// Serializes the account inputs into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Restores account inputs from their serialized bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<AccountInputs, JsErr> {
        deserialize_from_bytes::<NativeAccountInputs>(&bytes).map(AccountInputs)
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeAccountInputs> for AccountInputs {
    fn from(account_inputs: NativeAccountInputs) -> Self {
        AccountInputs(account_inputs)
    }
}

impl From<&NativeAccountInputs> for AccountInputs {
    fn from(account_inputs: &NativeAccountInputs) -> Self {
        AccountInputs(account_inputs.clone())
    }
}

impl From<AccountInputs> for NativeAccountInputs {
    fn from(account_inputs: AccountInputs) -> Self {
        account_inputs.0
    }
}

impl From<&AccountInputs> for NativeAccountInputs {
    fn from(account_inputs: &AccountInputs) -> Self {
        account_inputs.0.clone()
    }
}

impl_napi_from_value!(AccountInputs);
