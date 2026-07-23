//! `IndexedDB` persistence for the account SMT forest.
//!
//! The forest [`Backend`] contract is synchronous while `IndexedDB` is asynchronous, so a store
//! operation runs in three phases:
//!
//! 1. The rows the operation will read are enumerated ([`plan`]) and loaded asynchronously into a
//!    strict [`ForestRowCache`](cache::ForestRowCache).
//! 2. The shared row backend (`miden_client::store::forest_backend`) runs synchronously against the
//!    cache; writes are recorded, not persisted.
//! 3. The recorded delta is serialized ([`forest_update_payload`]) and written back inside the same
//!    Dexie transaction as the operation's account writes, which re-validates every touched lineage
//!    and the revision counter first (optimistic concurrency).
//!
//! [`Backend`]: miden_protocol::crypto::merkle::smt::Backend

use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use base64::Engine;
use base64::engine::general_purpose;
use miden_client::Word;
use miden_client::store::StoreError;
use miden_client::store::forest_backend::{
    ForestEntryRow,
    ForestPrefetchPlan,
    ForestTreeMeta,
    LineageId,
    RowForestBackend,
    VersionId,
};

use crate::promise::await_js;

pub(crate) mod cache;
pub(crate) mod js_bindings;
pub(crate) mod models;

use cache::{ForestDirtyDelta, ForestRowCache, ForestRowWrite};
use js_bindings::{
    JsForestBucketRequest,
    JsForestEntryDelete,
    JsForestEntryWrite,
    JsForestExpectedTree,
    JsForestRowsRequest,
    JsForestSubtreeDelete,
    JsForestSubtreeRequest,
    JsForestSubtreeWrite,
    JsForestTreeWrite,
    JsForestUpdate,
    idxdb_get_forest_rows,
    idxdb_get_forest_snapshot,
};
use models::{JsForestRowsResponse, JsForestSnapshot};

/// An account SMT forest over the prefetched row cache.
pub(crate) type CachedAccountForest =
    miden_client::store::AccountSmtForest<RowForestBackend<ForestRowCache>>;

// HEX ENCODING
// ================================================================================================
//
// Compound-key components are fixed-width lowercase hex so IndexedDB string ordering matches
// numeric ordering: lineages are 64 chars, u64 values 16 chars, and words use their canonical
// `to_hex` form (constant width including the 0x prefix).

pub(crate) fn lineage_to_hex(lineage: LineageId) -> String {
    hex::encode(lineage.as_bytes())
}

pub(crate) fn lineage_from_hex(hex_str: &str) -> Result<LineageId, StoreError> {
    let bytes = hex::decode(hex_str)
        .map_err(|e| StoreError::DatabaseError(format!("malformed lineage hex: {e}")))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| StoreError::DatabaseError("lineage hex has wrong length".to_string()))?;
    Ok(LineageId::new(bytes))
}

pub(crate) fn u64_to_hex(value: u64) -> String {
    format!("{value:016x}")
}

pub(crate) fn u64_from_hex(hex_str: &str) -> Result<u64, StoreError> {
    u64::from_str_radix(hex_str, 16)
        .map_err(|e| StoreError::DatabaseError(format!("malformed u64 hex: {e}")))
}

/// Maps forest backend errors onto [`StoreError`].
///
/// Takes the error by value so it can be used directly with `map_err`.
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn backend_error(e: miden_client::store::forest_backend::BackendError) -> StoreError {
    StoreError::DatabaseError(format!("forest backend error: {e}"))
}

// OPTIMISTIC CONCURRENCY
// ================================================================================================

/// Message marker of the typed JS `ForestConflictError`, thrown when optimistic-concurrency
/// validation fails (row prefetch against a moved revision, write-back CAS, or a stale undo
/// plan). The JS error's message starts with this marker so it survives the wasm boundary,
/// where only the stringified error is available.
const FOREST_CONFLICT_MARKER: &str = "ForestConflictError";

/// Maximum attempts for a store operation whose forest phase hits optimistic-concurrency
/// conflicts before the conflict is surfaced to the caller.
pub(crate) const MAX_FOREST_ATTEMPTS: usize = 3;

/// Whether the error is a forest optimistic-concurrency conflict, which a fresh attempt (new
/// snapshot, new prefetch, new write-back) can resolve.
pub(crate) fn is_forest_conflict(err: &StoreError) -> bool {
    matches!(err, StoreError::DatabaseError(msg) if msg.contains(FOREST_CONFLICT_MARKER))
}

/// Whether an operation that compares account-table roots against the forest straddled a
/// concurrent commit and should be retried.
///
/// Besides explicit prefetch/write-back conflicts, account rows and the forest snapshot are
/// read in separate transactions, so a commit between them surfaces as conflicting roots; a
/// fresh attempt reads both again. A genuinely diverged store keeps failing and surfaces the
/// same error once the attempts are exhausted.
pub(crate) fn is_retryable_conflict(err: &StoreError) -> bool {
    use miden_client::crypto::MerkleError;
    is_forest_conflict(err)
        || matches!(err, StoreError::MerkleStoreError(MerkleError::ConflictingRoots { .. }))
}

fn word_from_hex(hex_str: &str) -> Result<Word, StoreError> {
    Word::try_from(hex_str)
        .map_err(|e| StoreError::DatabaseError(format!("malformed word hex: {e}")))
}

// SNAPSHOT AND PREFETCH
// ================================================================================================

/// The lineage metadata snapshot plus the next revision to allocate.
pub(crate) struct ForestSnapshot {
    pub trees: BTreeMap<LineageId, ForestTreeMeta>,
    pub next_revision: VersionId,
}

/// Loads all lineage metadata rows and the revision singleton.
pub(crate) async fn load_forest_snapshot(db_id: &str) -> Result<ForestSnapshot, StoreError> {
    let snapshot: JsForestSnapshot = await_js(
        idxdb_get_forest_snapshot(db_id.to_string()),
        "failed to load the forest snapshot",
    )
    .await?;

    let mut trees = BTreeMap::new();
    for row in snapshot.trees {
        let lineage = lineage_from_hex(&row.lineage)?;
        trees.insert(
            lineage,
            ForestTreeMeta {
                version: u64_from_hex(&row.version)?,
                root: word_from_hex(&row.root)?,
                entry_count: row.entry_count as usize,
            },
        );
    }
    Ok(ForestSnapshot {
        trees,
        next_revision: u64_from_hex(&snapshot.next_version)?,
    })
}

/// Loads the rows named by `plan` into `cache`.
///
/// `expected_revision` is the revision the operation's snapshot was taken at; the row read
/// fails with a conflict if a commit advanced the counter since, so the cache never mixes rows
/// from different forest states.
pub(crate) async fn prefetch_rows(
    db_id: &str,
    plan: &ForestPrefetchPlan,
    cache: &ForestRowCache,
    expected_revision: VersionId,
) -> Result<(), StoreError> {
    if plan.is_empty() {
        return Ok(());
    }

    let request = JsForestRowsRequest {
        entries: Vec::new(),
        expected_revision: Some(u64_to_hex(expected_revision)),
        buckets: plan
            .buckets
            .iter()
            .map(|(lineage, position)| JsForestBucketRequest {
                lineage: lineage_to_hex(*lineage),
                leaf_position: u64_to_hex(*position),
            })
            .collect(),
        subtrees: plan
            .subtrees
            .iter()
            .map(|(lineage, depth, position)| JsForestSubtreeRequest {
                lineage: lineage_to_hex(*lineage),
                depth: *depth,
                position: u64_to_hex(*position),
            })
            .collect(),
        full_lineages: plan.full_lineages.iter().map(|l| lineage_to_hex(*l)).collect(),
    };
    let request = serde_wasm_bindgen::to_value(&request)
        .map_err(|e| StoreError::DatabaseError(format!("failed to serialize prefetch: {e}")))?;

    let response: JsForestRowsResponse =
        await_js(idxdb_get_forest_rows(db_id.to_string(), request), "failed to load forest rows")
            .await?;

    for row in response.entries {
        let lineage = lineage_from_hex(&row.lineage)?;
        let key = word_from_hex(&row.key)?;
        let loaded = match (row.value, row.leaf_position) {
            (Some(value), Some(position)) => {
                Some((word_from_hex(&value)?, u64_from_hex(&position)?))
            },
            _ => None,
        };
        cache.load_entry(lineage, key, loaded);
    }
    for bucket in response.buckets {
        let lineage = lineage_from_hex(&bucket.lineage)?;
        let position = u64_from_hex(&bucket.leaf_position)?;
        let mut entries = Vec::with_capacity(bucket.entries.len());
        for kv in bucket.entries {
            entries.push((word_from_hex(&kv.key)?, word_from_hex(&kv.value)?));
        }
        cache.load_bucket(lineage, position, entries);
    }
    for subtree in response.subtrees {
        let lineage = lineage_from_hex(&subtree.lineage)?;
        let position = u64_from_hex(&subtree.position)?;
        let blob = subtree
            .blob
            .map(|b| {
                general_purpose::STANDARD.decode(&b).map_err(|e| {
                    StoreError::DatabaseError(format!("malformed subtree base64: {e}"))
                })
            })
            .transpose()?;
        cache.load_subtree(lineage, subtree.depth, position, blob);
    }
    for full in response.full_lineages {
        let lineage = lineage_from_hex(&full.lineage)?;
        let mut rows = Vec::with_capacity(full.rows.len());
        for row in full.rows {
            rows.push(ForestEntryRow {
                key: word_from_hex(&row.key)?,
                value: word_from_hex(&row.value)?,
                leaf_position: u64_from_hex(&row.leaf_position)?,
            });
        }
        cache.load_all_entries(lineage, rows);
    }
    Ok(())
}

// WRITE-BACK PAYLOAD
// ================================================================================================

/// Converts an entry count to the u32 the tree rows store, rejecting values that do not fit
/// (persisting a clamped count would corrupt the lineage's metadata).
fn entry_count_to_u32(count: usize) -> Result<u32, StoreError> {
    u32::try_from(count).map_err(|_| {
        StoreError::DatabaseError(format!("forest lineage entry count {count} exceeds u32"))
    })
}

/// Converts a recorded delta into the JS write-back payload.
///
/// Writes are coalesced to their final per-row state (the last write to a row key wins), so the
/// JS side applies each row at most once and ordering inside the payload carries no meaning.
pub(crate) fn forest_update_payload(delta: ForestDirtyDelta) -> Result<JsForestUpdate, StoreError> {
    let mut entry_writes: BTreeMap<(LineageId, Word), Option<(Word, u64)>> = BTreeMap::new();
    let mut subtree_writes: BTreeMap<(LineageId, u8, u64), Option<Vec<u8>>> = BTreeMap::new();
    let mut tree_writes: BTreeMap<LineageId, ForestTreeMeta> = BTreeMap::new();

    for write in delta.writes {
        match write {
            ForestRowWrite::UpsertEntry { lineage, key, value, leaf_position } => {
                entry_writes.insert((lineage, key), Some((value, leaf_position)));
            },
            ForestRowWrite::DeleteEntry { lineage, key } => {
                entry_writes.insert((lineage, key), None);
            },
            ForestRowWrite::UpsertSubtree { lineage, depth, position, blob } => {
                subtree_writes.insert((lineage, depth, position), Some(blob));
            },
            ForestRowWrite::DeleteSubtree { lineage, depth, position } => {
                subtree_writes.insert((lineage, depth, position), None);
            },
            ForestRowWrite::UpsertTreeMeta { lineage, meta } => {
                tree_writes.insert(lineage, meta);
            },
        }
    }

    let mut expected_trees = Vec::with_capacity(delta.expected_trees.len());
    for (lineage, meta) in delta.expected_trees {
        expected_trees.push(JsForestExpectedTree {
            lineage: lineage_to_hex(lineage),
            version: meta.map(|m| u64_to_hex(m.version)),
            root: meta.map(|m| m.root.to_hex()),
            entry_count: meta.map(|m| entry_count_to_u32(m.entry_count)).transpose()?,
        });
    }

    let mut update = JsForestUpdate {
        expected_trees,
        allocated_revision: delta.allocated_revision.map(u64_to_hex),
        entry_upserts: Vec::new(),
        entry_deletes: Vec::new(),
        subtree_upserts: Vec::new(),
        subtree_deletes: Vec::new(),
        tree_upserts: Vec::new(),
    };

    for ((lineage, key), write) in entry_writes {
        match write {
            Some((value, leaf_position)) => update.entry_upserts.push(JsForestEntryWrite {
                lineage: lineage_to_hex(lineage),
                key: key.to_hex(),
                value: value.to_hex(),
                leaf_position: u64_to_hex(leaf_position),
            }),
            None => update.entry_deletes.push(JsForestEntryDelete {
                lineage: lineage_to_hex(lineage),
                key: key.to_hex(),
            }),
        }
    }
    for ((lineage, depth, position), write) in subtree_writes {
        match write {
            Some(blob) => update.subtree_upserts.push(JsForestSubtreeWrite {
                lineage: lineage_to_hex(lineage),
                depth,
                position: u64_to_hex(position),
                blob: general_purpose::STANDARD.encode(blob),
            }),
            None => update.subtree_deletes.push(JsForestSubtreeDelete {
                lineage: lineage_to_hex(lineage),
                depth,
                position: u64_to_hex(position),
            }),
        }
    }
    for (lineage, meta) in tree_writes {
        update.tree_upserts.push(JsForestTreeWrite {
            lineage: lineage_to_hex(lineage),
            version: u64_to_hex(meta.version),
            root: meta.root.to_hex(),
            entry_count: entry_count_to_u32(meta.entry_count)?,
        });
    }

    Ok(update)
}

// FOREST CONSTRUCTION
// ================================================================================================

/// Builds an operation-local forest over a prefetched cache.
///
/// `mutating` operations record the snapshot's next revision so the write-back can validate and
/// advance the counter; read-only operations skip it.
pub(crate) async fn forest_for_plan(
    db_id: &str,
    snapshot: ForestSnapshot,
    plan: &ForestPrefetchPlan,
    mutating: bool,
) -> Result<(CachedAccountForest, ForestRowCache), StoreError> {
    let expected_revision = snapshot.next_revision;
    let allocated_revision = mutating.then_some(snapshot.next_revision);
    let cache = ForestRowCache::new(snapshot.trees, allocated_revision);
    prefetch_rows(db_id, plan, &cache, expected_revision).await?;
    let forest = CachedAccountForest::new(RowForestBackend::new(cache.clone()))?;
    Ok((forest, cache))
}

// ACCOUNT RECONCILIATION
// ================================================================================================

/// Returns the forest target state of an account: the vault's key-value pairs and one target
/// per storage-map slot, all keyed by hashed SMT key.
pub(crate) fn account_forest_targets(
    vault: &miden_client::asset::AssetVault,
    storage: &miden_client::account::AccountStorage,
) -> (
    BTreeMap<Word, Word>,
    BTreeMap<miden_client::account::StorageSlotName, BTreeMap<Word, Word>>,
) {
    let vault_target = vault
        .assets()
        .map(|asset| (asset.id().hash().into(), asset.to_value_word()))
        .collect();

    let mut map_targets: BTreeMap<miden_client::account::StorageSlotName, BTreeMap<Word, Word>> =
        BTreeMap::new();
    for slot in storage.slots() {
        if let miden_client::account::StorageSlotContent::Map(map) = slot.content() {
            map_targets.insert(
                slot.name().clone(),
                map.entries().map(|(key, value)| (Word::from(key.hash()), *value)).collect(),
            );
        }
    }
    (vault_target, map_targets)
}

/// Adds operations that make `lineage` match `target`: stored keys not in the target are
/// removed and all target pairs are upserted (unchanged pairs become no-ops during compute).
///
/// The lineage's stored keys are read through `rows`, so the cache must hold the lineage's
/// complete entry set (or know the lineage is absent).
pub(crate) fn add_reconcile_ops(
    rows: &ForestRowCache,
    batch: &mut miden_client::store::forest_backend::SmtForestUpdateBatch,
    lineage: LineageId,
    target: &BTreeMap<Word, Word>,
) -> Result<(), StoreError> {
    use miden_client::store::forest_backend::ForestRowStore;

    let mut stored_keys = Vec::new();
    rows.for_each_entry(lineage, &mut |row| {
        stored_keys.push(row.key);
        Ok(())
    })
    .map_err(backend_error)?;

    for key in stored_keys {
        if !target.contains_key(&key) {
            batch.operations(lineage).add_remove(key);
        }
    }
    let ops = batch.operations(lineage);
    for (key, value) in target {
        ops.add_insert(*key, *value);
    }
    Ok(())
}
