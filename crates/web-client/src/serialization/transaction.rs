//! Protobuf messages of the transaction outcome and transaction result.
//!
//! A transaction result crosses between the main thread and the worker as two parts: the witness
//! that a prover needs, and the outcome that the store records. `miden-objects` defines the message
//! of the witness and the fields of the outcome, and this module defines the outcome message and
//! the result message that holds both parts and the future notes.

use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::AccountHeader;
use miden_client::note::{NoteDetails, NoteTag};
use miden_client::transaction::{
    TransactionOutcome,
    TransactionResult as NativeTransactionResult,
    TransactionWitness,
};
use miden_client_proto::ProtobufValue;
use miden_objects::{DecodeMessageExt, proto};
use miden_protocol::transaction::{TransactionEffects, TransactionScript};
use prost::Message;

use super::{invalid, required, with_context};
use crate::js_error_with_context;
use crate::platform::{JsBytes, JsErr, js_to_bytes};

// MESSAGES
// ================================================================================================

/// The parts of an executed transaction that the store records.
#[derive(Clone, PartialEq, Message)]
pub struct TransactionOutcomeMessage {
    #[prost(message, optional, tag = "1")]
    pub effects: Option<proto::transaction::TransactionEffects>,
    #[prost(message, optional, tag = "2")]
    pub initial_account: Option<proto::account::AccountHeader>,
    #[prost(message, optional, tag = "3")]
    pub final_account: Option<proto::account::AccountHeader>,
    #[prost(message, optional, tag = "4")]
    pub tx_script: Option<proto::transaction::TransactionScript>,
}

/// A transaction result: the witness to prove the transaction, the outcome that the store records,
/// and the notes that later transactions create from it.
#[derive(Clone, PartialEq, Message)]
pub struct TransactionResultMessage {
    #[prost(message, optional, tag = "1")]
    pub witness: Option<proto::transaction::TransactionWitness>,
    #[prost(message, optional, tag = "2")]
    pub outcome: Option<TransactionOutcomeMessage>,
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

const TRANSACTION_OUTCOME: &str = "failed to deserialize TransactionOutcome";
const TRANSACTION_RESULT: &str = "failed to deserialize TransactionResult";

impl From<&TransactionOutcome> for TransactionOutcomeMessage {
    fn from(outcome: &TransactionOutcome) -> Self {
        Self {
            effects: Some(outcome.effects().into()),
            initial_account: Some(outcome.initial_account().into()),
            final_account: Some(outcome.final_account().into()),
            tx_script: outcome.tx_script().map(Into::into),
        }
    }
}

impl TryFrom<TransactionOutcomeMessage> for TransactionOutcome {
    type Error = JsErr;

    fn try_from(message: TransactionOutcomeMessage) -> Result<Self, Self::Error> {
        const CONTEXT: &str = TRANSACTION_OUTCOME;

        let effects: TransactionEffects = required(message.effects, CONTEXT, "effects")?
            .decode_and_verify()
            .map_err(with_context(CONTEXT))?;
        let initial_account: AccountHeader =
            required(message.initial_account, CONTEXT, "initial account")?
                .decode_and_verify()
                .map_err(with_context(CONTEXT))?;
        let final_account: AccountHeader =
            required(message.final_account, CONTEXT, "final account")?
                .decode_and_verify()
                .map_err(with_context(CONTEXT))?;
        let tx_script: Option<TransactionScript> = message
            .tx_script
            .map(DecodeMessageExt::decode_and_verify)
            .transpose()
            .map_err(with_context(CONTEXT))?;

        let account_id = effects.account_patch().id();
        if initial_account.id() != account_id || final_account.id() != account_id {
            return Err(invalid(
                CONTEXT,
                "account headers and account patch name different accounts",
            ));
        }
        if final_account.to_commitment() != effects.final_state_commitment() {
            return Err(invalid(
                CONTEXT,
                "final account header does not commit to the final state of the effects",
            ));
        }
        // The effects of a transaction against a new account hold the empty word as the initial
        // state commitment.
        let initial_matches = if effects.initial_state_commitment() == Word::empty() {
            initial_account.nonce().as_canonical_u64() == 0
        } else {
            initial_account.to_commitment() == effects.initial_state_commitment()
        };
        if !initial_matches {
            return Err(invalid(
                CONTEXT,
                "initial account header does not match the initial state of the effects",
            ));
        }

        Ok(TransactionOutcome::new(effects, initial_account, final_account, tx_script))
    }
}

impl From<&TransactionResultParts> for TransactionResultMessage {
    fn from(parts: &TransactionResultParts) -> Self {
        Self {
            witness: Some((&parts.witness).into()),
            outcome: Some((&parts.outcome).into()),
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
        let outcome = TransactionOutcome::try_from(required(message.outcome, CONTEXT, "outcome")?)?;
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

        // Replacing the final account with the initial one breaks the commitment check in
        // TransactionOutcomeMessage::try_from.
        let mut outcome_message = TransactionOutcomeMessage::from(&parts.outcome);
        outcome_message.final_account = outcome_message.initial_account.clone();
        assert!(TransactionOutcome::try_from(outcome_message).is_err());
    }
}
