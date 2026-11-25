//! Byte encodings of the values that the store keeps as bytes in `IndexedDB` records.
//!
//! Stored records use these encodings, so the encoding of a type must not change without a
//! database migration. Each encoding has the same bytes as the upstream `Serializable` encoding of
//! the type, so records that earlier versions wrote still decode.

use alloc::format;
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::address::Address;
use miden_client::note::NoteTag;
use miden_client::store::StoreError;
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
