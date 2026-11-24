use alloc::format;
use core::error::Error;
use core::future::Future;

use js_export_macro::js_export;
use miden_client::account::Account as NativeAccount;
use miden_client::account::standards::auth::NetworkAccount;
use miden_client::account::standards::fees::FeePolicyManager;
use miden_client::asset::AssetId;
use miden_client::auth::AuthSecretKey;
use miden_client::block::{BlockHeader, BlockNumber};
use miden_client::keystore::Keystore;
use miden_client::protocol_config::ProtocolConfig;
use miden_client::{Client, ClientError};

use super::models::account::Account;
use super::models::account_storage_mode::AccountStorageMode;
use super::models::auth::AuthScheme;
use super::models::auth_secret_key::AuthSecretKey as WebAuthSecretKey;
use crate::helpers::{generate_faucet, generate_wallet};
use crate::models::account_id::AccountId;
use crate::platform::{ClientAuth, JsErr, from_str_err, js_u64_to_u64, maybe_wrap_send};
use crate::{WebClient, js_error_with_context};

impl WebClient {
    /// The chain's fee faucet as `feeFaucetId()` resolves it, or `None` when it is not known (no
    /// protocol configuration stored for the sync height and no creation-time faucet). Storage
    /// and protocol-config read failures are errors, not `None`.
    pub(crate) async fn known_fee_faucet_id(&self) -> Result<Option<AccountId>, JsErr> {
        if let Some(config) = self.synced_protocol_config().await? {
            return Ok(Some(config.fee_asset_id().faucet_id().into()));
        }
        Ok((*self.fee_faucet.lock().await).map(Into::into))
    }

    /// The protocol configuration the block at the sync height commits to, or `None` when the
    /// store has no header (see `header_at_sync_height`) or no configuration for that block.
    /// Storage read failures are errors.
    pub(crate) async fn synced_protocol_config(&self) -> Result<Option<ProtocolConfig>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;

        let Some(header) = header_at_sync_height(client).await? else {
            return Ok(None);
        };
        match client.get_protocol_config(header.protocol_config_commitment()).await {
            Ok(config) => Ok(Some(config)),
            Err(miden_client::ClientError::StoreError(
                miden_client::store::StoreError::ProtocolConfigNotFound(_),
            )) => Ok(None),
            Err(err) => {
                Err(js_error_with_context(err, "failed to read the protocol configuration"))
            },
        }
    }

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

    /// Rejects a network account whose `FeePolicyManager` fee-asset faucet differs from the
    /// chain's (`feeFaucetId()`). The node's network-transaction builder silently refuses such
    /// accounts; catching the mismatch here avoids deploying an account that can never consume
    /// notes. Non-network accounts and accounts whose fee-asset slot cannot be read are left
    /// alone. When the chain fee faucet is not known (no configuration stored for the sync height
    /// and no creation-time faucet), the check is skipped rather than blocking insert.
    async fn reject_mismatched_network_fee_faucet(
        &self,
        account: &NativeAccount,
    ) -> Result<(), JsErr> {
        if NetworkAccount::new(account.clone()).is_err() {
            return Ok(());
        }

        let Some(chain_fee) = self.known_fee_faucet_id().await? else {
            return Ok(());
        };
        let chain_fee_native: miden_client::account::AccountId = (&chain_fee).into();

        let Ok(fee_asset_word) = account.storage().get_item(FeePolicyManager::fee_asset_id_slot())
        else {
            return Ok(());
        };
        let Ok(account_fee_faucet) = AssetId::try_from(fee_asset_word).map(|id| id.faucet_id())
        else {
            return Ok(());
        };

        if account_fee_faucet != chain_fee_native {
            return Err(from_str_err(&format!(
                "network account fee faucet {account_fee_faucet} does not match the chain's fee \
                 faucet {chain_fee_native} (client.feeFaucetId()); rebuild the account with \
                 AccountComponent.createNetworkAuthComponents(..., await client.feeFaucetId())"
            )));
        }

        Ok(())
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

        let max_supply = js_u64_to_u64(max_supply)?;
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
    ///
    /// A network account whose fee-asset faucet differs from `feeFaucetId()` is rejected before
    /// insert: the node would accept the deploy and then never consume notes sent to it.
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
        let native_account: NativeAccount = account.into();
        self.reject_mismatched_network_fee_faucet(&native_account).await?;

        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;

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
    ///
    /// Same network-account fee-faucet check as [`Self::new_account`].
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
        let native_account: NativeAccount = account.into();
        self.reject_mismatched_network_fee_faucet(&native_account).await?;
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

// Node.js futures must be `Send` for napi. Browser futures are not, so the bound is empty there.
#[cfg(feature = "nodejs")]
trait MaybeSend: Send {}

#[cfg(feature = "nodejs")]
impl<T: Send> MaybeSend for T {}

#[cfg(not(feature = "nodejs"))]
trait MaybeSend {}

#[cfg(not(feature = "nodejs"))]
impl<T> MaybeSend for T {}

/// Reads of the sync height and of the value stored at one height.
trait SyncHeightRead: MaybeSend {
    type Value: MaybeSend;
    type Error: Error + MaybeSend + 'static;

    fn height(&mut self) -> impl Future<Output = Result<BlockNumber, Self::Error>> + MaybeSend;
    fn value_at(
        &mut self,
        height: BlockNumber,
    ) -> impl Future<Output = Result<Option<Self::Value>, Self::Error>> + MaybeSend;
}

impl SyncHeightRead for Client<ClientAuth> {
    type Value = BlockHeader;
    type Error = ClientError;

    fn height(&mut self) -> impl Future<Output = Result<BlockNumber, Self::Error>> + MaybeSend {
        Client::get_sync_height(self)
    }

    // `async fn` cannot name the `MaybeSend` bound this method returns.
    #[allow(clippy::manual_async_fn)]
    fn value_at(
        &mut self,
        height: BlockNumber,
    ) -> impl Future<Output = Result<Option<Self::Value>, Self::Error>> + MaybeSend {
        async move {
            self.get_block_header_by_num(height)
                .await
                .map(|found| found.map(|(header, _)| header))
        }
    }
}

/// The value stored at the sync height, or `None` when nothing has been synced.
///
/// Another client on the same store can sync between the two reads: it advances the height and
/// prunes the header the first read named. So a missing header means "not synced" only when a
/// second read shows the same height; a different height is followed, with no retry cap, since
/// capping it would report a synced client as unsynced. One `MidenClient` cannot race itself,
/// because its calls share one call chain.
async fn header_at_sync_height<S>(source: &mut S) -> Result<Option<S::Value>, JsErr>
where
    S: SyncHeightRead,
{
    loop {
        let height = source
            .height()
            .await
            .map_err(|err| js_error_with_context(err, "failed to read the sync height"))?;
        let found = source
            .value_at(height)
            .await
            .map_err(|err| js_error_with_context(err, "failed to read the synced block header"))?;
        if let Some(value) = found {
            return Ok(Some(value));
        }
        let height_now = source
            .height()
            .await
            .map_err(|err| js_error_with_context(err, "failed to read the sync height"))?;
        if height_now == height {
            return Ok(None);
        }
    }
}

#[cfg(all(test, feature = "nodejs"))]
mod header_at_sync_height_tests {
    use core::future::{Future, ready};

    use miden_client::block::BlockNumber;

    use super::{MaybeSend, SyncHeightRead, header_at_sync_height};

    #[derive(Debug, thiserror::Error)]
    #[error("height called past the script")]
    struct PastScript;

    struct Script {
        heights: &'static [u32],
        reads: usize,
        present: Option<u32>,
        value: &'static str,
    }

    impl Script {
        fn new(heights: &'static [u32], present: Option<u32>, value: &'static str) -> Self {
            Self { heights, reads: 0, present, value }
        }
    }

    impl SyncHeightRead for Script {
        type Value = &'static str;
        type Error = PastScript;

        fn height(&mut self) -> impl Future<Output = Result<BlockNumber, Self::Error>> + MaybeSend {
            let result = match self.heights.get(self.reads).copied() {
                Some(height) => {
                    self.reads += 1;
                    Ok(BlockNumber::from(height))
                },
                None => Err(PastScript),
            };
            ready(result)
        }

        fn value_at(
            &mut self,
            height: BlockNumber,
        ) -> impl Future<Output = Result<Option<Self::Value>, Self::Error>> + MaybeSend {
            let value = (self.present == Some(height.as_u32())).then_some(self.value);
            ready(Ok(value))
        }
    }

    #[tokio::test]
    async fn pruned_header_follows_the_new_sync_height() {
        let mut source = Script::new(&[4, 9, 9, 12, 12], Some(12), "value-at-12");
        let value = header_at_sync_height(&mut source).await.expect("scripted height read");
        assert_eq!(value, Some("value-at-12"));
        assert_eq!(source.reads, 5);
    }

    #[tokio::test]
    async fn unchanged_height_without_a_header_is_unsynced() {
        let mut source = Script::new(&[4, 4], None, "unused");
        let value = header_at_sync_height(&mut source).await.expect("scripted height read");
        assert_eq!(value, None);
        assert_eq!(source.reads, 2);
    }

    #[tokio::test]
    async fn header_present_reads_height_once() {
        let mut source = Script::new(&[4], Some(4), "value-at-4");
        let value = header_at_sync_height(&mut source).await.expect("scripted height read");
        assert_eq!(value, Some("value-at-4"));
        assert_eq!(source.reads, 1);
    }
}
