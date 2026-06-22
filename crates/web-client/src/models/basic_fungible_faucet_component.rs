use js_export_macro::js_export;
use miden_client::Felt as NativeFelt;
use miden_client::account::Account as NativeAccount;
use miden_client::account::component::FungibleFaucet as NativeFungibleFaucet;

use super::account::Account;
use super::felt::Felt;
use super::token_symbol::TokenSymbol;
use crate::js_error_with_context;
use crate::platform::JsErr;

/// Provides metadata for a fungible faucet account component.
///
/// Reads the on-chain `FungibleFaucet` component for the account, which holds the per-token
/// info (symbol, decimals, supply, and the descriptive metadata). The same component backs both
/// "basic" public faucets and network-style faucets — in the current protocol the distinction is
/// a function of the surrounding account configuration (account type, auth, access control), not
/// of the faucet component itself — so this reads metadata from either kind of faucet account.
#[js_export]
pub struct BasicFungibleFaucetComponent(NativeFungibleFaucet);

#[js_export]
impl BasicFungibleFaucetComponent {
    /// Extracts faucet metadata from an account.
    #[js_export(js_name = "fromAccount")]
    #[allow(clippy::needless_pass_by_value)]
    pub fn from_account(account: Account) -> Result<Self, JsErr> {
        let native_account: NativeAccount = account.into();
        let faucet = NativeFungibleFaucet::try_from(&native_account).map_err(|e| {
            js_error_with_context(e, "failed to get basic fungible faucet details from account")
        })?;
        Ok(Self(faucet))
    }

    /// Returns the faucet's token symbol.
    pub fn symbol(&self) -> TokenSymbol {
        self.0.symbol().into()
    }

    /// Returns the human-readable token name.
    #[js_export(js_name = "tokenName")]
    pub fn token_name(&self) -> String {
        self.0.token_name().as_str().to_string()
    }

    /// Returns the number of decimal places for the token.
    pub fn decimals(&self) -> u8 {
        self.0.decimals()
    }

    /// Returns the maximum token supply.
    #[js_export(js_name = "maxSupply")]
    pub fn max_supply(&self) -> Felt {
        NativeFelt::from(self.0.max_supply()).into()
    }

    /// Returns the current token supply (the amount minted so far).
    #[js_export(js_name = "tokenSupply")]
    pub fn token_supply(&self) -> Felt {
        NativeFelt::from(self.0.token_supply()).into()
    }

    /// Returns the optional free-form token description, or `undefined` when unset.
    pub fn description(&self) -> Option<String> {
        self.0.description().map(|d| d.as_str().to_string())
    }

    /// Returns the optional token logo URI, or `undefined` when unset.
    #[js_export(js_name = "logoUri")]
    pub fn logo_uri(&self) -> Option<String> {
        self.0.logo_uri().map(|uri| uri.as_str().to_string())
    }

    /// Returns the optional external link (e.g. project website), or `undefined` when unset.
    #[js_export(js_name = "externalLink")]
    pub fn external_link(&self) -> Option<String> {
        self.0.external_link().map(|link| link.as_str().to_string())
    }
}
