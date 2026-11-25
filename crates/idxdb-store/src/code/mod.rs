//! The code registry: the MAST forests that the store knows, with their debug info, and the
//! procedure roots of each forest.

use alloc::string::{String, ToString};
use alloc::sync::Arc;
use alloc::vec::Vec;

use miden_client::store::StoreError;
use miden_processor::LoadedMastForest;
use miden_protocol::MastForest;
use miden_protocol::code::ProcedureRoot;
use miden_protocol::utils::serde::{Deserializable, Serializable};
use miden_protocol::vm::{Package, PackageDebugInfo};

mod js_bindings;
mod models;

use js_bindings::{
    idxdb_get_forests_with_debug_info,
    idxdb_get_procedure,
    idxdb_insert_procedures_with_debug_info,
};
use models::{CodeForestIdxdbInput, CodeForestIdxdbObject};

use crate::IdxdbStore;
use crate::promise::{await_js, await_ok};

impl IdxdbStore {
    /// Adds the MAST forests of the packages and their debug info to the code registry.
    ///
    /// A package whose forest already has debug info in the registry is skipped, and so is a
    /// package without debug info or without procedures. The packages to skip are found with a
    /// read, so the debug info is decoded and the forests are serialized only for the packages that
    /// the registry is missing.
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
        for package in &packages {
            let mast = package.mast_forest();
            let commitment = mast.commitment().to_hex();
            if stored.contains(&commitment) {
                continue;
            }
            let debug_info =
                package.debug_info().map_err(|err| StoreError::ParsingError(err.to_string()))?;
            if let Some(debug_info) = debug_info {
                missing.push(CodeForestIdxdbInput {
                    commitment,
                    mast: mast.to_bytes(),
                    debug_info: debug_info.to_bytes(),
                    procedure_roots: mast
                        .local_procedure_digests()
                        .map(|root| root.to_hex())
                        .collect(),
                });
            }
        }
        if missing.is_empty() {
            return Ok(());
        }

        let missing = serde_wasm_bindgen::to_value(&missing)
            .map_err(|err| StoreError::DatabaseError(format!("serialization error: {err}")))?;
        let promise = idxdb_insert_procedures_with_debug_info(self.db_id(), missing);
        await_ok(promise, "failed to insert code registry procedures").await
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
}
