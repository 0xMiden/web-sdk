use core::str::FromStr;

use js_export_macro::js_export;
use miden_client::account::AccountType as NativeAccountType;

use crate::platform::{JsErr, from_str_err};

/// Storage visibility mode for an account.
///
/// In the 0.15 protocol surface this is the same enum as `AccountType`
/// (the on-chain identifier no longer carries any faucet-vs-regular or
/// updatable-vs-immutable distinction), so internally we wrap an
/// `AccountType`. The standalone `AccountStorageMode` type still exists at
/// the JS API surface for backwards compatibility with code that wrote
/// `AccountStorageMode.public()` / `.private()`. The pre-existing `.network()`
/// constructor was removed — the network storage mode does not exist on the
/// 0.15 chain.
#[js_export]
#[derive(Clone)]
pub struct AccountStorageMode(NativeAccountType);

#[js_export]
impl AccountStorageMode {
    /// Creates a private storage mode.
    pub fn private() -> AccountStorageMode {
        AccountStorageMode(NativeAccountType::Private)
    }

    /// Creates a public storage mode.
    pub fn public() -> AccountStorageMode {
        AccountStorageMode(NativeAccountType::Public)
    }

    // `AccountStorageMode::network()` was removed in the migration to
    // miden-client PR #2214 — the network storage mode does not exist in
    // the 0.15 protocol surface.

    /// Parses a storage mode from its string representation.
    ///
    /// Accepts `"private"` and `"public"`; any other input — including the
    /// previously-supported `"network"` — is rejected.
    #[js_export(js_name = "tryFromStr")]
    pub fn try_from_str(s: String) -> Result<AccountStorageMode, JsErr> {
        let account_type = NativeAccountType::from_str(&s)
            .map_err(|e| from_str_err(&format!("Invalid AccountStorageMode string: {e:?}")))?;
        Ok(AccountStorageMode(account_type))
    }

    /// Returns the storage mode as a string.
    #[js_export(js_name = "asStr")]
    pub fn as_str(&self) -> String {
        self.0.to_string()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<AccountStorageMode> for NativeAccountType {
    fn from(storage_mode: AccountStorageMode) -> Self {
        storage_mode.0
    }
}

impl From<&AccountStorageMode> for NativeAccountType {
    fn from(storage_mode: &AccountStorageMode) -> Self {
        storage_mode.0
    }
}

impl AccountStorageMode {
    /// Returns true if the storage mode is public.
    pub fn is_public(&self) -> bool {
        matches!(self.0, NativeAccountType::Public)
    }
}
