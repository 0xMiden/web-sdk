use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::note::NoteTag;
use miden_client::note_transport::{NOTE_TRANSPORT_CURSORS_KEY, NoteTransportCursor};
use miden_client::protocol_config::{ProtocolConfig, protocol_config_setting_key};
use miden_client::rpc::RpcLimits;
use miden_client::rpc::encryption::TransactionEncryptionKey;
use miden_client::store::{SettingMutation, SettingScope, StoreError};
use miden_client_proto::{ProtobufValue, decode_unchecked, encode};

mod js_bindings;
mod models;

use js_bindings::{
    JsSettingMutation,
    idxdb_apply_settings_mutations,
    idxdb_get_setting,
    idxdb_insert_setting,
    idxdb_list_setting_keys,
    idxdb_remove_setting,
};

use crate::IdxdbStore;
use crate::promise::{await_js, await_js_value};
use crate::settings::models::SettingValueIdxdbObject;

// CLIENT SETTING KEYS
// ================================================================================================

const RPC_LIMITS_KEY: &str = "rpc_limits";
const TRANSACTION_ENCRYPTION_KEY_KEY: &str = "transaction_encryption_key";

impl IdxdbStore {
    pub(crate) async fn set_setting(
        &self,
        scope: SettingScope,
        key: String,
        value: Vec<u8>,
    ) -> Result<(), StoreError> {
        let promise = idxdb_insert_setting(self.db_id(), scope.as_u8(), key, value);
        await_js_value(promise, "failed to set setting value").await?;
        Ok(())
    }

    pub(crate) async fn get_setting(
        &self,
        scope: SettingScope,
        key: String,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let promise = idxdb_get_setting(self.db_id(), scope.as_u8(), key);
        let setting: Option<SettingValueIdxdbObject> =
            await_js(promise, "failed to get setting value from idxdb").await?;
        Ok(setting.map(|setting| setting.value))
    }

    pub(crate) async fn remove_setting(
        &self,
        scope: SettingScope,
        key: String,
    ) -> Result<bool, StoreError> {
        let promise = idxdb_remove_setting(self.db_id(), scope.as_u8(), key);
        let removed: bool = await_js(promise, "failed to delete setting value").await?;
        Ok(removed)
    }

    pub(crate) async fn list_setting_keys(
        &self,
        scope: SettingScope,
    ) -> Result<Vec<String>, StoreError> {
        let promise = idxdb_list_setting_keys(self.db_id(), scope.as_u8());
        let keys: Vec<String> = await_js(promise, "failed to list setting keys").await?;
        Ok(keys)
    }

    pub(crate) async fn apply_settings_mutations(
        &self,
        scope: SettingScope,
        mutations: Vec<SettingMutation>,
    ) -> Result<(), StoreError> {
        let mutations: Vec<JsSettingMutation> = mutations
            .into_iter()
            .map(|mutation| match mutation {
                SettingMutation::Set { key, value } => JsSettingMutation {
                    kind: "set".to_string(),
                    key,
                    value: Some(value),
                },
                SettingMutation::Remove { key } => JsSettingMutation {
                    kind: "remove".to_string(),
                    key,
                    value: None,
                },
            })
            .collect();

        let promise = idxdb_apply_settings_mutations(self.db_id(), scope.as_u8(), mutations);
        await_js_value(promise, "failed to apply settings mutations").await?;
        Ok(())
    }

    /// Reads a client setting that this store wrote as a protobuf message.
    pub(crate) async fn get_client_setting<T: ProtobufValue>(
        &self,
        key: String,
    ) -> Result<Option<T>, StoreError> {
        let Some(bytes) = self.get_setting(SettingScope::Client, key).await? else {
            return Ok(None);
        };
        Ok(Some(decode_unchecked(&bytes)?))
    }

    /// Writes a client setting as a protobuf message.
    pub(crate) async fn set_client_setting<T: ProtobufValue>(
        &self,
        key: String,
        value: &T,
    ) -> Result<(), StoreError> {
        self.set_setting(SettingScope::Client, key, encode(value)).await
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
            self.remove_setting(SettingScope::Client, NOTE_TRANSPORT_CURSORS_KEY.into())
                .await?;
            return Ok(());
        }
        self.set_client_setting(NOTE_TRANSPORT_CURSORS_KEY.into(), cursors).await
    }

    pub(crate) async fn get_protocol_config(
        &self,
        commitment: Word,
    ) -> Result<Option<ProtocolConfig>, StoreError> {
        self.get_client_setting(protocol_config_setting_key(commitment)).await
    }

    pub(crate) async fn insert_protocol_config(
        &self,
        config: &ProtocolConfig,
    ) -> Result<(), StoreError> {
        self.set_client_setting(protocol_config_setting_key(config.to_commitment()), config)
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
        self.remove_setting(SettingScope::Client, TRANSACTION_ENCRYPTION_KEY_KEY.into())
            .await?;
        Ok(())
    }
}
