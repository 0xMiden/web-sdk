//! Protobuf message of [`SyncSummary`], owned privately by `web-client` for worker IPC.

use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::AccountId;
use miden_client::note::NoteId;
use miden_client::sync::SyncSummary;
use miden_client::transaction::TransactionId;
use miden_protocol::utils::serde::{ByteReader, Deserializable, Serializable, SliceReader};
use prost::Message;

use super::{invalid, with_context};
use crate::js_error_with_context;
use crate::platform::{JsBytes, JsErr, js_to_bytes};

const SYNC_SUMMARY: &str = "failed to deserialize SyncSummary";

/// Private wire message for [`SyncSummary`].
///
/// Packs the fixed-size ID lists into contiguous byte buffers rather than nested per-ID messages.
#[derive(Clone, PartialEq, Message)]
pub struct SyncSummaryMessage {
    #[prost(fixed32, tag = "1")]
    pub block_num: u32,
    #[prost(bytes = "vec", tag = "2")]
    pub new_public_notes: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    pub new_private_notes: Vec<u8>,
    #[prost(bytes = "vec", tag = "4")]
    pub committed_notes: Vec<u8>,
    #[prost(bytes = "vec", tag = "5")]
    pub consumed_notes: Vec<u8>,
    #[prost(bytes = "vec", tag = "6")]
    pub updated_accounts: Vec<u8>,
    #[prost(bytes = "vec", tag = "7")]
    pub locked_accounts: Vec<u8>,
    #[prost(bytes = "vec", tag = "8")]
    pub committed_transactions: Vec<u8>,
}

impl From<&SyncSummary> for SyncSummaryMessage {
    fn from(summary: &SyncSummary) -> Self {
        Self {
            block_num: summary.block_num.as_u32(),
            new_public_notes: encode_words(summary.new_public_notes.iter().map(NoteId::as_word)),
            new_private_notes: encode_words(summary.new_private_notes.iter().map(NoteId::as_word)),
            committed_notes: encode_words(summary.committed_notes.iter().map(NoteId::as_word)),
            consumed_notes: encode_words(summary.consumed_notes.iter().map(NoteId::as_word)),
            updated_accounts: encode_account_ids(&summary.updated_accounts),
            locked_accounts: encode_account_ids(&summary.locked_accounts),
            committed_transactions: encode_words(
                summary.committed_transactions.iter().map(TransactionId::as_word),
            ),
        }
    }
}

impl TryFrom<SyncSummaryMessage> for SyncSummary {
    type Error = JsErr;

    fn try_from(message: SyncSummaryMessage) -> Result<Self, Self::Error> {
        let note_ids = |bytes: &[u8]| -> Result<Vec<NoteId>, JsErr> {
            Ok(decode_words(bytes)?.into_iter().map(NoteId::from_raw).collect())
        };

        Ok(SyncSummary::new(
            message.block_num.into(),
            note_ids(&message.new_public_notes)?,
            note_ids(&message.new_private_notes)?,
            note_ids(&message.committed_notes)?,
            note_ids(&message.consumed_notes)?,
            decode_account_ids(&message.updated_accounts)?,
            decode_account_ids(&message.locked_accounts)?,
            decode_words(&message.committed_transactions)?
                .into_iter()
                .map(TransactionId::from_raw)
                .collect(),
        ))
    }
}

/// Decodes a [`SyncSummary`] from the bytes produced by [`SyncSummaryMessage`].
pub fn decode_sync_summary(bytes: &JsBytes) -> Result<SyncSummary, JsErr> {
    SyncSummaryMessage::decode(js_to_bytes(bytes).as_slice())
        .map_err(|err| js_error_with_context(err, SYNC_SUMMARY))?
        .try_into()
}

fn encode_words<'a>(words: impl ExactSizeIterator<Item = Word> + 'a) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(words.len() * Word::SERIALIZED_SIZE);
    for word in words {
        bytes.extend_from_slice(&word.as_bytes());
    }
    bytes
}

fn decode_words(bytes: &[u8]) -> Result<Vec<Word>, JsErr> {
    let (chunks, remainder) = bytes.as_chunks::<{ Word::SERIALIZED_SIZE }>();
    if !remainder.is_empty() {
        return Err(invalid(SYNC_SUMMARY, "word list length is not a multiple of 32 bytes"));
    }
    chunks
        .iter()
        .map(|chunk| Word::try_from(chunk.as_slice()).map_err(with_context(SYNC_SUMMARY)))
        .collect()
}

fn encode_account_ids(ids: &[AccountId]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for id in ids {
        id.write_into(&mut bytes);
    }
    bytes
}

fn decode_account_ids(bytes: &[u8]) -> Result<Vec<AccountId>, JsErr> {
    let mut reader = SliceReader::new(bytes);
    let mut ids = Vec::new();
    while reader.has_more_bytes() {
        ids.push(AccountId::read_from(&mut reader).map_err(with_context(SYNC_SUMMARY))?);
    }
    Ok(ids)
}

#[cfg(all(test, feature = "nodejs"))]
mod tests {
    use alloc::vec;

    use miden_client::block::BlockNumber;
    use miden_protocol::testing::account_id::{
        ACCOUNT_ID_REGULAR_PUBLIC_ACCOUNT_IMMUTABLE_CODE,
        ACCOUNT_ID_SENDER,
    };

    use super::*;

    fn sync_summary() -> SyncSummary {
        let note_id = |seed: u32| NoteId::from_raw(Word::from([seed, 0, 0, 0]));
        SyncSummary::new(
            BlockNumber::from(9u32),
            vec![note_id(1)],
            vec![note_id(2)],
            vec![note_id(3)],
            vec![note_id(4)],
            vec![AccountId::try_from(ACCOUNT_ID_REGULAR_PUBLIC_ACCOUNT_IMMUTABLE_CODE).unwrap()],
            vec![AccountId::try_from(ACCOUNT_ID_SENDER).unwrap()],
            vec![TransactionId::from_raw(Word::from([5u32, 0, 0, 0]))],
        )
    }

    #[test]
    fn sync_summary_round_trips() {
        let summary = sync_summary();
        let bytes = SyncSummaryMessage::from(&summary).encode_to_vec();
        let message = SyncSummaryMessage::decode(bytes.as_slice()).unwrap();
        assert_eq!(SyncSummary::try_from(message).unwrap(), summary);
    }
}
