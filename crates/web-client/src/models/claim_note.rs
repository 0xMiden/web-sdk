use js_export_macro::js_export;
use miden_client::agglayer::{
    EthAmount,
    ExitRoot,
    GlobalIndex,
    LeafData,
    MetadataHash,
    ProofData,
    SmtNode,
};

use super::eth_address::EthAddress;
use crate::platform::{JsErr, from_str_err};

/// The Merkle proof of an `AggLayer` deposit that a CLAIM note carries: the two 32-node SMT
/// proofs, the global index and the mainnet and rollup exit roots, each a 32-byte hex string
/// (the `0x` prefix is optional), as the `claimAsset` call of the `AggLayer` bridge takes them.
#[js_export]
#[derive(Clone)]
pub struct ClaimProofData(ProofData);

#[js_export]
impl ClaimProofData {
    /// Builds the proof data from hex strings.
    ///
    /// Returns an error if either proof does not have exactly 32 nodes or any value is not a
    /// 32-byte hex string.
    #[js_export(constructor)]
    pub fn new(
        smt_proof_local_exit_root: Vec<String>,
        smt_proof_rollup_exit_root: Vec<String>,
        global_index: String,
        mainnet_exit_root: String,
        rollup_exit_root: String,
    ) -> Result<ClaimProofData, JsErr> {
        Ok(ClaimProofData(ProofData {
            smt_proof_local_exit_root: smt_proof(&smt_proof_local_exit_root, "local exit root")?,
            smt_proof_rollup_exit_root: smt_proof(&smt_proof_rollup_exit_root, "rollup exit root")?,
            global_index: GlobalIndex::new(bytes32(&global_index, "global index")?),
            mainnet_exit_root: ExitRoot::new(bytes32(&mainnet_exit_root, "mainnet exit root")?),
            rollup_exit_root: ExitRoot::new(bytes32(&rollup_exit_root, "rollup exit root")?),
        }))
    }
}

/// The deposit leaf a CLAIM note carries: origin network and token, destination network and
/// address, the uint256 amount in the token's base units and the token metadata hash.
#[js_export]
#[derive(Clone)]
pub struct ClaimLeafData(LeafData);

#[js_export]
impl ClaimLeafData {
    /// Builds the leaf data. `amount` is a decimal string, since a uint256 does not fit a
    /// JavaScript number or a u64; `metadata_hash` is a 32-byte hex string.
    #[js_export(constructor)]
    pub fn new(
        origin_network: u32,
        origin_token_address: &EthAddress,
        destination_network: u32,
        destination_address: &EthAddress,
        amount: String,
        metadata_hash: String,
    ) -> Result<ClaimLeafData, JsErr> {
        let amount = EthAmount::from_uint_str(&amount)
            .map_err(|err| from_str_err(&format!("invalid claim amount {amount:?}: {err}")))?;
        Ok(ClaimLeafData(LeafData {
            origin_network,
            origin_token_address: origin_token_address.into(),
            destination_network,
            destination_address: destination_address.into(),
            amount,
            metadata_hash: MetadataHash::new(bytes32(&metadata_hash, "metadata hash")?),
        }))
    }
}

impl ClaimProofData {
    pub(crate) fn as_native(&self) -> &ProofData {
        &self.0
    }
}

impl ClaimLeafData {
    pub(crate) fn as_native(&self) -> &LeafData {
        &self.0
    }
}

impl_napi_from_value!(ClaimProofData);
impl_napi_from_value!(ClaimLeafData);

fn bytes32(hex: &str, what: &str) -> Result<[u8; 32], JsErr> {
    SmtNode::from_hex(hex)
        .map(|node| *node.as_bytes())
        .map_err(|err| from_str_err(&format!("{what} must be a 32-byte hex string: {err}")))
}

fn smt_proof(nodes: &[String], what: &str) -> Result<[SmtNode; 32], JsErr> {
    let nodes = nodes
        .iter()
        .map(|node| bytes32(node, what).map(SmtNode::new))
        .collect::<Result<Vec<_>, _>>()?;
    let count = nodes.len();
    nodes
        .try_into()
        .map_err(|_| from_str_err(&format!("{what} proof needs 32 nodes, got {count}")))
}
