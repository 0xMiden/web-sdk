use alloc::vec::Vec;

use js_export_macro::js_export;
use miden_client::rpc::domain::note::NoteSyncBlock as NativeNoteSyncBlock;

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
