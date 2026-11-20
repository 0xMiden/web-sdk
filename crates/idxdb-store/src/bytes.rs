//! Byte encodings of the values that the store keeps as bytes in `IndexedDB` records.
//!
//! Stored records use these encodings, so the encoding of a type must not change without a
//! database migration. Each encoding has the same bytes as the upstream `Serializable` encoding of
//! the type, so records that earlier versions wrote still decode.

use alloc::format;
use alloc::vec::Vec;

use miden_client::address::Address;
use miden_client::note::NoteTag;
use miden_client::store::StoreError;
use miden_client::transaction::LogTopic;
use miden_client::{Felt, Word};
use miden_protocol::transaction::TransactionScriptRoot;
use miden_protocol::utils::serde::{Deserializable, Serializable};

// BYTE TRAITS
// ================================================================================================

/// Encodes a value for a byte field of a stored record.
pub(crate) trait ToStoreBytes {
    fn to_store_bytes(&self) -> Vec<u8>;
}

/// Decodes a value that [`ToStoreBytes`] encoded.
pub(crate) trait FromStoreBytes: Sized {
    fn from_store_bytes(bytes: &[u8]) -> Result<Self, StoreError>;
}

// WORDS
// ================================================================================================

impl ToStoreBytes for Word {
    fn to_store_bytes(&self) -> Vec<u8> {
        self.as_bytes().to_vec()
    }
}

impl FromStoreBytes for Word {
    fn from_store_bytes(bytes: &[u8]) -> Result<Self, StoreError> {
        Ok(Word::try_from(bytes)?)
    }
}

impl ToStoreBytes for TransactionScriptRoot {
    fn to_store_bytes(&self) -> Vec<u8> {
        self.as_bytes().to_vec()
    }
}

// NOTE TAGS
// ================================================================================================

impl ToStoreBytes for NoteTag {
    fn to_store_bytes(&self) -> Vec<u8> {
        self.as_u32().to_le_bytes().to_vec()
    }
}

impl FromStoreBytes for NoteTag {
    fn from_store_bytes(bytes: &[u8]) -> Result<Self, StoreError> {
        let bytes = <[u8; 4]>::try_from(bytes).map_err(|_| {
            StoreError::ParsingError(format!("note tag must have 4 bytes, but has {}", bytes.len()))
        })?;
        Ok(NoteTag::new(u32::from_le_bytes(bytes)))
    }
}

// LOG TOPICS
// ================================================================================================

/// The size in bytes of an encoded log topic.
const LOG_TOPIC_SIZE: usize = 16;

/// Encodes a log topic as its suffix and then its prefix, each as a little-endian `u64`. The
/// `SQLite` store uses the same bytes.
impl ToStoreBytes for LogTopic {
    fn to_store_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(LOG_TOPIC_SIZE);
        bytes.extend_from_slice(&self.suffix().as_canonical_u64().to_le_bytes());
        bytes.extend_from_slice(&self.prefix().as_canonical_u64().to_le_bytes());
        bytes
    }
}

impl FromStoreBytes for LogTopic {
    fn from_store_bytes(bytes: &[u8]) -> Result<Self, StoreError> {
        let bytes = <[u8; LOG_TOPIC_SIZE]>::try_from(bytes).map_err(|_| {
            StoreError::ParsingError(format!(
                "log topic must have {LOG_TOPIC_SIZE} bytes, but has {}",
                bytes.len()
            ))
        })?;
        let (suffix, prefix) = bytes.split_at(LOG_TOPIC_SIZE / 2);
        let felt = |half: &[u8]| {
            let value = u64::from_le_bytes(half.try_into().expect("each half holds eight bytes"));
            Felt::new(value).map_err(|err| {
                StoreError::ParsingError(format!("invalid log topic element: {err}"))
            })
        };

        Ok(LogTopic::new(felt(suffix)?, felt(prefix)?))
    }
}

// UPSTREAM ENCODINGS
// ================================================================================================

/// Encodes an address with its upstream `Serializable` encoding. `Address` has no other byte
/// encoding.
impl ToStoreBytes for Address {
    fn to_store_bytes(&self) -> Vec<u8> {
        self.to_bytes()
    }
}

impl FromStoreBytes for Address {
    fn from_store_bytes(bytes: &[u8]) -> Result<Self, StoreError> {
        Address::read_from_bytes(bytes)
            .map_err(|err| StoreError::ParsingError(format!("invalid address: {err}")))
    }
}
