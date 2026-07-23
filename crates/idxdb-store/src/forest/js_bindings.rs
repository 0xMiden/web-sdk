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
    /// The revision the operation's snapshot was taken at. The read transaction fails with a
    /// conflict when the stored counter no longer matches, so rows from a later commit cannot
    /// be mixed with the older snapshot.
    pub expected_revision: Option<String>,
}

// WRITE-BACK TYPES
// ================================================================================================
//
// The write-back payload rides along the account-write JS calls (`applyAccountPatch` and
// friends) as ONE plain JS object, serialized in a single `serde_wasm_bindgen` pass
// ([`JsForestUpdate::into_js`]). Bulk operations carry tens of thousands of rows, so the
// payload must cross the wasm boundary once as own-property objects; per-row wasm-bindgen
// classes would re-enter wasm for every field read and re-materialize whole vectors on every
// property access.

/// Expected state of one lineage at write-back time. `version`, `root` and `entry_count` are
/// `None` when the lineage is expected to be absent (an addition).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestExpectedTree {
    pub lineage: String,
    pub version: Option<String>,
    pub root: Option<String>,
    pub entry_count: Option<u32>,
}

/// One entry row to insert or replace.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestEntryWrite {
    pub lineage: String,
    pub key: String,
    pub value: String,
    pub leaf_position: String,
}

/// One entry row to delete.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestEntryDelete {
    pub lineage: String,
    pub key: String,
}

/// One subtree blob to insert or replace. `blob` crosses the boundary as a `Uint8Array`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestSubtreeWrite {
    pub lineage: String,
    pub depth: u8,
    pub position: String,
    pub blob: serde_bytes::ByteBuf,
}

/// One subtree blob to delete.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestSubtreeDelete {
    pub lineage: String,
    pub depth: u8,
    pub position: String,
}

/// One lineage metadata row to insert or replace.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestTreeWrite {
    pub lineage: String,
    pub version: String,
    pub root: String,
    pub entry_count: u32,
}

/// A complete forest write-back: expectations to validate plus the final row state to write,
/// all inside the same Dexie transaction as the account writes of the operation.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestUpdate {
    pub expected_trees: Vec<JsForestExpectedTree>,
    /// The revision the delta was computed at; the stored `nextVersion` must still equal it,
    /// and is advanced past it by the write-back.
    pub allocated_revision: Option<String>,
    pub entry_upserts: Vec<JsForestEntryWrite>,
    pub entry_deletes: Vec<JsForestEntryDelete>,
    pub subtree_upserts: Vec<JsForestSubtreeWrite>,
    pub subtree_deletes: Vec<JsForestSubtreeDelete>,
    pub tree_upserts: Vec<JsForestTreeWrite>,
}

impl JsForestUpdate {
    /// Serializes the whole update into one plain JS object.
    pub fn into_js(self) -> Result<JsValue, serde_wasm_bindgen::Error> {
        serde_wasm_bindgen::to_value(&self)
    }
}
