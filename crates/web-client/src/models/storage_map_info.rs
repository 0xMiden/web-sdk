use alloc::string::String;
use alloc::vec::Vec;

use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::rpc::domain::storage_map::StorageMapInfo as NativeStorageMapInfo;

use super::word::Word;

/// Information about storage map updates for an account, as returned by the
/// `syncStorageMaps` RPC endpoint.
///
/// Contains the storage map entries merged over the requested block range,
/// along with the chain tip and last processed block number.
#[js_export(js_name = "StorageMapInfo")]
pub struct StorageMapInfo {
    chain_tip: u32,
    block_number: u32,
    updates: Vec<StorageMapUpdate>,
}

#[js_export]
impl StorageMapInfo {
    /// Returns the current chain tip block number.
    #[js_export(js_name = "chainTip")]
    pub fn chain_tip(&self) -> u32 {
        self.chain_tip
    }

    /// Returns the block number of the last check included in this response.
    #[js_export(js_name = "blockNumber")]
    pub fn block_number(&self) -> u32 {
        self.block_number
    }

    /// Returns the list of storage map updates.
    pub fn updates(&self) -> Vec<StorageMapUpdate> {
        self.updates.clone()
    }
}

// STORAGE MAP UPDATE
// ================================================================================================

/// A merged storage map entry containing the last processed block number, slot name, key, and
/// final value. The node no longer exposes the individual block number for each update.
#[derive(Clone)]
#[js_export(js_name = "StorageMapUpdate")]
pub struct StorageMapUpdate {
    block_num: u32,
    slot_name: String,
    key: Word,
    value: Word,
}

#[js_export]
impl StorageMapUpdate {
    /// Returns the last processed block number for the merged response.
    #[js_export(js_name = "blockNum")]
    pub fn block_num(&self) -> u32 {
        self.block_num
    }

    /// Returns the name of the storage slot that was updated.
    #[js_export(js_name = "slotName")]
    pub fn slot_name(&self) -> String {
        self.slot_name.clone()
    }

    /// Returns the storage map key that was updated.
    pub fn key(&self) -> Word {
        self.key.clone()
    }

    /// Returns the new value for this storage map key.
    pub fn value(&self) -> Word {
        self.value.clone()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeStorageMapInfo> for StorageMapInfo {
    fn from(native: NativeStorageMapInfo) -> Self {
        let block_num = native.block_number.as_u32();
        let updates = native
            .map_entries
            .iter()
            .flat_map(|(slot_name, entries)| {
                entries.as_map().iter().map(move |(key, value)| StorageMapUpdate {
                    block_num,
                    slot_name: slot_name.to_string(),
                    key: Word::from(NativeWord::from(*key)),
                    value: Word::from(*value),
                })
            })
            .collect();

        Self {
            chain_tip: native.chain_tip.as_u32(),
            block_number: native.block_number.as_u32(),
            updates,
        }
    }
}
