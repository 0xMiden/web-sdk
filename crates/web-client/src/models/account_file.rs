use js_export_macro::js_export;
use miden_client::account::AccountFile as NativeAccountFile;

use crate::js_error_with_context;
use crate::models::account::Account;
use crate::models::account_id::AccountId;
use crate::platform::{JsBytes, JsErr, bytes_to_js, js_to_bytes};

#[derive(Debug, Clone)]
#[js_export]
pub struct AccountFile(NativeAccountFile);

#[js_export]
impl AccountFile {
    /// Returns the account ID.
    #[js_export(js_name = "accountId")]
    pub fn account_id(&self) -> AccountId {
        self.0.account().id().into()
    }

    /// Returns the account data.
    pub fn account(&self) -> Account {
        self.0.account().clone().into()
    }

    /// Returns the number of auth secret keys included.
    #[js_export(js_name = "authSecretKeyCount")]
    pub fn auth_secret_key_count(&self) -> usize {
        self.0.auth_secret_keys().len()
    }

    /// Encodes this file as protobuf account-file bytes.
    ///
    /// Bytes written by web-sdk 0.17.0-rc.1 used the old `Serializable` codec and do not decode.
    pub fn serialize(&self) -> JsBytes {
        bytes_to_js(&self.0.to_bytes())
    }

    /// Decodes protobuf account-file bytes.
    ///
    /// Rejects bytes produced by web-sdk 0.17.0-rc.1.
    pub fn deserialize(bytes: JsBytes) -> Result<AccountFile, JsErr> {
        let native_account_file = NativeAccountFile::try_from_bytes(&js_to_bytes(&bytes))
            .map_err(|err| js_error_with_context(err, "account file deserialization failed"))?;
        Ok(Self(native_account_file))
    }
}

impl From<NativeAccountFile> for AccountFile {
    fn from(native_account_file: NativeAccountFile) -> Self {
        Self(native_account_file)
    }
}

impl From<AccountFile> for NativeAccountFile {
    fn from(account_file: AccountFile) -> Self {
        account_file.0
    }
}

impl_napi_from_value!(AccountFile);
