use alloc::string::String;
use alloc::vec::Vec;

use serde::Deserialize;

/// All lineage metadata rows plus the revision singleton, from `getForestSnapshot`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestSnapshot {
    pub trees: Vec<JsForestTreeRow>,
    /// `nextVersion` of the revision singleton (16-char lowercase hex u64).
    pub next_version: String,
}

/// One lineage metadata row.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestTreeRow {
    pub lineage: String,
    pub version: String,
    pub root: String,
    pub entry_count: u32,
}

/// One requested exact entry row; `value`/`leafPosition` are absent when no row exists.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestEntryRowResponse {
    pub lineage: String,
    pub key: String,
    pub value: Option<String>,
    pub leaf_position: Option<String>,
}

/// One key-value pair of a loaded leaf bucket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestKv {
    pub key: String,
    pub value: String,
}

/// One requested complete leaf bucket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestBucketResponse {
    pub lineage: String,
    pub leaf_position: String,
    pub entries: Vec<JsForestKv>,
}

/// One requested subtree blob; `blob` (base64) is absent when no row exists.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestSubtreeResponse {
    pub lineage: String,
    pub depth: u8,
    pub position: String,
    pub blob: Option<String>,
}

/// The complete entry set of one bulk-loaded lineage.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestFullLineageResponse {
    pub lineage: String,
    pub rows: Vec<JsForestFullEntryRow>,
}

/// One entry row of a bulk-loaded lineage.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestFullEntryRow {
    pub key: String,
    pub value: String,
    pub leaf_position: String,
}

/// Everything `getForestRows` loaded for a prefetch plan.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsForestRowsResponse {
    pub entries: Vec<JsForestEntryRowResponse>,
    pub buckets: Vec<JsForestBucketResponse>,
    pub subtrees: Vec<JsForestSubtreeResponse>,
    pub full_lineages: Vec<JsForestFullLineageResponse>,
}
