use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::store::{SettingMutation, StoreError};

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

impl IdxdbStore {
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

    pub(crate) async fn remove_setting(&self, key: String) -> Result<(), StoreError> {
        let promise = idxdb_remove_setting(self.db_id(), key);
        await_js_value(promise, "failed to delete setting value").await?;
        Ok(())
    }

    pub(crate) async fn list_setting_keys(&self) -> Result<Vec<String>, StoreError> {
        let promise = idxdb_list_setting_keys(self.db_id());
        let keys: Vec<String> = await_js(promise, "failed to list setting keys").await?;
        Ok(keys)
    }

    pub(crate) async fn apply_settings_mutations(
        &self,
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

        let promise = idxdb_apply_settings_mutations(self.db_id(), mutations);
        await_js_value(promise, "failed to apply settings mutations").await?;
        Ok(())
    }
}
