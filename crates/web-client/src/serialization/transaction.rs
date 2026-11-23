//! Protobuf message of the transaction result.
//!
//! A transaction result crosses between the main thread and the worker as two parts: the witness
//! that a prover needs, and the outcome that the store records. `miden-objects` defines the message
//! of the witness, and `miden-client-proto` defines the message of the outcome. This module defines
//! only the message that holds the two parts and the future notes.

use alloc::vec::Vec;

use miden_client::account::AccountHeader;
use miden_client::note::{NoteDetails, NoteTag};
use miden_client::transaction::{
    TransactionOutcome,
    TransactionResult as NativeTransactionResult,
    TransactionWitness,
};
use miden_client_proto::ProtobufValue;
use miden_objects::{DecodeMessageExt, proto};
use prost::Message;

use crate::js_error_with_context;
use crate::platform::{JsBytes, JsErr, from_str_err, js_to_bytes};

// MESSAGES
// ================================================================================================

/// A transaction result: the witness to prove the transaction, the outcome that the store records,
/// and the notes that later transactions create from it.
#[derive(Clone, PartialEq, Message)]
pub struct TransactionResultMessage {
    #[prost(message, optional, tag = "1")]
    pub witness: Option<proto::transaction::TransactionWitness>,
    #[prost(message, optional, tag = "2")]
    pub outcome: Option<miden_client_proto::TransactionOutcome>,
    #[prost(message, repeated, tag = "3")]
    pub future_notes: Vec<miden_client_proto::ExpectedFutureNote>,
}

// TRANSACTION RESULT PARTS
// ================================================================================================

/// The parts of a transaction result that cross between the main thread and the worker.
#[derive(Clone, Debug, PartialEq)]
pub struct TransactionResultParts {
    /// The data that a prover needs to prove the transaction.
    pub witness: TransactionWitness,
    /// The parts of the transaction that the store records.
    pub outcome: TransactionOutcome,
    /// The notes that later transactions create from this transaction.
    pub future_notes: Vec<(NoteDetails, NoteTag)>,
}

impl From<&NativeTransactionResult> for TransactionResultParts {
    fn from(result: &NativeTransactionResult) -> Self {
        Self {
            witness: result.witness(),
            outcome: result.outcome(),
            future_notes: result.future_notes().to_vec(),
        }
    }
}

// CONVERSIONS
// ================================================================================================

const TRANSACTION_RESULT: &str = "failed to deserialize TransactionResult";

impl From<&TransactionResultParts> for TransactionResultMessage {
    fn from(parts: &TransactionResultParts) -> Self {
        Self {
            witness: Some((&parts.witness).into()),
            outcome: Some(parts.outcome.to_proto()),
            future_notes: parts.future_notes.iter().map(ProtobufValue::to_proto).collect(),
        }
    }
}

/// The witness is not authenticated against a trusted chain. Decode a transaction result only from
/// a trusted source, such as the worker of this client.
impl TryFrom<TransactionResultMessage> for TransactionResultParts {
    type Error = JsErr;

    fn try_from(message: TransactionResultMessage) -> Result<Self, Self::Error> {
        const CONTEXT: &str = TRANSACTION_RESULT;

        let witness: TransactionWitness = required(message.witness, CONTEXT, "witness")?
            .decode_and_build_unchecked()
            .map_err(with_context(CONTEXT))?;
        let outcome =
            TransactionOutcome::from_proto(required(message.outcome, CONTEXT, "outcome")?)
                .map_err(with_context(CONTEXT))?;
        let future_notes = message
            .future_notes
            .into_iter()
            .map(<(NoteDetails, NoteTag)>::from_proto)
            .collect::<Result<_, _>>()
            .map_err(with_context(CONTEXT))?;

        // A prover proves the witness and the store records the outcome, so the two parts must
        // describe the same transaction.
        let inputs = witness.tx_inputs();
        let effects = outcome.effects();
        let same_transaction = AccountHeader::from(inputs.account()) == *outcome.initial_account()
            && witness.final_account() == outcome.final_account()
            && witness.expiration_block_num() == effects.expiration_block_num()
            && inputs.block_header().commitment() == effects.ref_block_commitment()
            && inputs.input_notes().commitment() == effects.input_notes().commitment();
        if !same_transaction {
            return Err(invalid(
                CONTEXT,
                "the witness and the outcome describe different transactions",
            ));
        }

        Ok(Self { witness, outcome, future_notes })
    }
}

/// Returns a function that adds `context` to a decoding error.
fn with_context<E: core::error::Error + 'static>(context: &'static str) -> impl FnOnce(E) -> JsErr {
    move |err| js_error_with_context(err, context)
}

fn required<T>(field: Option<T>, context: &str, name: &str) -> Result<T, JsErr> {
    field.ok_or_else(|| from_str_err(&alloc::format!("{context}: missing {name}")))
}

fn invalid(context: &str, reason: &str) -> JsErr {
    from_str_err(&alloc::format!("{context}: {reason}"))
}

// BYTES
// ================================================================================================

/// Decodes the message of a transaction result. Use it only for bytes from a trusted source.
pub fn decode_transaction_result(bytes: &JsBytes) -> Result<TransactionResultParts, JsErr> {
    TransactionResultMessage::decode(js_to_bytes(bytes).as_slice())
        .map_err(|err| js_error_with_context(err, TRANSACTION_RESULT))?
        .try_into()
}

// TESTS
// ================================================================================================

#[cfg(all(test, feature = "nodejs"))]
mod tests {
    use alloc::boxed::Box;
    use alloc::vec;

    use miden_client::testing::{Auth, MockChainBuilder, MockTransactionInput};
    use miden_protocol::account::AccountId;
    use miden_protocol::asset::FungibleAsset;
    use miden_protocol::note::NoteType;
    use miden_protocol::testing::account_id::{
        ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET,
        ACCOUNT_ID_SENDER,
    };

    use super::*;

    /// The transaction consumes a P2ID note, and the result expects the same note as a future note.
    #[tokio::test]
    async fn transaction_result_round_trips() {
        let sender_id = AccountId::try_from(ACCOUNT_ID_SENDER).unwrap();
        let faucet_id = AccountId::try_from(ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET).unwrap();
        let asset = FungibleAsset::new(faucet_id, 100).unwrap().into();

        let mut builder = MockChainBuilder::new();
        let account = builder.add_existing_mock_account(Auth::IncrNonce).unwrap();
        let note = builder
            .add_p2id_note(sender_id, account.id(), &[asset], NoteType::Public)
            .unwrap();
        let mut chain = builder.build().unwrap();
        chain.prove_next_block().unwrap();
        let transaction = Box::pin(
            chain
                .build_transaction(MockTransactionInput::Account(account))
                .unauthenticated_input_note(note.clone())
                .build()
                .unwrap()
                .execute(),
        )
        .await
        .unwrap();

        let tag = NoteTag::with_account_target(transaction.account_id());
        let result = NativeTransactionResult::new(transaction, vec![(note.into(), tag)]);
        let parts = TransactionResultParts::from(&result);

        let bytes = TransactionResultMessage::from(&parts).encode_to_vec();
        let message = TransactionResultMessage::decode(bytes.as_slice()).unwrap();
        assert_eq!(TransactionResultParts::try_from(message).unwrap(), parts);
    }
}
