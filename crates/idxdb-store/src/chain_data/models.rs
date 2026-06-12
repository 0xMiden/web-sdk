use alloc::string::String;
use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

use crate::{base64_to_vec_u8_optional, base64_to_vec_u8_required};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockHeaderIdxdbObject {
    pub block_num: u32,
    #[serde(deserialize_with = "base64_to_vec_u8_required", default)]
    pub header: Vec<u8>,
    pub has_client_notes: bool,
}

/// Represents a partial blockchain node stored in `IndexedDB`.
///
/// Note: `id` is stored as `u32` because this store is WASM-only, where `usize` is 32 bits.
/// This limits WASM clients to blockchains with up to ~2^31 blocks (see `utils.rs` for details).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialBlockchainNodeIdxdbObject {
    pub id: u32,
    pub node: String,
}

/// Blockchain peaks at the current sync height. Resolved by looking up the
/// `blockHeaders` row at `stateSync.blockNum` — that row's
/// `partialBlockchainPeaks` column holds the peaks captured when the block was
/// the chain tip. `peaks` is `None` before the first sync (or if the chain-tip
/// row was inserted via backfill and never received peaks).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialBlockchainPeaksIdxdbObject {
    pub block_num: u32,
    #[serde(deserialize_with = "base64_to_vec_u8_optional", default)]
    pub peaks: Option<Vec<u8>>,
}
