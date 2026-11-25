use alloc::string::String;

use js_export_macro::js_export;
use miden_client::rpc::domain::status::{
    BlockProducerStatusInfo as NativeBlockProducerStatusInfo,
    MempoolStatsInfo as NativeMempoolStatsInfo,
    RpcStatusInfo as NativeRpcStatusInfo,
};

use super::word::Word;

/// Status of the node's RPC component, as reported by its `Status` endpoint.
#[derive(Clone)]
#[js_export(js_name = "RpcStatusInfo")]
pub struct RpcStatusInfo {
    version: String,
    genesis_commitment: Option<Word>,
    chain_tip: u32,
    block_producer: Option<BlockProducerStatusInfo>,
}

#[js_export]
impl RpcStatusInfo {
    /// Returns the node's RPC version.
    #[js_export(getter)]
    pub fn version(&self) -> String {
        self.version.clone()
    }

    /// Returns the genesis commitment of the node's chain, if it reports one.
    #[js_export(getter, js_name = "genesisCommitment")]
    pub fn genesis_commitment(&self) -> Option<Word> {
        self.genesis_commitment.clone()
    }

    /// Returns the block number of the node's chain tip.
    #[js_export(getter, js_name = "chainTip")]
    pub fn chain_tip(&self) -> u32 {
        self.chain_tip
    }

    /// Returns the block producer's status, if the node reports it.
    #[js_export(getter, js_name = "blockProducer")]
    pub fn block_producer(&self) -> Option<BlockProducerStatusInfo> {
        self.block_producer.clone()
    }
}

/// Status of the node's block producer.
#[derive(Clone)]
#[js_export(js_name = "BlockProducerStatusInfo")]
pub struct BlockProducerStatusInfo {
    version: String,
    status: String,
    chain_tip: u32,
    mempool_stats: Option<MempoolStatsInfo>,
}

#[js_export]
impl BlockProducerStatusInfo {
    /// Returns the block producer's version.
    #[js_export(getter)]
    pub fn version(&self) -> String {
        self.version.clone()
    }

    /// Returns the block producer's status as the node reports it.
    #[js_export(getter)]
    pub fn status(&self) -> String {
        self.status.clone()
    }

    /// Returns the block number of the block producer's chain tip.
    #[js_export(getter, js_name = "chainTip")]
    pub fn chain_tip(&self) -> u32 {
        self.chain_tip
    }

    /// Returns the block producer's mempool statistics, if the node reports them.
    #[js_export(getter, js_name = "mempoolStats")]
    pub fn mempool_stats(&self) -> Option<MempoolStatsInfo> {
        self.mempool_stats.clone()
    }
}

/// Mempool statistics of the node's block producer.
#[derive(Clone)]
#[js_export(js_name = "MempoolStatsInfo")]
pub struct MempoolStatsInfo {
    unbatched_transactions: u64,
    proposed_batches: u64,
    proven_batches: u64,
}

#[js_export]
impl MempoolStatsInfo {
    /// Returns the number of transactions not yet in a batch.
    #[js_export(getter, js_name = "unbatchedTransactions")]
    pub fn unbatched_transactions(&self) -> u64 {
        self.unbatched_transactions
    }

    /// Returns the number of proposed batches not yet proven.
    #[js_export(getter, js_name = "proposedBatches")]
    pub fn proposed_batches(&self) -> u64 {
        self.proposed_batches
    }

    /// Returns the number of proven batches not yet in a block.
    #[js_export(getter, js_name = "provenBatches")]
    pub fn proven_batches(&self) -> u64 {
        self.proven_batches
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeRpcStatusInfo> for RpcStatusInfo {
    fn from(native: NativeRpcStatusInfo) -> Self {
        Self {
            version: native.version,
            genesis_commitment: native.genesis_commitment.map(Into::into),
            chain_tip: native.chain_tip,
            block_producer: native.block_producer.map(Into::into),
        }
    }
}

impl From<NativeBlockProducerStatusInfo> for BlockProducerStatusInfo {
    fn from(native: NativeBlockProducerStatusInfo) -> Self {
        Self {
            version: native.version,
            status: native.status,
            chain_tip: native.chain_tip,
            mempool_stats: native.mempool_stats.map(Into::into),
        }
    }
}

impl From<NativeMempoolStatsInfo> for MempoolStatsInfo {
    fn from(native: NativeMempoolStatsInfo) -> Self {
        Self {
            unbatched_transactions: native.unbatched_transactions,
            proposed_batches: native.proposed_batches,
            proven_batches: native.proven_batches,
        }
    }
}
