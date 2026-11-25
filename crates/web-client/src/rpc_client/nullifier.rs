use alloc::collections::BTreeSet;

use js_export_macro::js_export;
use miden_client::note::Nullifier;
use miden_client::rpc::domain::nullifier::NullifierUpdate as NativeNullifierUpdate;

use super::RpcClient;
use crate::js_error_with_context;
use crate::models::word::Word;
use crate::platform::{JsErr, JsU16Array, from_str_err};

/// A note consumption returned by `RpcClient.syncNullifiers`.
#[js_export]
pub struct NullifierUpdate(NativeNullifierUpdate);

#[js_export]
impl NullifierUpdate {
    /// Returns the full nullifier of the consumed note.
    ///
    /// A prefix can match multiple notes. Compare this value with the full nullifier you track.
    pub fn nullifier(&self) -> Word {
        self.0.nullifier.as_word().into()
    }

    /// Returns the block in which the note was consumed.
    #[js_export(js_name = "blockNum")]
    pub fn block_num(&self) -> u32 {
        self.0.block_num.as_u32()
    }
}

#[js_export]
impl RpcClient {
    /// Fetches consumed nullifiers matching 16-bit prefixes within an inclusive block range.
    ///
    /// Uses the Rust RPC client's request chunking, pagination, response verification and
    /// deduplication. No local store or tracked accounts are required. The caller must supply
    /// a `block_to` at or below the node's chain tip and retain its own sync cursor.
    ///
    /// A prefix is the most significant 16 bits of the nullifier's fourth field element.
    /// Results can include other notes sharing a prefix; compare the full returned nullifier
    /// with the one you track. An empty prefix array returns an empty result without RPC calls.
    /// Duplicate prefixes are scanned once. The input is copied before asynchronous work and
    /// the caller's array is not modified. On Node.js, prefixes must be backed by an `ArrayBuffer`;
    /// `SharedArrayBuffer` backing is rejected during argument conversion.
    ///
    /// @param prefixes - A `Uint16Array` of nullifier prefixes.
    /// @param `block_from` - First block to scan, inclusive.
    /// @param block_to - Last block to scan, inclusive; must be at least `block_from`.
    /// @returns All matching nullifier updates across every chunk and page.
    #[allow(clippy::doc_markdown)]
    #[js_export(js_name = "syncNullifiers")]
    pub async fn sync_nullifiers(
        &self,
        prefixes: JsU16Array,
        block_from: u32,
        block_to: u32,
    ) -> Result<Vec<NullifierUpdate>, JsErr> {
        if block_from > block_to {
            return Err(from_str_err("block_from must be less than or equal to block_to"));
        }
        // Both bindings copy the JS input before scheduling this async body.
        #[cfg(feature = "nodejs")]
        let prefixes = prefixes.0;
        let mut prefixes = prefixes;
        if prefixes.is_empty() {
            return Ok(Vec::new());
        }

        prefixes.sort_unstable();
        prefixes.dedup();

        self.inner
            .sync_nullifiers(&prefixes, block_from.into(), block_to.into())
            .await
            .map(|updates| updates.into_iter().map(NullifierUpdate).collect())
            .map_err(|err| js_error_with_context(err, "failed to sync nullifiers"))
    }
}

#[js_export]
impl RpcClient {
    /// Fetches the block in which each given nullifier was consumed.
    ///
    /// Scans from `block_from` (inclusive) up to the chain tip and compares full nullifiers, not
    /// prefixes. A nullifier with no commitment in that range is left out of the result. On the
    /// browser entries the `nullifiers` handles are consumed; pass copies you still need.
    ///
    /// @param nullifiers - The nullifiers to look up.
    /// @param `block_from` - First block to scan, inclusive.
    #[js_export(js_name = "getNullifierCommitHeights")]
    pub async fn get_nullifier_commit_heights(
        &self,
        nullifiers: Vec<Word>,
        block_from: u32,
    ) -> Result<Vec<NullifierUpdate>, JsErr> {
        let requested: BTreeSet<Nullifier> =
            nullifiers.iter().map(|word| Nullifier::from_raw(word.into())).collect();
        if requested.is_empty() {
            return Ok(Vec::new());
        }

        self.inner
            .get_nullifier_commit_heights(requested, block_from.into())
            .await
            .map(|heights| {
                heights
                    .into_iter()
                    .filter_map(|(nullifier, height)| {
                        height.map(|block_num| {
                            NullifierUpdate(NativeNullifierUpdate { nullifier, block_num })
                        })
                    })
                    .collect()
            })
            .map_err(|err| js_error_with_context(err, "failed to get nullifier commit heights"))
    }
}
