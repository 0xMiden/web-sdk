use alloc::vec::Vec;

use js_export_macro::js_export;
use miden_client::block::BlockNumber;
use miden_client::rpc::domain::note::SyncNotesBlock as NativeNoteSyncBlock;

use super::block_header::BlockHeader;
use super::committed_note::CommittedNote;
use super::merkle_path::MerklePath;

/// Represents a single block's worth of note sync data returned by `syncNotes`.
#[js_export]
pub struct NoteSyncBlock(NativeNoteSyncBlock);

#[js_export]
impl NoteSyncBlock {
    /// Returns the block header for this block.
    #[js_export(js_name = "blockHeader")]
    pub fn block_header(&self) -> BlockHeader {
        self.0.block_header.clone().into()
    }

    /// Returns the MMR path for the block header.
    #[js_export(js_name = "mmrPath")]
    pub fn mmr_path(&self) -> MerklePath {
        self.0.mmr_path.clone().into()
    }

    /// Returns the committed notes in this block.
    pub fn notes(&self) -> Vec<CommittedNote> {
        self.0.notes.values().map(Into::into).collect()
    }
}

impl From<NativeNoteSyncBlock> for NoteSyncBlock {
    fn from(native: NativeNoteSyncBlock) -> Self {
        NoteSyncBlock(native)
    }
}

/// Aggregates the response data from `syncNotes`: the per-block updates plus
/// the upper bound of the requested range.
///
/// The previous `chain_tip` accessor is gone — the upstream `sync_notes` RPC
/// no longer returns the current chain tip on this endpoint. Use the
/// regular state-sync flow (`syncState`) for the latest synced height.
#[js_export]
pub struct NoteSyncInfo {
    blocks: Vec<NativeNoteSyncBlock>,
    block_to: BlockNumber,
}

impl NoteSyncInfo {
    pub fn new(blocks: Vec<NativeNoteSyncBlock>, block_to: BlockNumber) -> Self {
        Self { blocks, block_to }
    }
}

#[js_export]
impl NoteSyncInfo {
    /// Returns the upper bound of the block range scanned in this call (the
    /// `blockTo` argument passed to `syncNotes`).
    #[js_export(js_name = "blockTo")]
    pub fn block_to(&self) -> u32 {
        self.block_to.as_u32()
    }

    /// Returns the first block header with matching notes, if any. Convenience
    /// for callers that only requested a single tag and want the most recent
    /// inclusion block.
    #[js_export(js_name = "blockHeader")]
    pub fn block_header(&self) -> Option<BlockHeader> {
        self.blocks.first().map(|block| block.block_header.clone().into())
    }

    /// Returns the MMR path of the first block with matching notes, if any.
    #[js_export(js_name = "mmrPath")]
    pub fn mmr_path(&self) -> Option<MerklePath> {
        self.blocks.first().map(|block| block.mmr_path.clone().into())
    }

    /// Returns every committed note across all matching blocks (flattened).
    pub fn notes(&self) -> Vec<CommittedNote> {
        self.blocks
            .iter()
            .flat_map(|block| block.notes.values().cloned())
            .map(Into::into)
            .collect()
    }

    /// Returns the per-block breakdown.
    pub fn blocks(&self) -> Vec<NoteSyncBlock> {
        self.blocks.iter().cloned().map(NoteSyncBlock).collect()
    }
}
