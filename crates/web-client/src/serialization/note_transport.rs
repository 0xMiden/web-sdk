//! Protobuf message of [`MockNoteTransportNode`], owned privately by `web-client` for worker
//! and test snapshot round-trips.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use miden_client::block::BlockNumber;
use miden_client::note::{NoteHeader, NoteTag};
use miden_client::note_transport::{NoteInfo, NoteTransportCursor};
use miden_client::testing::note_transport::{MockNoteTransportNode, MockNoteTransportNodeSnapshot};
use miden_objects::{DecodeMessageExt, proto};
use prost::Message;

use super::{required, with_context};
use crate::js_error_with_context;
use crate::platform::JsErr;

const MOCK_NOTE_TRANSPORT_NODE: &str = "failed to decode mock note transport node";

#[derive(Clone, PartialEq, Message)]
struct NoteInfoMessage {
    #[prost(message, optional, tag = "1")]
    header: Option<proto::note::NoteHeader>,
    #[prost(bytes = "vec", tag = "2")]
    details: Vec<u8>,
    #[prost(fixed32, optional, tag = "3")]
    block_hint: Option<u32>,
}

#[derive(Clone, PartialEq, Message)]
struct MockNoteTransportEntryMessage {
    #[prost(message, optional, tag = "1")]
    note: Option<NoteInfoMessage>,
    #[prost(uint64, tag = "2")]
    nonce: u64,
    #[prost(uint64, tag = "3")]
    sequence: u64,
}

#[derive(Clone, PartialEq, Message)]
struct MockNoteTransportTagNotesMessage {
    #[prost(fixed32, tag = "1")]
    tag: u32,
    #[prost(message, repeated, tag = "2")]
    notes: Vec<MockNoteTransportEntryMessage>,
}

#[derive(Clone, PartialEq, Message)]
struct MockNoteTransportNodeMessage {
    #[prost(message, repeated, tag = "1")]
    notes: Vec<MockNoteTransportTagNotesMessage>,
    #[prost(uint64, tag = "2")]
    nonce: u64,
    #[prost(uint64, tag = "3")]
    next_sequence: u64,
}

impl From<&MockNoteTransportNodeSnapshot> for MockNoteTransportNodeMessage {
    fn from(snapshot: &MockNoteTransportNodeSnapshot) -> Self {
        Self {
            notes: snapshot
                .notes
                .iter()
                .map(|(tag, entries)| MockNoteTransportTagNotesMessage {
                    tag: tag.as_u32(),
                    notes: entries
                        .iter()
                        .map(|(info, cursor)| MockNoteTransportEntryMessage {
                            note: Some(NoteInfoMessage {
                                header: Some(info.header.into()),
                                details: info.details_bytes.clone(),
                                block_hint: info.block_hint.as_ref().map(BlockNumber::as_u32),
                            }),
                            nonce: cursor.nonce,
                            sequence: cursor.sequence,
                        })
                        .collect(),
                })
                .collect(),
            nonce: snapshot.nonce,
            next_sequence: snapshot.next_sequence,
        }
    }
}

impl TryFrom<MockNoteTransportNodeMessage> for MockNoteTransportNodeSnapshot {
    type Error = JsErr;

    fn try_from(message: MockNoteTransportNodeMessage) -> Result<Self, Self::Error> {
        let notes = message
            .notes
            .into_iter()
            .map(|tag_notes| {
                let entries = tag_notes
                    .notes
                    .into_iter()
                    .map(|entry| {
                        let note = required(entry.note, MOCK_NOTE_TRANSPORT_NODE, "note")?;
                        let header: NoteHeader =
                            required(note.header, MOCK_NOTE_TRANSPORT_NODE, "header")?
                                .decode_and_verify()
                                .map_err(with_context(MOCK_NOTE_TRANSPORT_NODE))?;
                        let info = NoteInfo {
                            header,
                            details_bytes: note.details,
                            block_hint: note.block_hint.map(Into::into),
                        };
                        let cursor = NoteTransportCursor {
                            nonce: entry.nonce,
                            sequence: entry.sequence,
                        };
                        Ok((info, cursor))
                    })
                    .collect::<Result<Vec<_>, JsErr>>()?;
                Ok((NoteTag::from(tag_notes.tag), entries))
            })
            .collect::<Result<BTreeMap<_, _>, JsErr>>()?;

        Ok(Self {
            notes,
            nonce: message.nonce,
            next_sequence: message.next_sequence,
        })
    }
}

/// Encodes the stored state of `node` into bytes.
pub fn encode_mock_note_transport_node(node: &MockNoteTransportNode) -> Vec<u8> {
    MockNoteTransportNodeMessage::from(&node.snapshot()).encode_to_vec()
}

/// Decodes a [`MockNoteTransportNode`] from bytes produced by [`encode_mock_note_transport_node`].
pub fn decode_mock_note_transport_node(bytes: &[u8]) -> Result<MockNoteTransportNode, JsErr> {
    let message = MockNoteTransportNodeMessage::decode(bytes)
        .map_err(|err| js_error_with_context(err, MOCK_NOTE_TRANSPORT_NODE))?;
    let snapshot = MockNoteTransportNodeSnapshot::try_from(message)?;
    Ok(MockNoteTransportNode::from_snapshot(snapshot))
}

#[cfg(all(test, feature = "nodejs"))]
mod tests {
    use alloc::vec;

    use miden_client::Word;
    use miden_client::account::AccountId;
    use miden_client::asset::FungibleAsset;
    use miden_client::note::{Note, NoteDetails, NoteType, P2idNote};
    use miden_protocol::testing::account_id::{
        ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET,
        ACCOUNT_ID_SENDER,
    };
    use miden_protocol::utils::serde::Serializable;

    use super::*;

    fn test_note(serial: u32) -> Note {
        let faucet_id = AccountId::try_from(ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET).unwrap();
        let account = AccountId::try_from(ACCOUNT_ID_SENDER).unwrap();
        P2idNote::builder()
            .sender(account)
            .target(account)
            .assets(vec![FungibleAsset::new(faucet_id, 100).unwrap()])
            .note_type(NoteType::Private)
            .serial_number(Word::from([serial, 0, 0, 0]))
            .build()
            .unwrap()
            .into()
    }

    #[test]
    fn mock_note_transport_node_round_trips() {
        let mut mock = MockNoteTransportNode::new();
        let note_without_hint = test_note(1);
        let note_with_hint = test_note(2);
        mock.add_note(*note_without_hint.header(), NoteDetails::from(note_without_hint).to_bytes());
        mock.add_note_after(
            *note_with_hint.header(),
            NoteDetails::from(note_with_hint).to_bytes(),
            Some(BlockNumber::from(7u32)),
        );

        let bytes = encode_mock_note_transport_node(&mock);
        let decoded = decode_mock_note_transport_node(&bytes).unwrap();

        let tag = NoteTag::with_account_target(AccountId::try_from(ACCOUNT_ID_SENDER).unwrap());
        let (expected_notes, expected_cursor) = mock.get_notes(&[tag], None);
        let (actual_notes, actual_cursor) = decoded.get_notes(&[tag], None);
        assert_eq!(actual_cursor, expected_cursor);
        assert_eq!(actual_notes.len(), expected_notes.len());
        for (actual, expected) in actual_notes.iter().zip(&expected_notes) {
            assert_eq!(actual.header, expected.header);
            assert_eq!(actual.details_bytes, expected.details_bytes);
            assert_eq!(actual.block_hint, expected.block_hint);
        }
    }
}
