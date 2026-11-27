//! The code registry: the MAST forests that the store knows, with their debug info, and the
//! procedure roots of each forest.
//!
//! The procedure roots are the leaves of the code tree. `IndexedDB` keeps only the leaves, and the
//! store keeps the tree in memory: it is built from the leaves on the first read, and each insert
//! adds the procedure roots it stored.

use alloc::string::{String, ToString};
use alloc::sync::Arc;
use alloc::vec::Vec;

use miden_client::store::StoreError;
use miden_processor::LoadedMastForest;
use miden_protocol::block::code_tree::{CodeTree, CodeTreeRoot, CodeWitness};
use miden_protocol::code::ProcedureRoot;
use miden_protocol::utils::serde::{Deserializable, Serializable};
use miden_protocol::vm::{Package, PackageDebugInfo};
use miden_protocol::{MastForest, Word};

mod js_bindings;
mod models;

use js_bindings::{
    idxdb_get_forests_with_debug_info,
    idxdb_get_procedure,
    idxdb_get_procedure_count,
    idxdb_get_procedure_roots,
    idxdb_insert_procedures,
    idxdb_insert_procedures_with_debug_info,
};
use models::{CodeForestIdxdbInput, CodeForestIdxdbObject};

use crate::IdxdbStore;
use crate::promise::{await_js, await_ok};

impl IdxdbStore {
    /// Adds the procedures of the MAST forests to the code registry, without debug info.
    ///
    /// The forests are written in one transaction, so if one fails, none is added. A forest that
    /// is already stored is kept, with its debug info if it has one, and so is the forest that an
    /// already registered procedure was first registered with. A forest without procedures is
    /// skipped.
    pub(crate) async fn insert_procedures(
        &self,
        procedures: Vec<Arc<MastForest>>,
    ) -> Result<(), StoreError> {
        let forests: Vec<CodeForestIdxdbInput> = procedures
            .iter()
            .filter(|mast| mast.local_procedure_digests().next().is_some())
            .map(|mast| CodeForestIdxdbInput {
                commitment: mast.commitment().to_hex(),
                mast: mast.to_bytes(),
                debug_info: None,
                procedure_roots: mast.local_procedure_digests().map(|root| root.to_hex()).collect(),
            })
            .collect();
        if forests.is_empty() {
            return Ok(());
        }

        let forests = serde_wasm_bindgen::to_value(&forests)
            .map_err(|err| StoreError::DatabaseError(format!("serialization error: {err}")))?;
        let promise = idxdb_insert_procedures(self.db_id(), forests);
        await_ok(promise, "failed to insert code registry procedures").await?;
        let procedure_roots = procedure_roots_of(procedures.iter().map(AsRef::as_ref));
        self.add_to_cached_code_tree(procedure_roots);
        Ok(())
    }

    /// Adds the MAST forests of the packages and their debug info to the code registry.
    ///
    /// A package whose forest already has debug info in the registry is skipped, and so is a
    /// package without procedures. A package without debug info is added without debug info. The
    /// packages to skip are found with a read, so the debug info is decoded and the forests are
    /// serialized only for the packages that the registry is missing.
    pub(crate) async fn insert_procedures_with_debug_info(
        &self,
        packages: Vec<Arc<Package>>,
    ) -> Result<(), StoreError> {
        let packages: Vec<_> = packages
            .into_iter()
            .filter(|package| package.mast_forest().local_procedure_digests().next().is_some())
            .collect();
        if packages.is_empty() {
            return Ok(());
        }

        let commitments: Vec<String> = packages
            .iter()
            .map(|package| package.mast_forest().commitment().to_hex())
            .collect();
        let promise = idxdb_get_forests_with_debug_info(self.db_id(), commitments);
        let stored: Vec<String> = await_js(promise, "failed to get code registry forests").await?;

        let mut missing = Vec::new();
        let mut missing_forests = Vec::new();
        for package in &packages {
            let mast = package.mast_forest();
            let commitment = mast.commitment().to_hex();
            if stored.contains(&commitment) {
                continue;
            }
            let debug_info =
                package.debug_info().map_err(|err| StoreError::ParsingError(err.to_string()))?;
            missing_forests.push(Arc::clone(mast));
            missing.push(CodeForestIdxdbInput {
                commitment,
                mast: mast.to_bytes(),
                debug_info: debug_info.map(|debug_info| debug_info.to_bytes()),
                procedure_roots: mast.local_procedure_digests().map(|root| root.to_hex()).collect(),
            });
        }
        if missing.is_empty() {
            return Ok(());
        }

        let missing = serde_wasm_bindgen::to_value(&missing)
            .map_err(|err| StoreError::DatabaseError(format!("serialization error: {err}")))?;
        let promise = idxdb_insert_procedures_with_debug_info(self.db_id(), missing);
        await_ok(promise, "failed to insert code registry procedures").await?;
        self.add_to_cached_code_tree(procedure_roots_of(missing_forests.iter().map(AsRef::as_ref)));
        Ok(())
    }

    /// Returns the MAST forest that holds the procedure, with the debug info of the forest if the
    /// registry has it, or `None` if the procedure is not registered.
    pub(crate) async fn get_procedure(
        &self,
        procedure_root: ProcedureRoot,
    ) -> Result<Option<LoadedMastForest>, StoreError> {
        let promise = idxdb_get_procedure(self.db_id(), procedure_root.as_word().to_hex());
        let forest: Option<CodeForestIdxdbObject> =
            await_js(promise, "failed to get procedure").await?;
        let Some(forest) = forest else {
            return Ok(None);
        };

        let mast = Arc::new(MastForest::read_from_bytes(&forest.mast)?);
        let debug_info = forest
            .debug_info
            .map(|bytes| PackageDebugInfo::read_from_bytes(&bytes))
            .transpose()?;
        Ok(Some(LoadedMastForest::with_package_debug_info(mast, Ok(debug_info))))
    }

    /// Returns a witness that proves the presence or absence of the procedure in the code tree.
    pub(crate) async fn get_procedure_witness(
        &self,
        procedure_root: ProcedureRoot,
    ) -> Result<CodeWitness, StoreError> {
        Ok(self.get_code_tree().await?.open(&procedure_root))
    }

    /// Returns the root of the code tree.
    pub(crate) async fn get_code_tree_root(&self) -> Result<CodeTreeRoot, StoreError> {
        Ok(self.get_code_tree().await?.root())
    }

    // HELPERS
    // --------------------------------------------------------------------------------------------

    /// Returns the code tree, from the cache when it is current, and otherwise after rebuilding
    /// the cache from the registry.
    ///
    /// Callers use the tree and drop it before their next `await`. An insert that runs while a
    /// caller still holds the tree copies it before changing it.
    async fn get_code_tree(&self) -> Result<Arc<CodeTree>, StoreError> {
        let promise = idxdb_get_procedure_count(self.db_id());
        let stored_procedures_count: usize =
            await_js(promise, "failed to count code registry procedures").await?;
        // The store might have been updated by a different writer (e.g. the Web Worker),
        // so we make sure the cache is up to date before returning it.
        if let Some(code_tree) = self.code_tree.read().as_ref()
            && code_tree.num_procedures() == stored_procedures_count
        {
            return Ok(Arc::clone(code_tree));
        }

        let code_tree = Arc::new(self.build_code_tree().await?);
        *self.code_tree.write() = Some(Arc::clone(&code_tree));
        Ok(code_tree)
    }

    /// Adds procedure roots that were just stored to the cached code tree, if there is one. If the
    /// tree rejects a procedure root, the cache is dropped, and the next read rebuilds it.
    fn add_to_cached_code_tree(&self, procedure_roots: Vec<ProcedureRoot>) {
        let mut cached = self.code_tree.write();
        let Some(code_tree) = cached.as_mut() else {
            return;
        };
        let code_tree = Arc::make_mut(code_tree);
        let added = procedure_roots
            .into_iter()
            .try_for_each(|procedure_root| code_tree.insert(procedure_root).map(|_| ()));
        if added.is_err() {
            *cached = None;
        }
    }

    /// Builds the code tree from the procedure roots of the code registry.
    async fn build_code_tree(&self) -> Result<CodeTree, StoreError> {
        let promise = idxdb_get_procedure_roots(self.db_id());
        let procedure_roots: Vec<String> =
            await_js(promise, "failed to get code registry procedure roots").await?;
        let procedure_roots = procedure_roots
            .iter()
            .map(|root| Ok(ProcedureRoot::from_raw(Word::try_from(root.as_str())?)))
            .collect::<Result<Vec<_>, StoreError>>()?;
        CodeTree::with_entries(procedure_roots).map_err(|err| {
            StoreError::DatabaseError(format!("failed to build the code tree: {err}"))
        })
    }
}

/// Returns the procedure roots of the MAST forests.
fn procedure_roots_of<'a>(forests: impl Iterator<Item = &'a MastForest>) -> Vec<ProcedureRoot> {
    forests
        .flat_map(MastForest::local_procedure_digests)
        .map(ProcedureRoot::from_raw)
        .collect()
}
