use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::js_sys;

// Transactions IndexedDB Operations
#[wasm_bindgen(module = "/src/js/transactions.js")]

extern "C" {
    // GETS
    // ================================================================================================

    #[wasm_bindgen(js_name = getTransactions)]
    pub fn idxdb_get_transactions(db_id: &str, filter: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = getTransactionLogs)]
    pub fn idxdb_get_transaction_logs(db_id: &str, transaction_id: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = applyTransactionBatch)]
    pub fn idxdb_apply_transaction_batch(db_id: &str, payloads: JsValue) -> js_sys::Promise;
}
