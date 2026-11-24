use js_export_macro::js_export;
use miden_client::account::{StorageMapKey, StorageMapWitness as NativeStorageMapWitness};

use super::word::Word;

/// An inclusion proof for storage map entries, as stored for an account.
#[derive(Clone)]
#[js_export]
pub struct StorageMapWitness(NativeStorageMapWitness);

#[js_export]
impl StorageMapWitness {
    /// Returns the value the witness holds for a key, or `undefined` if the key is not covered.
    pub fn get(&self, key: &Word) -> Option<Word> {
        self.0.get(StorageMapKey::new(*key.as_native())).map(Into::into)
    }

    /// Returns the storage map root the witness opens against.
    pub fn root(&self) -> Word {
        self.0.proof().compute_root().into()
    }
}

impl From<NativeStorageMapWitness> for StorageMapWitness {
    fn from(witness: NativeStorageMapWitness) -> Self {
        StorageMapWitness(witness)
    }
}
