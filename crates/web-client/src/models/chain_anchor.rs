use js_export_macro::js_export;
use miden_client::transaction::ChainAnchor as NativeChainAnchor;

use super::block_header::BlockHeader;
use super::word::Word;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_untrusted_bytes, serialize_to_bytes};

/// A self-contained, verifiable anchor that pins transaction execution to a specific reference
/// block instead of the client's current sync height.
///
/// Since protocol 0.16 a signed transaction summary binds the reference block commitment, so
/// signatures collected over a summary only authorize an execution whose reference block is the
/// one the summary was built at. Flows that collect signatures and execute later — multisig
/// proposals, offline co-signing — capture an anchor alongside the summary and replay execution
/// against it, so the summary reproduces exactly on a client at any sync height.
///
/// The anchor bundles the reference block header with a partial blockchain consistent with it.
/// Both invariants (chain length matches the header's block number, peaks hash to the header's
/// chain commitment) are enforced natively on construction and on [`Self::deserialize`], so an
/// anchor received from an untrusted party only needs its [`Self::commitment`] compared against
/// an independently trusted value — e.g. the block commitment bound into the signed summary —
/// before it is safe to execute against.
#[derive(Clone)]
#[js_export]
pub struct ChainAnchor(NativeChainAnchor);

#[js_export]
impl ChainAnchor {
    /// Serializes the anchor into bytes, for shipping alongside a summary awaiting signatures.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes an anchor from bytes.
    ///
    /// Rejects bytes whose partial blockchain is inconsistent with the header, so an anchor from
    /// an untrusted source cannot be malformed — only pinned to the wrong block, which
    /// [`Self::commitment`] detects. Allocation is budgeted to the input length and trailing
    /// bytes are rejected, since these bytes arrive from a counterparty rather than local
    /// storage.
    ///
    /// The encoding carries no version tag, so anchors are only interchangeable between parties
    /// on compatible SDK versions; a skew surfaces here as a generic deserialization failure.
    pub fn deserialize(bytes: JsBytes) -> Result<ChainAnchor, JsErr> {
        deserialize_untrusted_bytes::<NativeChainAnchor>(&bytes).map(ChainAnchor)
    }

    /// Returns the number of the anchored reference block.
    #[js_export(js_name = "blockNum")]
    pub fn block_num(&self) -> u32 {
        self.0.block_num().as_u32()
    }

    /// Returns the commitment of the anchored reference block.
    ///
    /// Compare this against an independently trusted commitment before executing with an anchor
    /// from an untrusted source.
    pub fn commitment(&self) -> Word {
        self.0.block_commitment().into()
    }

    /// Returns the anchored reference block header.
    #[js_export(js_name = "blockHeader")]
    pub fn block_header(&self) -> BlockHeader {
        self.0.header().into()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<ChainAnchor> for NativeChainAnchor {
    fn from(anchor: ChainAnchor) -> Self {
        anchor.0
    }
}

impl From<&ChainAnchor> for NativeChainAnchor {
    fn from(anchor: &ChainAnchor) -> Self {
        anchor.0.clone()
    }
}

impl From<NativeChainAnchor> for ChainAnchor {
    fn from(anchor: NativeChainAnchor) -> Self {
        ChainAnchor(anchor)
    }
}

impl From<&NativeChainAnchor> for ChainAnchor {
    fn from(anchor: &NativeChainAnchor) -> Self {
        ChainAnchor(anchor.clone())
    }
}

impl_napi_from_value!(ChainAnchor);
