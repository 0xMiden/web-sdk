use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::keystore::Keystore;

use crate::models::account::Account;
use crate::models::account_code::AccountCode;
use crate::models::account_header::AccountHeader;
use crate::models::account_id::AccountId;
use crate::models::account_reader::AccountReader;
use crate::models::account_storage::AccountStorage;
use crate::models::address::Address;
use crate::models::asset_vault::AssetVault;
use crate::models::auth_secret_key::AuthSecretKey;
use crate::models::felt::Felt;
use crate::models::word::Word;
use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    #[js_export(js_name = "getAccounts")]
    pub async fn get_accounts(&self) -> Result<Vec<AccountHeader>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let result = client
            .get_account_headers()
            .await
            .map_err(|err| js_error_with_context(err, "failed to get accounts"))?;

        Ok(result.into_iter().map(|(header, _)| header.into()).collect())
    }

    /// Retrieves the full account data for the given account ID, returning `null` if not found.
    ///
    /// This method loads the complete account state including vault, storage, and code.
    #[js_export(js_name = "getAccount")]
    pub async fn get_account(&self, account_id: &AccountId) -> Result<Option<Account>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        client
            .get_account(account_id.into())
            .await
            .map(|opt| opt.map(Into::into))
            .map_err(|err| js_error_with_context(err, "failed to get account"))
    }

    /// Retrieves the asset vault for a specific account.
    ///
    /// To check the balance for a single asset, use `accountReader` instead.
    #[js_export(js_name = "getAccountVault")]
    pub async fn get_account_vault(&self, account_id: &AccountId) -> Result<AssetVault, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        client
            .get_account_vault(account_id.into())
            .await
            .map(Into::into)
            .map_err(|err| js_error_with_context(err, "failed to get account vault"))
    }

    /// Retrieves the storage for a specific account.
    ///
    /// To only load a specific slot, use `accountReader` instead.
    #[js_export(js_name = "getAccountStorage")]
    pub async fn get_account_storage(
        &self,
        account_id: &AccountId,
    ) -> Result<AccountStorage, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        client
            .get_account_storage(account_id.into())
            .await
            .map(Into::into)
            .map_err(|err| js_error_with_context(err, "failed to get account storage"))
    }

    /// Retrieves the account code for a specific account.
    ///
    /// Returns `null` if the account is not found.
    #[js_export(js_name = "getAccountCode")]
    pub async fn get_account_code(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<AccountCode>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        client
            .get_account_code(account_id.into())
            .await
            .map(|opt| opt.map(Into::into))
            .map_err(|err| js_error_with_context(err, "failed to get account code"))
    }

    /// Creates a new `AccountReader` for lazy access to account data.
    ///
    /// The `AccountReader` executes queries lazily - each method call fetches fresh data
    /// from storage, ensuring you always see the current state.
    ///
    /// # Arguments
    /// * `account_id` - The ID of the account to read.
    ///
    /// # Example
    /// ```javascript
    /// const reader = client.accountReader(accountId);
    /// const nonce = await reader.nonce();
    /// const balance = await reader.getBalance(faucetId);
    /// ```
    #[js_export(js_name = "accountReader")]
    pub async fn account_reader(&self, account_id: &AccountId) -> Result<AccountReader, JsErr> {
        let guard = self.inner.lock().await;
        let client = guard.as_ref().ok_or_else(|| from_str_err("Client not initialized"))?;
        Ok(AccountReader::from(client.account_reader(account_id.into())))
    }

    /// Retrieves an authentication secret key from the keystore given a public key commitment.
    ///
    /// The public key commitment should correspond to one of the keys tracked by the keystore.
    /// Returns the associated [`AuthSecretKey`] if found, or an error if not found.
    #[js_export(js_name = "getAccountAuthByPubKeyCommitment")]
    pub async fn get_account_auth_secret_key_by_pub_key_commitment(
        &self,
        pub_key_commitment: &Word,
    ) -> Result<AuthSecretKey, JsErr> {
        let keystore = self.get_keystore().await?;

        let auth_secret_key = keystore
            .get_key((*pub_key_commitment.as_native()).into())
            .await
            .map_err(|err| js_error_with_context(err, "failed to get auth key for account"))?
            .ok_or(from_str_err("Auth not found for account"))?;

        Ok(auth_secret_key.into())
    }

    /// Returns all public key commitments associated with the given account ID.
    ///
    /// These commitments can be used with [`getAccountAuthByPubKeyCommitment`]
    /// to retrieve the corresponding secret keys from the keystore.
    #[js_export(js_name = "getPublicKeyCommitmentsOfAccount")]
    pub async fn get_public_key_commitments_of(
        &self,
        account_id: &AccountId,
    ) -> Result<Vec<Word>, JsErr> {
        let keystore = self.get_keystore().await?;
        Ok(keystore
            .get_account_key_commitments(account_id.as_native())
            .await
            .map_err(|err| {
                js_error_with_context(
                    err,
                    &format!(
                        "failed to fetch public key commitments for account: {}",
                        account_id.as_native()
                    ),
                )
            })?
            .into_iter()
            .map(NativeWord::from)
            .map(Into::into)
            .collect())
    }

    #[js_export(js_name = "insertAccountAddress")]
    pub async fn insert_account_address(
        &self,
        account_id: &AccountId,
        address: &Address,
    ) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        client
            .add_address(address.into(), account_id.into())
            .await
            .map_err(|err| js_error_with_context(err, "failed to add address to account"))?;
        Ok(())
    }

    #[js_export(js_name = "removeAccountAddress")]
    pub async fn remove_account_address(
        &self,
        account_id: &AccountId,
        address: &Address,
    ) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        client
            .remove_address(address.into(), account_id.into())
            .await
            .map_err(|err| js_error_with_context(err, "failed to remove address from account"))?;
        Ok(())
    }

    /// Retrieves the full account data for the account associated with the given public key
    /// commitment, returning `null` if no account is found.
    #[js_export(js_name = "getAccountByKeyCommitment")]
    pub async fn get_account_by_key_commitment(
        &self,
        pub_key_commitment: &Word,
    ) -> Result<Option<Account>, JsErr> {
        let keystore = self.get_keystore().await?;

        let account_id = keystore
            .get_account_id_by_key_commitment((*pub_key_commitment.as_native()).into())
            .await
            .map_err(|err| js_error_with_context(err, "failed to get account by key commitment"))?;

        match account_id {
            Some(id) => self.get_account(&id.into()).await,
            None => Ok(None),
        }
    }

    /// Prunes historical account states for the specified account up to the given nonce.
    ///
    /// Deletes all historical entries with `replaced_at_nonce <= up_to_nonce` and any
    /// orphaned account code.
    ///
    /// Returns the total number of rows deleted, including historical entries and orphaned
    /// account code.
    #[js_export(js_name = "pruneAccountHistory")]
    pub async fn prune_account_history(
        &self,
        account_id: &AccountId,
        up_to_nonce: &Felt,
    ) -> Result<u32, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let deleted = client
            .prune_account_history(account_id.into(), up_to_nonce.into())
            .await
            .map_err(|err| js_error_with_context(err, "failed to prune account history"))?;
        // SAFETY: on wasm32 usize is 32 bits, so this conversion is infallible
        Ok(u32::try_from(deleted).expect("deleted count should fit in u32"))
    }

    // ACCOUNT REGISTRATION
    // --------------------------------------------------------------------------------------------

    /// Binds an invitation code to a tracked account on the network allowlist.
    ///
    /// A network that enforces an account allowlist creates an account on chain only when the
    /// account is registered. The first transaction of an account is what creates it, so the
    /// account must be registered before that transaction is submitted: a submission that would
    /// create an account the network does not accept fails with `ACCOUNT_NOT_ALLOWLISTED`. Only
    /// account creation is gated. An account that already exists on chain is never checked, and
    /// network accounts are exempt.
    ///
    /// The account must be tracked by this client, must not be deployed on chain yet, and must
    /// not be a network account. A registration consumes the code, so the client asks the node
    /// first and does not send it for an account the node already allows: that fails with
    /// `ACCOUNT_ALREADY_ALLOWED`, which a network that does not enforce an allowlist answers for
    /// every account. The node's own rejections carry `INVITATION_NOT_FOUND`,
    /// `ALREADY_REGISTERED` or `INVALID_REGISTRATION_REQUEST`.
    ///
    /// When the network operator runs a funding service, the node pays the registered account a
    /// public P2ID note with the native asset and answers once that note is committed, so this
    /// call can take a few blocks. The note reaches the client on the next sync; consuming it is
    /// the first transaction, which creates the account on chain and pays its fee out of the
    /// received funds.
    #[js_export(js_name = "registerAccount")]
    pub async fn register_account(
        &self,
        account_id: &AccountId,
        invitation_code: String,
    ) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        client
            .register_account(account_id.into(), &invitation_code)
            .await
            .map_err(|err| js_error_with_context(err, "failed to register account"))
    }

    /// Returns whether the network lets the account be created on chain.
    ///
    /// The node answers `true` when it does not enforce an account allowlist, or when the
    /// account is registered. Only account creation is gated, so the answer says nothing about
    /// an account that already exists on chain.
    #[js_export(js_name = "isAccountAllowed")]
    pub async fn is_account_allowed(&self, account_id: &AccountId) -> Result<bool, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        client.is_account_allowed(account_id.into()).await.map_err(|err| {
            js_error_with_context(err, "failed to check whether the account is allowed")
        })
    }
}
