use alloc::string::String;
use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

use crate::{base64_to_vec_u8_optional, base64_to_vec_u8_required};

/// A MAST forest to add to the code registry, as `insertProceduresWithDebugInfo` receives it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeForestIdxdbInput {
    pub commitment: String,
    #[serde(with = "serde_bytes")]
    pub mast: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub debug_info: Vec<u8>,
    pub procedure_roots: Vec<String>,
}

/// The forest that holds a procedure, as `getProcedure` returns it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeForestIdxdbObject {
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub mast: Vec<u8>,
    #[serde(deserialize_with = "base64_to_vec_u8_optional", default)]
    pub debug_info: Option<Vec<u8>>,
}
