//! Protobuf messages of the transaction summary and of the signing inputs.
//!
//! The protocol defines no message for [`TransactionSummary`] or [`SigningInputs`], and neither
//! type has a byte encoding of its own. The messages here are owned by this crate. They hold the
//! `miden-objects` message of every part that has one.

use alloc::vec::Vec;

use miden_client::auth::SigningInputs;
use miden_client::transaction::TransactionSummary;
use miden_client::{Felt, Word};
use miden_objects::{DecodeMessage, DecodeMessageExt, proto};
use miden_protocol::account::AccountDelta;
use miden_protocol::transaction::TransactionSummaryUserParams;
use miden_protocol::utils::serde::{ByteReader, Deserializable, Serializable, SliceReader};
use prost::Message;

use crate::js_error_with_context;
use crate::platform::{JsBytes, JsErr, from_str_err, js_to_bytes};

// MESSAGES
// ================================================================================================

/// A transaction summary.
#[derive(Clone, PartialEq, Message)]
pub struct TransactionSummaryMessage {
    /// Byte encoding of the account delta, for which the protocol defines no message.
    #[prost(bytes = "vec", tag = "1")]
    pub account_delta: Vec<u8>,
    #[prost(message, optional, tag = "2")]
    pub input_notes: Option<proto::transaction::InputNotes>,
    #[prost(message, optional, tag = "3")]
    pub output_notes: Option<proto::transaction::RawOutputNotes>,
    /// Reference block of the transaction.
    #[prost(fixed32, tag = "4")]
    pub block_number: u32,
    /// Commitment of the reference block.
    #[prost(message, optional, tag = "5")]
    pub block_commitment: Option<proto::primitives::Word>,
    /// Number of blocks after the reference block at which the transaction expires. Fits in 16
    /// bits.
    #[prost(uint32, tag = "6")]
    pub expiration_delta: u32,
    /// The elements that the user sets in the summary.
    #[prost(message, repeated, tag = "7")]
    pub user_params: Vec<proto::primitives::Felt>,
    #[prost(message, optional, tag = "8")]
    pub logs: Option<proto::transaction::TransactionLogs>,
}

/// The inputs of a signature.
#[derive(Clone, PartialEq, Message)]
pub struct SigningInputsMessage {
    #[prost(oneof = "signing_inputs_message::Inputs", tags = "1, 2, 3")]
    pub inputs: Option<signing_inputs_message::Inputs>,
}

/// A list of field elements.
#[derive(Clone, PartialEq, Message)]
pub struct FeltsMessage {
    #[prost(message, repeated, tag = "1")]
    pub elements: Vec<proto::primitives::Felt>,
}

pub mod signing_inputs_message {
    use miden_objects::proto;

    /// The variants of the signing inputs.
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Inputs {
        #[prost(message, tag = "1")]
        TransactionSummary(super::TransactionSummaryMessage),
        #[prost(message, tag = "2")]
        Arbitrary(super::FeltsMessage),
        #[prost(message, tag = "3")]
        Blind(proto::primitives::Word),
    }
}

// CONVERSIONS
// ================================================================================================

impl From<&TransactionSummary> for TransactionSummaryMessage {
    fn from(summary: &TransactionSummary) -> Self {
        Self {
            account_delta: summary.account_delta().to_bytes(),
            input_notes: Some(summary.input_notes().into()),
            output_notes: Some(summary.output_notes().into()),
            block_number: summary.block_number().as_u32(),
            block_commitment: Some(summary.block_commitment().into()),
            expiration_delta: u32::from(summary.expiration_delta()),
            user_params: summary.user_params().as_elements().iter().map(Into::into).collect(),
            logs: Some(summary.logs().into()),
        }
    }
}

impl TryFrom<TransactionSummaryMessage> for TransactionSummary {
    type Error = JsErr;

    fn try_from(message: TransactionSummaryMessage) -> Result<Self, Self::Error> {
        const CONTEXT: &str = "failed to deserialize TransactionSummary";
        let invalid =
            |err: &dyn core::fmt::Display| from_str_err(&alloc::format!("{CONTEXT}: {err}"));
        let missing = |field: &str| from_str_err(&alloc::format!("{CONTEXT}: missing {field}"));

        // `read_from_bytes` accepts bytes after the value, which the length check on the message
        // cannot see.
        let mut delta_reader = SliceReader::new(&message.account_delta);
        let account_delta = AccountDelta::read_from(&mut delta_reader)
            .map_err(|err| js_error_with_context(err, CONTEXT))?;
        if delta_reader.has_more_bytes() {
            return Err(invalid(&"the account delta has unused bytes"));
        }
        let input_notes = message
            .input_notes
            .ok_or_else(|| missing("input notes"))?
            .decode_and_verify()
            .map_err(|err| js_error_with_context(err, CONTEXT))?;
        let output_notes = message
            .output_notes
            .ok_or_else(|| missing("output notes"))?
            .decode_and_verify()
            .map_err(|err| js_error_with_context(err, CONTEXT))?;
        let block_commitment: Word = message
            .block_commitment
            .ok_or_else(|| missing("block commitment"))?
            .decode_fields()
            .map_err(|err| js_error_with_context(err, CONTEXT))?;
        let expiration_delta = u16::try_from(message.expiration_delta)
            .map_err(|_| invalid(&"the expiration delta does not fit in 16 bits"))?;
        let user_params: [Felt; TransactionSummaryUserParams::NUM_ELEMENTS] =
            decode_felts(message.user_params, CONTEXT)?
                .try_into()
                .map_err(|_| invalid(&"wrong number of user parameters"))?;
        let logs = message
            .logs
            .ok_or_else(|| missing("logs"))?
            .decode_and_verify()
            .map_err(|err| js_error_with_context(err, CONTEXT))?;

        Ok(TransactionSummary::new(
            account_delta,
            input_notes,
            output_notes,
            message.block_number.into(),
            block_commitment,
            expiration_delta,
            TransactionSummaryUserParams::new(user_params),
            logs,
        ))
    }
}

impl From<&SigningInputs> for SigningInputsMessage {
    fn from(inputs: &SigningInputs) -> Self {
        use signing_inputs_message::Inputs;

        let inputs = match inputs {
            SigningInputs::TransactionSummary(summary) => {
                Inputs::TransactionSummary(summary.as_ref().into())
            },
            SigningInputs::Arbitrary(elements) => Inputs::Arbitrary(FeltsMessage {
                elements: elements.iter().map(Into::into).collect(),
            }),
            SigningInputs::Blind(word) => Inputs::Blind(word.into()),
        };
        Self { inputs: Some(inputs) }
    }
}

impl TryFrom<SigningInputsMessage> for SigningInputs {
    type Error = JsErr;

    fn try_from(message: SigningInputsMessage) -> Result<Self, Self::Error> {
        use signing_inputs_message::Inputs;

        const CONTEXT: &str = "failed to deserialize SigningInputs";
        match message.inputs {
            Some(Inputs::TransactionSummary(summary)) => {
                Ok(SigningInputs::TransactionSummary(alloc::boxed::Box::new(summary.try_into()?)))
            },
            Some(Inputs::Arbitrary(felts)) => {
                Ok(SigningInputs::Arbitrary(decode_felts(felts.elements, CONTEXT)?))
            },
            Some(Inputs::Blind(word)) => word
                .decode_fields()
                .map(SigningInputs::Blind)
                .map_err(|err| js_error_with_context(err, CONTEXT)),
            None => Err(from_str_err(&alloc::format!("{CONTEXT}: missing inputs"))),
        }
    }
}

fn decode_felts(felts: Vec<proto::primitives::Felt>, context: &str) -> Result<Vec<Felt>, JsErr> {
    felts
        .into_iter()
        .map(|felt| felt.decode_fields().map_err(|err| js_error_with_context(err, context)))
        .collect()
}

// BYTES
// ================================================================================================

/// Decodes the message of a transaction summary from an untrusted party. Rejects bytes that the
/// message does not use, so a summary and the same summary with extra bytes do not both decode.
pub fn decode_transaction_summary(bytes: &JsBytes) -> Result<TransactionSummary, JsErr> {
    decode_exact::<TransactionSummaryMessage>(
        &js_to_bytes(bytes),
        "failed to deserialize TransactionSummary",
    )?
    .try_into()
}

/// Decodes the message of signing inputs.
pub fn decode_signing_inputs(bytes: &JsBytes) -> Result<SigningInputs, JsErr> {
    decode_exact::<SigningInputsMessage>(
        &js_to_bytes(bytes),
        "failed to deserialize SigningInputs",
    )?
    .try_into()
}

fn decode_exact<M: Message + Default>(bytes: &[u8], context: &str) -> Result<M, JsErr> {
    let message = M::decode(bytes).map_err(|err| js_error_with_context(err, context))?;
    if message.encoded_len() != bytes.len() {
        return Err(from_str_err(&alloc::format!("{context}: the message has unused bytes")));
    }
    Ok(message)
}

// TESTS
// ================================================================================================

#[cfg(all(test, feature = "nodejs"))]
mod tests {
    use miden_protocol::account::{
        AccountCodePatch,
        AccountId,
        AccountStoragePatch,
        AccountVaultDelta,
    };
    use miden_protocol::testing::account_id::ACCOUNT_ID_SENDER;
    use miden_protocol::transaction::{InputNotes, RawOutputNotes, TransactionLogs};

    use super::*;

    fn summary() -> TransactionSummary {
        let account_delta = AccountDelta::new(
            AccountId::try_from(ACCOUNT_ID_SENDER).unwrap(),
            AccountStoragePatch::default(),
            AccountVaultDelta::default(),
            AccountCodePatch::default(),
            Felt::from(1_u32),
        )
        .unwrap();
        let user_params = core::array::from_fn(|index| Felt::from(u32::try_from(index).unwrap()));

        TransactionSummary::new(
            account_delta,
            InputNotes::new(Vec::new()).unwrap(),
            RawOutputNotes::new(Vec::new()).unwrap(),
            42_u32.into(),
            Word::from([1_u32, 2, 3, 4]),
            7,
            TransactionSummaryUserParams::new(user_params),
            TransactionLogs::default(),
        )
    }

    fn summary_bytes() -> Vec<u8> {
        TransactionSummaryMessage::from(&summary()).encode_to_vec()
    }

    fn decode_summary(bytes: &[u8]) -> Result<TransactionSummary, JsErr> {
        decode_exact::<TransactionSummaryMessage>(bytes, "summary")?.try_into()
    }

    fn decode_inputs(bytes: &[u8]) -> Result<SigningInputs, JsErr> {
        decode_exact::<SigningInputsMessage>(bytes, "inputs")?.try_into()
    }

    #[test]
    fn transaction_summary_round_trips() {
        let decoded = decode_summary(&summary_bytes()).unwrap();
        assert_eq!(decoded, summary());
        assert_eq!(decoded.to_commitment(), summary().to_commitment());
    }

    #[test]
    fn transaction_summary_with_unused_bytes_is_rejected() {
        let mut bytes = summary_bytes();
        // Field 15 is not part of the message, so the decoder skips it.
        bytes.extend_from_slice(&[0x78, 0x01]);
        let error = decode_summary(&bytes).unwrap_err();
        assert!(error.reason.contains("the message has unused bytes"), "{}", error.reason);

        // Bytes after the delta stay inside its field, so the message length still matches.
        let mut message = TransactionSummaryMessage::from(&summary());
        message.account_delta.extend_from_slice(&[0xde, 0xad]);
        let error = decode_summary(&message.encode_to_vec()).unwrap_err();
        assert!(error.reason.contains("account delta has unused bytes"), "{}", error.reason);
    }

    #[test]
    fn signing_inputs_round_trip_in_every_variant() {
        let variants = [
            SigningInputs::TransactionSummary(alloc::boxed::Box::new(summary())),
            SigningInputs::Arbitrary(alloc::vec![Felt::from(5_u32), Felt::from(6_u32)]),
            SigningInputs::Arbitrary(Vec::new()),
            SigningInputs::Blind(Word::from([9_u32, 8, 7, 6])),
        ];
        for inputs in variants {
            let bytes = SigningInputsMessage::from(&inputs).encode_to_vec();
            let decoded = decode_inputs(&bytes).unwrap();
            assert_eq!(decoded.to_commitment(), inputs.to_commitment());
            assert_eq!(
                core::mem::discriminant(&decoded),
                core::mem::discriminant(&inputs),
                "the variant must survive, a blind word and one arbitrary word commit alike"
            );
        }
    }

    #[test]
    fn signing_inputs_match_test_vectors() {
        let blind = SigningInputs::Blind(Word::from([1_u32, 2, 3, 4]));
        let blind_bytes = SigningInputsMessage::from(&blind).encode_to_vec();
        // Matches `GiIKIAEAAAAAAAAAAgAAAAAAAAADAAAAAAAAAAQAAAAAAAAA` in
        // crates/web-client/test/key.test.ts.
        let mut expected_blind = alloc::vec![0x1a, 0x22, 0x0a, 0x20];
        for elem in [1_u64, 2, 3, 4] {
            expected_blind.extend_from_slice(&elem.to_le_bytes());
        }
        assert_eq!(blind_bytes, expected_blind);

        let arbitrary = SigningInputs::Arbitrary(alloc::vec![
            Felt::from(5_u32),
            Felt::from(6_u32),
            Felt::from(7_u32),
        ]);
        let arbitrary_bytes = SigningInputsMessage::from(&arbitrary).encode_to_vec();
        // Matches `EiEKCQkFAAAAAAAAAAoJCQYAAAAAAAAACgkJBwAAAAAAAAA=` in
        // crates/web-client/test/key.test.ts.
        let mut expected_arbitrary = alloc::vec![0x12, 0x21];
        for elem in [5_u64, 6, 7] {
            expected_arbitrary.extend_from_slice(&[0x0a, 0x09, 0x09]);
            expected_arbitrary.extend_from_slice(&elem.to_le_bytes());
        }
        assert_eq!(arbitrary_bytes, expected_arbitrary);
    }
}
