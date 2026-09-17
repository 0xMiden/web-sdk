use alloc::string::String;
use alloc::vec::Vec;

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::js_sys;

// Settings IndexedDB Operations
#[wasm_bindgen(module = "/src/js/settings.js")]
extern "C" {
    #[wasm_bindgen(js_name = getSetting)]
    pub fn idxdb_get_setting(db_id: &str, scope: u8, key: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = insertSetting)]
    pub fn idxdb_insert_setting(
        db_id: &str,
        scope: u8,
        key: String,
        value: Vec<u8>,
    ) -> js_sys::Promise;

    #[wasm_bindgen(js_name = removeSetting)]
    pub fn idxdb_remove_setting(db_id: &str, scope: u8, key: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = listSettingKeys)]
    pub fn idxdb_list_setting_keys(db_id: &str, scope: u8) -> js_sys::Promise;

    #[wasm_bindgen(js_name = applySettingsMutations)]
    pub fn idxdb_apply_settings_mutations(
        db_id: &str,
        scope: u8,
        mutations: Vec<JsSettingMutation>,
    ) -> js_sys::Promise;
}

/// JS-facing form of a [`miden_client::store::SettingMutation`], applied as a
/// single atomic batch by the `applySettingsMutations` function in
/// `settings.js`.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsSettingMutation {
    /// Either `"set"` or `"remove"`.
    pub kind: String,

    /// The `settings` key the mutation targets.
    pub key: String,

    /// The value to write. `Some` for `"set"`, `None` for `"remove"`.
    pub value: Option<Vec<u8>>,
}
