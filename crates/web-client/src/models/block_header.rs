use js_export_macro::js_export;
use miden_client::block::BlockHeader as NativeBlockHeader;

use super::account_id::AccountId;
use super::word::Word;

/// Public header for a block, containing commitments to the chain state and the proof attesting to
/// the block's validity.
///
/// Key fields include the previous block commitment, block number, chain/nullifier/note roots,
/// transaction commitments (including the kernel), proof commitment, and a timestamp. Two derived
/// values are exposed:
/// - `sub_commitment`: sequential hash of all fields except the `note_root`.
/// - `commitment`: a 2-to-1 hash of the `sub_commitment` and the `note_root`.
#[derive(Clone)]
#[js_export]
pub struct BlockHeader(NativeBlockHeader);

#[js_export]
impl BlockHeader {
    /// Returns the header version.
    pub fn version(&self) -> u32 {
        self.0.version()
    }

    /// Returns the commitment to the block contents.
    pub fn commitment(&self) -> Word {
        self.0.commitment().into()
    }

    /// Returns the commitment to block metadata.
    #[js_export(js_name = "subCommitment")]
    pub fn sub_commitment(&self) -> Word {
        self.0.sub_commitment().into()
    }

    /// Returns the commitment of the previous block.
    #[js_export(js_name = "prevBlockCommitment")]
    pub fn prev_block_commitment(&self) -> Word {
        self.0.prev_block_commitment().into()
    }

    /// Returns the block height.
    #[js_export(js_name = "blockNum")]
    pub fn block_num(&self) -> u32 {
        self.0.block_num().as_u32()
    }

    /// Returns the chain commitment.
    #[js_export(js_name = "chainCommitment")]
    pub fn chain_commitment(&self) -> Word {
        self.0.chain_commitment().into()
    }

    /// Returns the account root commitment.
    #[js_export(js_name = "accountRoot")]
    pub fn account_root(&self) -> Word {
        self.0.account_root().into()
    }

    /// Returns the nullifier root commitment.
    #[js_export(js_name = "nullifierRoot")]
    pub fn nullifier_root(&self) -> Word {
        self.0.nullifier_root().into()
    }

    /// Returns the note commitment root.
    #[js_export(js_name = "noteRoot")]
    pub fn note_root(&self) -> Word {
        self.0.note_root().into()
    }

    /// Returns the transaction commitment.
    #[js_export(js_name = "txCommitment")]
    pub fn tx_commitment(&self) -> Word {
        self.0.tx_commitment().into()
    }

    /// Returns the transaction kernel commitment.
    #[js_export(js_name = "txKernelCommitment")]
    pub fn tx_kernel_commitment(&self) -> Word {
        self.0.tx_kernel_commitment().into()
    }

    /// Returns the block commitment, not a distinct proof commitment.
    ///
    /// The protocol's `BlockHeader` has no `proof_commitment` field — this accessor outlived it
    /// and is an alias for [`Self::commitment`]. Renaming or removing it would break the public
    /// API, so it is documented rather than changed here. Prefer `commitment()`.
    #[js_export(js_name = "proofCommitment")]
    pub fn proof_commitment(&self) -> Word {
        self.0.commitment().into()
    }

    /// Returns the block timestamp.
    pub fn timestamp(&self) -> u32 {
        self.0.timestamp()
    }

    /// Returns the account ID of the fungible faucet whose assets are accepted as the native
    /// asset of the blockchain (i.e. the asset used for paying transaction verification fees).
    ///
    /// This is stored on-chain as part of the block's fee parameters, which means consumers can
    /// discover the native faucet by reading any block header rather than hardcoding it per
    /// network.
    #[js_export(js_name = "feeFaucetId")]
    pub fn fee_faucet_id(&self) -> AccountId {
        self.0.fee_parameters().fee_faucet_id().into()
    }

    /// Returns the chain's verification base fee, in the fee asset's smallest unit.
    ///
    /// This is a rate, not the amount a transaction pays: the fee charged is the base fee times
    /// the transaction's log verification cycles, so two transactions on the same chain pay
    /// different amounts.
    ///
    /// Zero means the chain charges nothing. `fee::pay_fee` discards the conversion info unread
    /// once the computed fee is zero, so a transaction succeeds on such a chain whether or not it
    /// commits any. Reading this is what lets a caller decide whether the fee wiring is required
    /// at all, rather than hardcoding the answer per network.
    #[js_export(js_name = "verificationBaseFee")]
    pub fn verification_base_fee(&self) -> u32 {
        self.0.fee_parameters().verification_base_fee()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeBlockHeader> for BlockHeader {
    fn from(header: NativeBlockHeader) -> Self {
        BlockHeader(header)
    }
}

impl From<&NativeBlockHeader> for BlockHeader {
    fn from(header: &NativeBlockHeader) -> Self {
        BlockHeader(header.clone())
    }
}

impl From<BlockHeader> for NativeBlockHeader {
    fn from(header: BlockHeader) -> Self {
        header.0
    }
}

impl From<&BlockHeader> for NativeBlockHeader {
    fn from(header: &BlockHeader) -> Self {
        header.0.clone()
    }
}
