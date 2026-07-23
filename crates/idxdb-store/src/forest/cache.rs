//! Strict prefetched row cache backing the account SMT forest.
//!
//! `IndexedDB` is asynchronous, while the forest [`Backend`] contract is synchronous, so a store
//! operation runs in three phases: rows are prefetched asynchronously into a [`ForestRowCache`],
//! the forest computation runs synchronously against the cache, and the recorded
//! [`ForestDirtyDelta`] is written back asynchronously inside the operation's Dexie transaction.
//!
//! The cache is strict. It distinguishes rows that were prefetched and found absent (valid empty
//! state) from rows that were never prefetched, and fails reads of the latter with
//! [`BackendError::Internal`] instead of reporting them as absent, because an absent row is
//! meaningful to the Merkle computation and a silent miss would yield an incorrect tree.
//!
//! [`Backend`]: miden_client::store::forest_backend
//!
//! Writes go through the cache (so later reads within the same operation observe them) and are
//! recorded in the dirty delta in arrival order.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::RefCell;
use core::fmt;

use miden_client::Word;
use miden_client::store::forest_backend::{
    BackendError,
    ForestEntryRow,
    ForestRowStore,
    ForestTreeMeta,
    LineageId,
    TreeWithRoot,
    VersionId,
};

type Result<T> = core::result::Result<T, BackendError>;

// ERRORS
// ================================================================================================

/// Error message marker for reads the prefetch did not cover.
///
/// Reaching it means the prefetch planner and the forest computation disagree about the required
/// row set, which is a bug in the planner rather than corrupted data.
const NOT_PREFETCHED: &str = "forest row cache miss";

fn not_prefetched(what: impl fmt::Display) -> BackendError {
    BackendError::Internal(format!("{NOT_PREFETCHED}: {what}").into())
}

// DIRTY DELTA
// ================================================================================================

/// One recorded row write, in arrival order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ForestRowWrite {
    UpsertEntry {
        lineage: LineageId,
        key: Word,
        value: Word,
        leaf_position: u64,
    },
    DeleteEntry {
        lineage: LineageId,
        key: Word,
    },
    UpsertSubtree {
        lineage: LineageId,
        depth: u8,
        position: u64,
        blob: Vec<u8>,
    },
    DeleteSubtree {
        lineage: LineageId,
        depth: u8,
        position: u64,
    },
    UpsertTreeMeta {
        lineage: LineageId,
        meta: ForestTreeMeta,
    },
}

/// The writes recorded by a forest operation, plus the state they were computed against.
///
/// The expectations are validated inside the write-back transaction before any row is written
/// (optimistic concurrency): every touched existing lineage must still have its expected
/// metadata, every added lineage must still be absent, and the global revision counter must be
/// unchanged.
#[derive(Debug, Default)]
pub(crate) struct ForestDirtyDelta {
    /// Expected metadata of every lineage read or written by the operation.
    pub expected_trees: BTreeMap<LineageId, Option<ForestTreeMeta>>,
    /// The revision the operation allocated; the stored `next_version` must still equal it.
    pub allocated_revision: Option<VersionId>,
    /// Row writes in arrival order.
    pub writes: Vec<ForestRowWrite>,
}

// ROW CACHE
// ================================================================================================

/// A loaded row that is either present or known absent. Unprefetched rows are simply missing
/// from the map they would live in.
#[derive(Debug, Clone)]
enum Loaded<T> {
    Absent,
    Present(T),
}

#[derive(Debug, Default)]
struct CacheInner {
    /// Complete snapshot of all lineage metadata rows, loaded at cache construction.
    trees: BTreeMap<LineageId, ForestTreeMeta>,
    /// Lineages present in the snapshot at construction. A lineage absent from the complete
    /// snapshot is authoritatively absent, so every row of such a lineage can be answered as
    /// absent without prefetching (additions read their new lineage's rows during apply).
    initial_lineages: BTreeSet<LineageId>,
    /// The next revision value read at prefetch time, if the operation intends to mutate.
    allocated_revision: Option<VersionId>,
    /// Exact entry rows: value and stored leaf position.
    entries: BTreeMap<(LineageId, Word), Loaded<(Word, u64)>>,
    /// Complete leaf buckets: every entry stored at (lineage, position). An empty vector is a
    /// loaded-and-empty bucket.
    buckets: BTreeMap<(LineageId, u64), Vec<(Word, Word)>>,
    /// Subtree blobs.
    subtrees: BTreeMap<(LineageId, u8, u64), Loaded<Vec<u8>>>,
    /// Lineages whose full entry set is loaded; their buckets and exact entries can be answered
    /// from `full_entries` without individual records.
    full_coverage: BTreeSet<LineageId>,
    /// All entries of fully covered lineages.
    full_entries: BTreeMap<LineageId, Vec<ForestEntryRow>>,
    /// Expected metadata captured for CAS, including known-absent lineages.
    expected_trees: BTreeMap<LineageId, Option<ForestTreeMeta>>,
    /// Row writes in arrival order.
    writes: Vec<ForestRowWrite>,
}

/// Strict prefetched row cache. Cheap to clone; clones share state, which the reader view
/// returned by the shared backend relies on.
#[derive(Clone, Default)]
pub(crate) struct ForestRowCache(Rc<RefCell<CacheInner>>);

impl fmt::Debug for ForestRowCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ForestRowCache").finish_non_exhaustive()
    }
}

impl ForestRowCache {
    /// Creates a cache over the complete lineage metadata snapshot.
    ///
    /// `allocated_revision` is the revision a mutating operation will apply its updates at
    /// (`None` for read-only operations).
    pub(crate) fn new(
        trees: impl IntoIterator<Item = (LineageId, ForestTreeMeta)>,
        allocated_revision: Option<VersionId>,
    ) -> Self {
        let trees: BTreeMap<_, _> = trees.into_iter().collect();
        let initial_lineages = trees.keys().copied().collect();
        let expected_trees = trees.iter().map(|(l, m)| (*l, Some(*m))).collect();
        Self(Rc::new(RefCell::new(CacheInner {
            trees,
            initial_lineages,
            allocated_revision,
            expected_trees,
            ..CacheInner::default()
        })))
    }

    // PREFETCH LOADERS
    // --------------------------------------------------------------------------------------------

    /// Records the exact entry row for `key`, or its absence.
    pub(crate) fn load_entry(&self, lineage: LineageId, key: Word, row: Option<(Word, u64)>) {
        let loaded = match row {
            Some(row) => Loaded::Present(row),
            None => Loaded::Absent,
        };
        self.0.borrow_mut().entries.insert((lineage, key), loaded);
    }

    /// Records the complete leaf bucket at (`lineage`, `position`).
    pub(crate) fn load_bucket(
        &self,
        lineage: LineageId,
        position: u64,
        entries: Vec<(Word, Word)>,
    ) {
        self.0.borrow_mut().buckets.insert((lineage, position), entries);
    }

    /// Records the subtree blob at (`lineage`, `depth`, `position`), or its absence.
    pub(crate) fn load_subtree(
        &self,
        lineage: LineageId,
        depth: u8,
        position: u64,
        blob: Option<Vec<u8>>,
    ) {
        let loaded = match blob {
            Some(blob) => Loaded::Present(blob),
            None => Loaded::Absent,
        };
        self.0.borrow_mut().subtrees.insert((lineage, depth, position), loaded);
    }

    /// Records the complete entry set of a lineage, marking it fully covered.
    pub(crate) fn load_all_entries(&self, lineage: LineageId, rows: Vec<ForestEntryRow>) {
        let mut inner = self.0.borrow_mut();
        inner.full_entries.insert(lineage, rows);
        inner.full_coverage.insert(lineage);
    }

    // DELTA EXTRACTION
    // --------------------------------------------------------------------------------------------

    /// Extracts the recorded writes and expectations for asynchronous write-back.
    pub(crate) fn into_dirty_delta(self) -> ForestDirtyDelta {
        let inner = Rc::try_unwrap(self.0)
            .expect("all forest clones are dropped before delta extraction")
            .into_inner();
        ForestDirtyDelta {
            expected_trees: inner.expected_trees,
            allocated_revision: inner.allocated_revision,
            writes: inner.writes,
        }
    }

    // INTERNAL VIEWS
    // --------------------------------------------------------------------------------------------

    /// Marks a lineage's expectation. Lineages first observed as absent (additions) must still
    /// be absent at write-back.
    fn note_expected_absent(inner: &mut CacheInner, lineage: LineageId) {
        inner.expected_trees.entry(lineage).or_insert(None);
    }
}

impl ForestRowStore for ForestRowCache {
    fn tree_meta(&self, lineage: LineageId) -> Result<Option<ForestTreeMeta>> {
        let mut inner = self.0.borrow_mut();
        let meta = inner.trees.get(&lineage).copied();
        if meta.is_none() {
            Self::note_expected_absent(&mut inner, lineage);
        }
        Ok(meta)
    }

    fn trees(&self) -> Result<Vec<TreeWithRoot>> {
        Ok(self
            .0
            .borrow()
            .trees
            .iter()
            .map(|(lineage, meta)| TreeWithRoot::new(*lineage, meta.version, meta.root))
            .collect())
    }

    fn entry_value(&self, lineage: LineageId, key: Word) -> Result<Option<Word>> {
        let inner = self.0.borrow();
        if let Some(loaded) = inner.entries.get(&(lineage, key)) {
            return Ok(match loaded {
                Loaded::Present((value, _)) => Some(*value),
                Loaded::Absent => None,
            });
        }
        if inner.full_coverage.contains(&lineage) {
            let rows = inner.full_entries.get(&lineage).expect("covered lineage has entries");
            return Ok(rows.iter().find(|row| row.key == key).map(|row| row.value));
        }
        if !inner.initial_lineages.contains(&lineage) {
            return Ok(None);
        }
        Err(not_prefetched(format!("entry {key} of lineage {lineage}")))
    }

    fn leaf_entries(&self, lineage: LineageId, position: u64) -> Result<Vec<(Word, Word)>> {
        let inner = self.0.borrow();
        if let Some(bucket) = inner.buckets.get(&(lineage, position)) {
            return Ok(bucket.clone());
        }
        if inner.full_coverage.contains(&lineage) {
            let rows = inner.full_entries.get(&lineage).expect("covered lineage has entries");
            return Ok(rows
                .iter()
                .filter(|row| row.leaf_position == position)
                .map(|row| (row.key, row.value))
                .collect());
        }
        if !inner.initial_lineages.contains(&lineage) {
            return Ok(Vec::new());
        }
        Err(not_prefetched(format!("leaf bucket {position} of lineage {lineage}")))
    }

    fn for_each_entry(
        &self,
        lineage: LineageId,
        f: &mut dyn FnMut(ForestEntryRow) -> Result<()>,
    ) -> Result<()> {
        let rows = {
            let inner = self.0.borrow();
            if inner.full_coverage.contains(&lineage) {
                inner.full_entries.get(&lineage).expect("covered lineage has entries").clone()
            } else if !inner.initial_lineages.contains(&lineage) {
                Vec::new()
            } else {
                return Err(not_prefetched(format!("full entry set of lineage {lineage}")));
            }
        };
        for row in rows {
            f(row)?;
        }
        Ok(())
    }

    fn subtree_blob(
        &self,
        lineage: LineageId,
        depth: u8,
        position: u64,
    ) -> Result<Option<Vec<u8>>> {
        let inner = self.0.borrow();
        match inner.subtrees.get(&(lineage, depth, position)) {
            Some(Loaded::Present(blob)) => Ok(Some(blob.clone())),
            Some(Loaded::Absent) => Ok(None),
            None if !inner.initial_lineages.contains(&lineage) => Ok(None),
            None => Err(not_prefetched(format!(
                "subtree at depth {depth} position {position} of lineage {lineage}"
            ))),
        }
    }

    fn upsert_entry(
        &mut self,
        lineage: LineageId,
        key: Word,
        value: Word,
        leaf_position: u64,
    ) -> Result<()> {
        let mut inner = self.0.borrow_mut();
        inner.entries.insert((lineage, key), Loaded::Present((value, leaf_position)));
        if let Some(bucket) = inner.buckets.get_mut(&(lineage, leaf_position)) {
            match bucket.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = value,
                None => bucket.push((key, value)),
            }
        }
        if inner.full_coverage.contains(&lineage) {
            let rows = inner.full_entries.get_mut(&lineage).expect("covered lineage has entries");
            match rows.iter_mut().find(|row| row.key == key) {
                Some(row) => row.value = value,
                None => rows.push(ForestEntryRow { key, value, leaf_position }),
            }
        }
        inner
            .writes
            .push(ForestRowWrite::UpsertEntry { lineage, key, value, leaf_position });
        Ok(())
    }

    fn delete_entry(&mut self, lineage: LineageId, key: Word) -> Result<()> {
        let mut inner = self.0.borrow_mut();
        let previous = inner.entries.insert((lineage, key), Loaded::Absent);
        let leaf_position = match previous {
            Some(Loaded::Present((_, position))) => Some(position),
            _ => None,
        };
        if let Some(position) = leaf_position {
            if let Some(bucket) = inner.buckets.get_mut(&(lineage, position)) {
                bucket.retain(|(k, _)| *k != key);
            }
        } else {
            // Without the stored position, fall back to scanning loaded buckets of the lineage.
            for ((l, _), bucket) in &mut inner.buckets {
                if *l == lineage {
                    bucket.retain(|(k, _)| *k != key);
                }
            }
        }
        if inner.full_coverage.contains(&lineage) {
            let rows = inner.full_entries.get_mut(&lineage).expect("covered lineage has entries");
            rows.retain(|row| row.key != key);
        }
        inner.writes.push(ForestRowWrite::DeleteEntry { lineage, key });
        Ok(())
    }

    fn upsert_subtree(
        &mut self,
        lineage: LineageId,
        depth: u8,
        position: u64,
        blob: Vec<u8>,
    ) -> Result<()> {
        let mut inner = self.0.borrow_mut();
        inner.subtrees.insert((lineage, depth, position), Loaded::Present(blob.clone()));
        inner
            .writes
            .push(ForestRowWrite::UpsertSubtree { lineage, depth, position, blob });
        Ok(())
    }

    fn delete_subtree(&mut self, lineage: LineageId, depth: u8, position: u64) -> Result<()> {
        let mut inner = self.0.borrow_mut();
        inner.subtrees.insert((lineage, depth, position), Loaded::Absent);
        inner.writes.push(ForestRowWrite::DeleteSubtree { lineage, depth, position });
        Ok(())
    }

    fn upsert_tree_meta(&mut self, lineage: LineageId, meta: ForestTreeMeta) -> Result<()> {
        let mut inner = self.0.borrow_mut();
        inner.trees.insert(lineage, meta);
        inner.writes.push(ForestRowWrite::UpsertTreeMeta { lineage, meta });
        Ok(())
    }

    // Running `body` directly is correct here because the whole cache (and its recorded delta)
    // is discarded when the surrounding store operation fails, and nothing else observes it.
    fn write_atomically<T>(&mut self, body: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        body(self)
    }
}
