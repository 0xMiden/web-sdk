use js_export_macro::js_export;
use miden_client::auth::AuthSecretKey;
use miden_client::block::BlockNumber;
use miden_client::keystore::Keystore;

use super::models::account::Account;
use super::models::account_storage_mode::AccountStorageMode;
use super::models::auth::AuthScheme;
use super::models::auth_secret_key::AuthSecretKey as WebAuthSecretKey;
use crate::helpers::generate_wallet;
use crate::models::account_id::AccountId;
use crate::platform::{JsErr, from_str_err, maybe_wrap_send};
use crate::{WebClient, js_error_with_context};

impl WebClient {
    /// Syncs state if the client has never been synced (still at genesis block).
    ///
    /// This prevents a slow full-chain scan on the next sync after account creation.
    /// Errors are intentionally ignored — account creation should proceed regardless.
    async fn maybe_sync_before_account_creation(&self) {
        let should_sync = {
            let mut guard = self.get_mut_inner().await;
            match guard.as_mut() {
                Some(client) => {
                    client.get_sync_height().await.is_ok_and(|h| h == BlockNumber::GENESIS)
                },
                None => false,
            }
        };

        if should_sync {
            let mut guard = self.get_mut_inner().await;
            if let Some(client) = guard.as_mut() {
                let _ = maybe_wrap_send(client.sync_state()).await;
            }
        }
    }
}

#[js_export]
impl WebClient {
    /// Faucet creation stubbed during the miden-client PR #2214 migration.
    ///
    /// The 0.15 protocol surface restructured the faucet construction path
    /// completely — `BasicFungibleFaucet`, `FungibleTokenMetadata`,
    /// `PolicyAuthority`, `TokenPolicyManager`, `MintPolicyConfig`,
    /// `BurnPolicyConfig`, `TokenName` are all no longer importable from
    /// `miden_client::account::component`, and the `AccountType::FungibleFaucet`
    /// variant is gone too (the on-chain `AccountType` is now a 2-way
    /// `{ Private, Public }`). The JS method is kept so consumers don't see
    /// a `Cannot read property 'newFaucet' of undefined`, but it fails fast
    /// with a clear message at runtime. Tracked as a PR-A follow-up — the
    /// proper port needs to come once the upstream faucet API stabilizes.
    #[js_export(js_name = "newFaucet")]
    #[allow(clippy::too_many_arguments, clippy::unused_async)]
    pub async fn new_faucet(
        &self,
        _storage_mode: &AccountStorageMode,
        _non_fungible: bool,
        _token_name: String,
        _token_symbol: String,
        _decimals: u8,
        _max_supply: JsU64,
        _auth_scheme: AuthScheme,
    ) -> Result<Account, JsErr> {
        Err(from_str_err(
            "newFaucet is not available against this miden-client version: \
             the faucet construction surface (BasicFungibleFaucet, \
             FungibleTokenMetadata, PolicyAuthority, TokenPolicyManager, \
             AccountType::FungibleFaucet) was restructured / removed upstream \
             in PR #2214. Tracked as a follow-up to the migration.",
        ))
    }

    #[js_export(js_name = "newWallet")]
    pub async fn new_wallet(
        &self,
        storage_mode: &AccountStorageMode,
        mutable: bool,
        auth_scheme: AuthScheme,
        init_seed: Option<Vec<u8>>,
    ) -> Result<Account, JsErr> {
        self.maybe_sync_before_account_creation().await;
        let keystore = self.get_keystore().await?;

        let (new_account, key_pair) =
            generate_wallet(storage_mode, mutable, init_seed, auth_scheme).await?;

        {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
            client
                .add_account(&new_account, false)
                .await
                .map_err(|err| js_error_with_context(err, "failed to insert new wallet"))?;
        }

        keystore
            .add_key(&key_pair, new_account.id())
            .await
            .map_err(|err| from_str_err(&err.to_string()))?;

        Ok(new_account.into())
    }

    #[js_export(js_name = "newAccount")]
    pub async fn new_account(&self, account: &Account, overwrite: bool) -> Result<(), JsErr> {
        self.maybe_sync_before_account_creation().await;
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let native_account = account.into();

        client
            .add_account(&native_account, overwrite)
            .await
            .map_err(|err| js_error_with_context(err, "failed to insert new account"))?;
        Ok(())
    }

    /// Inserts an account and its secret key in one call, matching how
    /// `newWallet` / `newFaucet` already work internally.  If the key
    /// insertion fails the account is still persisted (same as wallet/faucet),
    /// but callers only need a single await instead of two.
    #[js_export(js_name = "newAccountWithSecretKey")]
    pub async fn new_account_with_secret_key(
        &self,
        account: &Account,
        secret_key: &WebAuthSecretKey,
    ) -> Result<(), JsErr> {
        self.maybe_sync_before_account_creation().await;
        let native_account: miden_client::account::Account = account.into();
        let account_id = native_account.id();

        {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
            client
                .add_account(&native_account, false)
                .await
                .map_err(|err| js_error_with_context(err, "failed to insert new account"))?;
        }

        let keystore = self.get_keystore().await?;
        let native_secret_key: AuthSecretKey = secret_key.into();

        keystore
            .add_key(&native_secret_key, account_id)
            .await
            .map_err(|err| js_error_with_context(err, "failed to add secret key"))?;

        Ok(())
    }

    #[js_export(js_name = "addAccountSecretKeyToWebStore")]
    pub async fn add_account_secret_key_to_web_store(
        &self,
        account_id: &AccountId,
        secret_key: &WebAuthSecretKey,
    ) -> Result<(), JsErr> {
        let keystore = self.get_keystore().await?;
        let native_secret_key: AuthSecretKey = secret_key.into();
        let native_account_id = account_id.into();

        keystore
            .add_key(&native_secret_key, native_account_id)
            .await
            .map_err(|err| from_str_err(&err.to_string()))?;

        Ok(())
    }
}
