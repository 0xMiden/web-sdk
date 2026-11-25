use alloc::string::String;
use alloc::vec::Vec;

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::js_sys;

// Code Registry IndexedDB Operations
#[wasm_bindgen(module = "/src/js/code.js")]
extern "C" {
    #[wasm_bindgen(js_name = getForestsWithDebugInfo)]
    pub fn idxdb_get_forests_with_debug_info(
        db_id: &str,
        commitments: Vec<String>,
    ) -> js_sys::Promise;

    #[wasm_bindgen(js_name = getProcedureRoots)]
    pub fn idxdb_get_procedure_roots(db_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_name = insertProceduresWithDebugInfo)]
    pub fn idxdb_insert_procedures_with_debug_info(
        db_id: &str,
        forests: JsValue,
    ) -> js_sys::Promise;

    #[wasm_bindgen(js_name = getProcedure)]
    pub fn idxdb_get_procedure(db_id: &str, procedure_root: String) -> js_sys::Promise;
}
