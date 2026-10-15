use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::note::NoteTag;
use miden_client::note_transport::NoteTransportCursor;
use miden_client::protocol_config::ProtocolConfig;
use miden_client::rpc::RpcLimits;
use miden_client::rpc::encryption::TransactionEncryptionKey;
use miden_client::store::StoreError;
use miden_client_proto::{ProtobufValue, decode_unchecked, encode};

mod js_bindings;
mod models;

use js_bindings::{
    idxdb_get_client_config,
    idxdb_get_setting,
    idxdb_insert_client_config,
    idxdb_insert_setting,
    idxdb_list_setting_keys,
    idxdb_remove_client_config,
    idxdb_remove_setting,
};

use crate::IdxdbStore;
use crate::promise::{await_js, await_js_value};
use crate::settings::models::SettingValueIdxdbObject;

// CLIENT CONFIG KEYS
// ================================================================================================

const RPC_LIMITS_KEY: &str = "rpc_limits";
const TRANSACTION_ENCRYPTION_KEY_KEY: &str = "transaction_encryption_key";
const NOTE_TRANSPORT_CURSORS_KEY: &str = "note_transport_cursors";

/// Returns the `clientConfig` key of the protocol configuration for `commitment`.
fn protocol_config_key(commitment: Word) -> String {
    format!("protocol_config:{commitment}")
}

impl IdxdbStore {
    // USER SETTINGS
    // --------------------------------------------------------------------------------------------

    pub(crate) async fn set_setting(&self, key: String, value: Vec<u8>) -> Result<(), StoreError> {
        let promise = idxdb_insert_setting(self.db_id(), key, value);
        await_js_value(promise, "failed to set setting value").await?;
        Ok(())
    }

    pub(crate) async fn get_setting(&self, key: String) -> Result<Option<Vec<u8>>, StoreError> {
        let promise = idxdb_get_setting(self.db_id(), key);
        let setting: Option<SettingValueIdxdbObject> =
            await_js(promise, "failed to get setting value from idxdb").await?;
        Ok(setting.map(|setting| setting.value))
    }

    pub(crate) async fn remove_setting(&self, key: String) -> Result<bool, StoreError> {
        let promise = idxdb_remove_setting(self.db_id(), key);
        await_js(promise, "failed to delete setting value").await
    }

    pub(crate) async fn list_setting_keys(&self) -> Result<Vec<String>, StoreError> {
        let promise = idxdb_list_setting_keys(self.db_id());
        await_js(promise, "failed to list setting keys").await
    }

    // CLIENT CONFIG
    // --------------------------------------------------------------------------------------------

    /// Reads a client value that this store wrote as a protobuf message.
    pub(crate) async fn get_client_setting<T: ProtobufValue>(
        &self,
        key: String,
    ) -> Result<Option<T>, StoreError> {
        let promise = idxdb_get_client_config(self.db_id(), key);
        let value: Option<SettingValueIdxdbObject> =
            await_js(promise, "failed to get client config value from idxdb").await?;
        let Some(value) = value else {
            return Ok(None);
        };
        Ok(Some(decode_unchecked(&value.value)?))
    }

    /// Writes a client value as a protobuf message.
    pub(crate) async fn set_client_setting<T: ProtobufValue>(
        &self,
        key: String,
        value: &T,
    ) -> Result<(), StoreError> {
        let promise = idxdb_insert_client_config(self.db_id(), key, encode(value));
        await_js_value(promise, "failed to set client config value").await?;
        Ok(())
    }

    async fn remove_client_setting(&self, key: String) -> Result<bool, StoreError> {
        let promise = idxdb_remove_client_config(self.db_id(), key);
        await_js(promise, "failed to delete client config value").await
    }

    pub(crate) async fn get_note_transport_cursors(
        &self,
    ) -> Result<BTreeMap<NoteTag, NoteTransportCursor>, StoreError> {
        self.get_client_setting(NOTE_TRANSPORT_CURSORS_KEY.into())
            .await
            .map(Option::unwrap_or_default)
    }

    pub(crate) async fn set_note_transport_cursors(
        &self,
        cursors: &BTreeMap<NoteTag, NoteTransportCursor>,
    ) -> Result<(), StoreError> {
        if cursors.is_empty() {
            self.remove_client_setting(NOTE_TRANSPORT_CURSORS_KEY.into()).await?;
            return Ok(());
        }
        self.set_client_setting(NOTE_TRANSPORT_CURSORS_KEY.into(), cursors).await
    }

    pub(crate) async fn get_protocol_config(
        &self,
        commitment: Word,
    ) -> Result<Option<ProtocolConfig>, StoreError> {
        self.get_client_setting(protocol_config_key(commitment)).await
    }

    pub(crate) async fn insert_protocol_config(
        &self,
        config: &ProtocolConfig,
    ) -> Result<(), StoreError> {
        self.set_client_setting(protocol_config_key(config.to_commitment()), config)
            .await
    }

    pub(crate) async fn get_rpc_limits(&self) -> Result<Option<RpcLimits>, StoreError> {
        self.get_client_setting(RPC_LIMITS_KEY.into()).await
    }

    pub(crate) async fn set_rpc_limits(&self, limits: RpcLimits) -> Result<(), StoreError> {
        self.set_client_setting(RPC_LIMITS_KEY.into(), &limits).await
    }

    pub(crate) async fn get_transaction_encryption_key(
        &self,
    ) -> Result<Option<TransactionEncryptionKey>, StoreError> {
        self.get_client_setting(TRANSACTION_ENCRYPTION_KEY_KEY.into()).await
    }

    pub(crate) async fn set_transaction_encryption_key(
        &self,
        key: &TransactionEncryptionKey,
    ) -> Result<(), StoreError> {
        self.set_client_setting(TRANSACTION_ENCRYPTION_KEY_KEY.into(), key).await
    }

    pub(crate) async fn remove_transaction_encryption_key(&self) -> Result<(), StoreError> {
        self.remove_client_setting(TRANSACTION_ENCRYPTION_KEY_KEY.into()).await?;
        Ok(())
    }
}
