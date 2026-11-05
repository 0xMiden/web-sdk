use js_export_macro::js_export;
use miden_client::auth::AuthSecretKey;
use miden_client::block::BlockNumber;
use miden_client::keystore::Keystore;

use super::models::account::Account;
use super::models::account_storage_mode::AccountStorageMode;
use super::models::auth::AuthScheme;
use super::models::auth_secret_key::AuthSecretKey as WebAuthSecretKey;
use crate::helpers::{generate_faucet, generate_wallet};
use crate::models::account_id::AccountId;
use crate::platform::{JsErr, from_str_err, js_u64_to_u64, maybe_wrap_send};
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
    /// Syncs the client if it has never been synced (its sync height is still the genesis
    /// block), as each account creation method does first unless told to skip it. Sync errors
    /// are ignored.
    ///
    /// The sync writes the chain MMR, so the JS `WebClient` runs this under the store lock, both
    /// here and inside an account creation, which it then calls with `skip_pre_sync` set, so the
    /// creation itself runs without the lock.
    #[js_export(js_name = "syncBeforeAccountCreation")]
    pub async fn sync_before_account_creation(&self) -> Result<(), JsErr> {
        self.maybe_sync_before_account_creation().await;
        Ok(())
    }

    /// Creates, persists, and returns a new fungible faucet account.
    ///
    /// Only fungible faucets are supported, so passing `non_fungible = true` fails fast with a
    /// clear message. The faucet is registered with mint and burn policies (both `AllowAll`); its
    /// secret key is added to the keystore. It first runs `syncBeforeAccountCreation` unless
    /// `skip_pre_sync` is `true`.
    #[js_export(js_name = "newFaucet")]
    #[allow(clippy::too_many_arguments)]
    pub async fn new_faucet(
        &self,
        storage_mode: &AccountStorageMode,
        non_fungible: bool,
        token_name: String,
        token_symbol: String,
        decimals: u8,
        max_supply: JsU64,
        auth_scheme: AuthScheme,
        skip_pre_sync: Option<bool>,
    ) -> Result<Account, JsErr> {
        if non_fungible {
            return Err(from_str_err("Non-fungible faucets are not supported yet"));
        }

        if skip_pre_sync != Some(true) {
            self.maybe_sync_before_account_creation().await;
        }
        let keystore = self.get_keystore().await?;

        let max_supply = js_u64_to_u64(max_supply);
        let (new_account, key_pair) = generate_faucet(
            storage_mode,
            token_name,
            token_symbol,
            decimals,
            max_supply,
            auth_scheme,
        )
        .await?;

        {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
            client
                .add_account(&new_account, false)
                .await
                .map_err(|err| js_error_with_context(err, "failed to insert new faucet"))?;
        }

        keystore
            .add_key(&key_pair, new_account.id())
            .await
            .map_err(|err| from_str_err(&err.to_string()))?;

        Ok(new_account.into())
    }

    /// Creates, persists, and returns a new wallet account; its secret key is added to the
    /// keystore. It first runs `syncBeforeAccountCreation` unless `skip_pre_sync` is `true`.
    #[js_export(js_name = "newWallet")]
    pub async fn new_wallet(
        &self,
        storage_mode: &AccountStorageMode,
        auth_scheme: AuthScheme,
        init_seed: Option<Vec<u8>>,
        skip_pre_sync: Option<bool>,
    ) -> Result<Account, JsErr> {
        if skip_pre_sync != Some(true) {
            self.maybe_sync_before_account_creation().await;
        }
        let keystore = self.get_keystore().await?;

        let (new_account, key_pair) = generate_wallet(storage_mode, init_seed, auth_scheme).await?;

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

    /// Inserts an account. It first runs `syncBeforeAccountCreation` unless `skip_pre_sync` is
    /// `true`.
    #[js_export(js_name = "newAccount")]
    pub async fn new_account(
        &self,
        account: &Account,
        overwrite: bool,
        skip_pre_sync: Option<bool>,
    ) -> Result<(), JsErr> {
        if skip_pre_sync != Some(true) {
            self.maybe_sync_before_account_creation().await;
        }
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
    /// but callers only need a single await instead of two. It first runs
    /// `syncBeforeAccountCreation` unless `skip_pre_sync` is `true`.
    #[js_export(js_name = "newAccountWithSecretKey")]
    pub async fn new_account_with_secret_key(
        &self,
        account: &Account,
        secret_key: &WebAuthSecretKey,
        skip_pre_sync: Option<bool>,
    ) -> Result<(), JsErr> {
        if skip_pre_sync != Some(true) {
            self.maybe_sync_before_account_creation().await;
        }
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
