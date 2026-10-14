use js_export_macro::js_export;
use miden_client::account::Account as NativeAccount;
use miden_client::account::standards::faucets::NonFungibleFaucet as NativeNonFungibleFaucet;

use super::account::Account;
use super::token_symbol::TokenSymbol;
use crate::js_error_with_context;
use crate::platform::JsErr;

/// Provides metadata for a non-fungible faucet account component: the collection's symbol, name
/// and optional descriptive fields.
#[js_export]
pub struct NonFungibleFaucetComponent(NativeNonFungibleFaucet);

#[js_export]
impl NonFungibleFaucetComponent {
    /// Extracts the collection metadata from a non-fungible faucet account.
    #[js_export(js_name = "fromAccount")]
    pub fn from_account(account: &Account) -> Result<Self, JsErr> {
        let native_account: NativeAccount = account.into();
        let faucet = NativeNonFungibleFaucet::try_from(&native_account).map_err(|e| {
            js_error_with_context(e, "failed to get non-fungible faucet details from account")
        })?;
        Ok(Self(faucet))
    }

    /// Returns the collection symbol.
    pub fn symbol(&self) -> TokenSymbol {
        self.0.symbol().into()
    }

    /// Returns the human-readable collection name.
    #[js_export(js_name = "tokenName")]
    pub fn token_name(&self) -> String {
        self.0.token_name().as_str().to_string()
    }

    /// Returns the optional collection description, or `undefined` when unset.
    pub fn description(&self) -> Option<String> {
        self.0.description().map(|d| d.as_str().to_string())
    }

    /// Returns the optional collection logo URI, or `undefined` when unset.
    #[js_export(js_name = "logoUri")]
    pub fn logo_uri(&self) -> Option<String> {
        self.0.logo_uri().map(|uri| uri.as_str().to_string())
    }

    /// Returns the optional pointer to the collection metadata, or `undefined` when unset.
    #[js_export(js_name = "contractUri")]
    pub fn contract_uri(&self) -> Option<String> {
        self.0.contract_uri().map(|link| link.as_str().to_string())
    }
}
