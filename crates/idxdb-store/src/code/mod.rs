//! The code registry: the MAST forests that the store knows, with their debug info, and the
//! procedure roots of each forest.

use alloc::string::String;
use alloc::sync::Arc;
use alloc::vec::Vec;

use miden_client::store::StoreError;
use miden_protocol::MastForest;
use miden_protocol::code::ProcedureRoot;
use miden_protocol::utils::serde::{Deserializable, Serializable};
use miden_protocol::vm::PackageDebugInfo;
use miden_tx::LoadedMastForest;

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
    /// Adds the MAST forests and their debug info to the code registry. A forest that already has
    /// debug info in the registry is skipped, and so is a forest without procedures.
    ///
    /// Only the forests that the registry is missing are serialized, so that adding the same
    /// forests on every client build stays cheap.
    pub(crate) async fn insert_procedures_with_debug_info(
        &self,
        procedures: Vec<(Arc<MastForest>, PackageDebugInfo)>,
    ) -> Result<(), StoreError> {
        let procedures: Vec<_> = procedures
            .into_iter()
            .filter(|(mast, _)| mast.local_procedure_digests().next().is_some())
            .collect();
        if procedures.is_empty() {
            return Ok(());
        }

        let commitments: Vec<String> =
            procedures.iter().map(|(mast, _)| mast.commitment().to_hex()).collect();
        let promise = idxdb_get_forests_with_debug_info(self.db_id(), commitments);
        let with_debug_info: Vec<String> =
            await_js(promise, "failed to get code registry forests").await?;

        let forests: Vec<CodeForestIdxdbInput> = procedures
            .iter()
            .filter(|(mast, _)| !with_debug_info.contains(&mast.commitment().to_hex()))
            .map(|(mast, debug_info)| CodeForestIdxdbInput {
                commitment: mast.commitment().to_hex(),
                mast: mast.to_bytes(),
                debug_info: debug_info.to_bytes(),
                procedure_roots: mast.local_procedure_digests().map(|root| root.to_hex()).collect(),
            })
            .collect();
        if forests.is_empty() {
            return Ok(());
        }

        let forests = serde_wasm_bindgen::to_value(&forests)
            .map_err(|err| StoreError::DatabaseError(format!("serialization error: {err}")))?;
        let promise = idxdb_insert_procedures_with_debug_info(self.db_id(), forests);
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
