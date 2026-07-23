use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::js_sys;

// FOREST IndexedDB Operations
#[wasm_bindgen(module = "/src/js/forest.js")]
extern "C" {
    /// Loads all lineage metadata rows and the revision singleton in one readonly transaction.
    #[wasm_bindgen(js_name = getForestSnapshot)]
    pub fn idxdb_get_forest_snapshot(db_id: String) -> js_sys::Promise;

    /// Loads the rows named by a prefetch plan in one readonly transaction.
    #[wasm_bindgen(js_name = getForestRows)]
    pub fn idxdb_get_forest_rows(db_id: String, request: JsValue) -> js_sys::Promise;
}

// INPUT TYPES
// ================================================================================================

/// One requested exact entry row.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestEntryRequest {
    pub lineage: String,
    pub key: String,
}

/// One requested complete leaf bucket.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestBucketRequest {
    pub lineage: String,
    pub leaf_position: String,
}

/// One requested subtree blob.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestSubtreeRequest {
    pub lineage: String,
    pub depth: u8,
    pub position: String,
}

/// The rows a forest operation needs, serialized for `getForestRows`.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestRowsRequest {
    pub entries: Vec<JsForestEntryRequest>,
    pub buckets: Vec<JsForestBucketRequest>,
    pub subtrees: Vec<JsForestSubtreeRequest>,
    pub full_lineages: Vec<String>,
}

// WRITE-BACK TYPES
// ================================================================================================
//
// The write-back payload rides along the account-write JS calls (`applyAccountPatch` and
// friends), so its types are exported wasm-bindgen structs like the other inputs of those
// calls.

/// Expected state of one lineage at write-back time. `version`, `root` and `entry_count` are
/// `None` when the lineage is expected to be absent (an addition).
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsForestExpectedTree {
    pub lineage: String,
    pub version: Option<String>,
    pub root: Option<String>,
    #[wasm_bindgen(js_name = "entryCount")]
    pub entry_count: Option<u32>,
}

/// One entry row to insert or replace.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsForestEntryWrite {
    pub lineage: String,
    pub key: String,
    pub value: String,
    #[wasm_bindgen(js_name = "leafPosition")]
    pub leaf_position: String,
}

/// One entry row to delete.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsForestEntryDelete {
    pub lineage: String,
    pub key: String,
}

/// One subtree blob to insert or replace. `blob` is base64.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsForestSubtreeWrite {
    pub lineage: String,
    pub depth: u8,
    pub position: String,
    pub blob: String,
}

/// One subtree blob to delete.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsForestSubtreeDelete {
    pub lineage: String,
    pub depth: u8,
    pub position: String,
}

/// One lineage metadata row to insert or replace.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsForestTreeWrite {
    pub lineage: String,
    pub version: String,
    pub root: String,
    #[wasm_bindgen(js_name = "entryCount")]
    pub entry_count: u32,
}

/// A complete forest write-back: expectations to validate plus the final row state to write,
/// all inside the same Dexie transaction as the account writes of the operation.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct JsForestUpdate {
    #[wasm_bindgen(js_name = "expectedTrees")]
    pub expected_trees: Vec<JsForestExpectedTree>,
    /// The revision the delta was computed at; the stored `nextVersion` must still equal it,
    /// and is advanced past it by the write-back.
    #[wasm_bindgen(js_name = "allocatedRevision")]
    pub allocated_revision: Option<String>,
    #[wasm_bindgen(js_name = "entryUpserts")]
    pub entry_upserts: Vec<JsForestEntryWrite>,
    #[wasm_bindgen(js_name = "entryDeletes")]
    pub entry_deletes: Vec<JsForestEntryDelete>,
    #[wasm_bindgen(js_name = "subtreeUpserts")]
    pub subtree_upserts: Vec<JsForestSubtreeWrite>,
    #[wasm_bindgen(js_name = "subtreeDeletes")]
    pub subtree_deletes: Vec<JsForestSubtreeDelete>,
    #[wasm_bindgen(js_name = "treeUpserts")]
    pub tree_upserts: Vec<JsForestTreeWrite>,
}
