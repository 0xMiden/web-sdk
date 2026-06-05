use js_export_macro::js_export;

use super::account::Account;
use super::felt::Felt;
use super::token_symbol::TokenSymbol;
use crate::platform::{JsErr, from_str_err};

/// Provides metadata for a basic fungible faucet account component.
///
/// Stubbed during the miden-client PR #2214 migration — the upstream
/// `miden_client::account::component::FungibleTokenMetadata` type no
/// longer exists on the 0.15 protocol surface (the whole faucet /
/// token-metadata module was restructured). The JS class is kept so
/// `BasicFungibleFaucetComponent` is still importable, but every method
/// fails fast at runtime. Tracked as a follow-up to PR-A.
#[js_export]
pub struct BasicFungibleFaucetComponent {
    // No native backing — the upstream type is gone.
    _private: (),
}

#[js_export]
impl BasicFungibleFaucetComponent {
    /// Extracts faucet metadata from an account.
    ///
    /// Currently fails fast — see this module's struct doc.
    #[js_export(js_name = "fromAccount")]
    #[allow(clippy::needless_pass_by_value, clippy::unused_async)]
    pub fn from_account(_account: Account) -> Result<Self, JsErr> {
        Err(stub_err())
    }

    /// Returns the faucet's token symbol.
    pub fn symbol(&self) -> Result<TokenSymbol, JsErr> {
        Err(stub_err())
    }

    /// Returns the number of decimal places for the token.
    pub fn decimals(&self) -> Result<u8, JsErr> {
        Err(stub_err())
    }

    /// Returns the maximum token supply.
    #[js_export(js_name = "maxSupply")]
    pub fn max_supply(&self) -> Result<Felt, JsErr> {
        Err(stub_err())
    }
}

fn stub_err() -> JsErr {
    from_str_err(
        "BasicFungibleFaucetComponent is unavailable against this miden-client \
         version: `FungibleTokenMetadata` was restructured / removed upstream in \
         PR #2214. Tracked as a follow-up to the migration.",
    )
}
