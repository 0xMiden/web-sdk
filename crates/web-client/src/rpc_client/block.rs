use js_export_macro::js_export;
use miden_client::crypto::MmrProof as NativeMmrProof;

use super::RpcClient;
use crate::js_error_with_context;
use crate::models::block_header::BlockHeader;
use crate::models::merkle_path::MerklePath;
use crate::models::word::Word;
use crate::platform::{JsErr, from_str_err};

/// Proof that a block commitment is a leaf of the chain's MMR at a given chain length.
#[derive(Clone)]
#[js_export]
pub struct MmrProof(NativeMmrProof);

#[js_export]
impl MmrProof {
    /// Returns the opened leaf, the block commitment.
    pub fn leaf(&self) -> Word {
        self.0.leaf().into()
    }

    /// Returns the leaf's position in the MMR, which is its block number.
    pub fn position(&self) -> u32 {
        u32::try_from(self.0.position()).unwrap_or(u32::MAX)
    }

    /// Returns the number of leaves the MMR held when the proof was made, the chain length.
    pub fn forest(&self) -> u32 {
        u32::try_from(self.0.forest().num_leaves()).unwrap_or(u32::MAX)
    }

    /// Returns the Merkle opening from the leaf's sibling up to, and excluding, its peak.
    #[js_export(js_name = "merklePath")]
    pub fn merkle_path(&self) -> MerklePath {
        self.0.merkle_path().clone().into()
    }

    /// Returns the index of the MMR peak the Merkle path verifies against.
    #[js_export(js_name = "peakIndex")]
    pub fn peak_index(&self) -> u32 {
        u32::try_from(self.0.peak_index()).unwrap_or(u32::MAX)
    }
}

/// A block header together with the MMR proof of its inclusion in the chain.
#[js_export]
pub struct BlockHeaderWithProof {
    header: BlockHeader,
    proof: MmrProof,
}

#[js_export]
impl BlockHeaderWithProof {
    /// Returns the block header.
    pub fn header(&self) -> BlockHeader {
        self.header.clone()
    }

    /// Returns the MMR proof for the header's block commitment.
    #[js_export(js_name = "mmrProof")]
    pub fn mmr_proof(&self) -> MmrProof {
        self.proof.clone()
    }
}

#[js_export]
impl RpcClient {
    /// Fetches a block header and the MMR proof that its commitment is part of the chain.
    ///
    /// The proof is made against the chain length the node reports in `forest()`, which can be
    /// later than the block. `getBlockHeaderByNumber` returns the header alone.
    ///
    /// @param `block_num` - The block to fetch.
    #[js_export(js_name = "getBlockHeaderWithProof")]
    pub async fn get_block_header_with_proof(
        &self,
        block_num: u32,
    ) -> Result<BlockHeaderWithProof, JsErr> {
        let (header, proof) = self
            .inner
            .get_block_header_by_number(Some(block_num.into()), true)
            .await
            .map_err(|err| js_error_with_context(err, "failed to get block header with proof"))?;
        let proof = proof.ok_or_else(|| from_str_err("the node returned no MMR proof"))?;

        Ok(BlockHeaderWithProof {
            header: header.into(),
            proof: MmrProof(proof),
        })
    }
}
