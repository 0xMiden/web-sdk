use js_export_macro::js_export;
use miden_client::account::Account as NativeAccount;
use miden_client::account::component::FungibleFaucet as NativeFungibleFaucet;

use super::account::Account;
use super::felt::Felt;
use super::token_symbol::TokenSymbol;
use crate::js_error_with_context;
use crate::platform::JsErr;

/// Provides metadata for a basic fungible faucet account component.
///
/// Reads the on-chain [`FungibleFaucet`] component for the account, which holds the
/// per-token info (symbol/decimals/maxSupply).
#[js_export]
pub struct BasicFungibleFaucetComponent(NativeFungibleFaucet);

#[js_export]
impl BasicFungibleFaucetComponent {
    /// Extracts faucet metadata from an account.
    #[js_export(js_name = "fromAccount")]
    pub fn from_account(account: Account) -> Result<Self, JsErr> {
        let native_account: NativeAccount = account.into();
        let faucet = NativeFungibleFaucet::try_from(native_account.storage()).map_err(|e| {
            js_error_with_context(e, "failed to get basic fungible faucet details from account")
        })?;
        Ok(Self(faucet))
    }

    /// Returns the faucet's token symbol.
    pub fn symbol(&self) -> TokenSymbol {
        self.0.symbol().clone().into()
    }

    /// Returns the number of decimal places for the token.
    pub fn decimals(&self) -> u8 {
        self.0.decimals()
    }

    /// Returns the maximum token supply.
    #[js_export(js_name = "maxSupply")]
    pub fn max_supply(&self) -> Felt {
        miden_client::Felt::from(self.0.max_supply()).into()
    }
}
