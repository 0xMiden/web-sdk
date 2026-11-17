//! Protobuf messages of the transaction result and of the transaction store update.
//!
//! The protocol defines no message for [`ExecutedTransaction`], and the type has no byte encoding
//! of its own. The messages here are owned by this crate. They hold the `miden-objects` message of
//! every protocol part that has one, and the `miden-client-proto` message of every client record.

use alloc::vec::Vec;

use miden_client::sync::NoteTagRecord;
use miden_client::transaction::{TransactionResult, TransactionStoreUpdate};
use miden_client_core::store::{
    InputNoteRecord,
    InputNoteUpdate,
    NoteUpdateType,
    NoteUpdates,
    OutputNoteRecord,
    OutputNoteUpdate,
};
use miden_client_proto::ProtobufValue;
use miden_objects::{DecodeMessageExt, proto};
use miden_protocol::account::{AccountHeader, AccountPatch};
use miden_protocol::block::BlockNumber;
use miden_protocol::note::{NoteDetails, NoteTag};
use miden_protocol::transaction::{
    ExecutedTransaction,
    TransactionInputs,
    TransactionMeasurements,
    TransactionOutputs,
};
use miden_protocol::utils::serde::{Deserializable, Serializable};
use prost::Message;

use crate::js_error_with_context;
use crate::platform::{JsBytes, JsErr, from_str_err, js_to_bytes};

// MESSAGES
// ================================================================================================

/// A transaction that the client executed, with the inputs to execute it again.
#[derive(Clone, PartialEq, Message)]
pub struct ExecutedTransactionMessage {
    #[prost(message, optional, tag = "1")]
    pub inputs: Option<proto::transaction::TransactionInputs>,
    /// Header of the account after the transaction.
    #[prost(message, optional, tag = "2")]
    pub final_account: Option<proto::account::AccountHeader>,
    #[prost(message, optional, tag = "3")]
    pub output_notes: Option<proto::transaction::RawOutputNotes>,
    /// Block at which the transaction expires.
    #[prost(message, optional, tag = "4")]
    pub expiration_block_num: Option<proto::blockchain::BlockNumber>,
    #[prost(message, optional, tag = "5")]
    pub logs: Option<proto::transaction::TransactionLogs>,
    #[prost(message, optional, tag = "6")]
    pub code_patch: Option<proto::transaction::CodePatch>,
    /// Changes that the transaction makes to the account. The decoder computes the commitment to
    /// the patch from this field.
    #[prost(message, optional, tag = "7")]
    pub account_patch: Option<proto::account::AccountPatch>,
    /// Byte encoding of the cycle counts, for which the protocol defines no message.
    #[prost(bytes = "vec", tag = "8")]
    pub measurements: Vec<u8>,
}

/// An executed transaction with the notes that later transactions create from it.
#[derive(Clone, PartialEq, Message)]
pub struct TransactionResultMessage {
    #[prost(message, optional, tag = "1")]
    pub executed_transaction: Option<ExecutedTransactionMessage>,
    #[prost(message, repeated, tag = "2")]
    pub future_notes: Vec<miden_client_proto::ExpectedFutureNote>,
}

/// Store changes that an executed transaction makes.
#[derive(Clone, PartialEq, Message)]
pub struct TransactionStoreUpdateMessage {
    #[prost(message, optional, tag = "1")]
    pub executed_transaction: Option<ExecutedTransactionMessage>,
    /// Block at which the transaction was submitted.
    #[prost(message, optional, tag = "2")]
    pub submission_height: Option<proto::blockchain::BlockNumber>,
    #[prost(message, repeated, tag = "3")]
    pub future_notes: Vec<miden_client_proto::ExpectedFutureNote>,
    #[prost(message, repeated, tag = "4")]
    pub input_notes: Vec<InputNoteUpdateMessage>,
    #[prost(message, repeated, tag = "5")]
    pub output_notes: Vec<OutputNoteUpdateMessage>,
    #[prost(message, repeated, tag = "6")]
    pub new_tags: Vec<miden_client_proto::NoteTagRecord>,
}

/// How the store writes a note record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum NoteUpdateTypeMessage {
    /// The type is absent. The decoder rejects a value with this type.
    Unspecified = 0,
    /// The note is new.
    Insert = 1,
    /// The note is tracked already.
    Update = 2,
    /// A tracked expected note is committed now.
    InsertCommitted = 3,
}

/// An input note record to write, and how to write it.
#[derive(Clone, PartialEq, Message)]
pub struct InputNoteUpdateMessage {
    #[prost(message, optional, tag = "1")]
    pub note: Option<miden_client_proto::InputNoteRecord>,
    #[prost(enumeration = "NoteUpdateTypeMessage", tag = "2")]
    pub update_type: i32,
}

/// An output note record to write, and how to write it.
#[derive(Clone, PartialEq, Message)]
pub struct OutputNoteUpdateMessage {
    #[prost(message, optional, tag = "1")]
    pub note: Option<miden_client_proto::OutputNoteRecord>,
    #[prost(enumeration = "NoteUpdateTypeMessage", tag = "2")]
    pub update_type: i32,
}

// CONVERSIONS
// ================================================================================================

const EXECUTED_TRANSACTION: &str = "failed to deserialize ExecutedTransaction";
const TRANSACTION_RESULT: &str = "failed to deserialize TransactionResult";
const TRANSACTION_STORE_UPDATE: &str = "failed to deserialize TransactionStoreUpdate";

impl From<&ExecutedTransaction> for ExecutedTransactionMessage {
    fn from(transaction: &ExecutedTransaction) -> Self {
        Self {
            inputs: Some(transaction.tx_inputs().into()),
            final_account: Some(transaction.final_account().into()),
            output_notes: Some(transaction.output_notes().into()),
            expiration_block_num: Some(transaction.expiration_block_num().into()),
            logs: Some(transaction.logs().into()),
            code_patch: Some(transaction.code_patch().into()),
            account_patch: Some(transaction.account_patch().into()),
            measurements: transaction.measurements().to_bytes(),
        }
    }
}

/// The transaction inputs are not authenticated against a trusted chain. Decode an executed
/// transaction only from a trusted source, such as the worker of this client.
impl TryFrom<ExecutedTransactionMessage> for ExecutedTransaction {
    type Error = JsErr;

    fn try_from(message: ExecutedTransactionMessage) -> Result<Self, Self::Error> {
        const CONTEXT: &str = EXECUTED_TRANSACTION;

        let tx_inputs: TransactionInputs = required(message.inputs, CONTEXT, "inputs")?
            .decode_and_build_unchecked()
            .map_err(with_context(CONTEXT))?;
        let final_account: AccountHeader =
            required(message.final_account, CONTEXT, "final account")?
                .decode_and_verify()
                .map_err(with_context(CONTEXT))?;
        let output_notes = required(message.output_notes, CONTEXT, "output notes")?
            .decode_and_verify()
            .map_err(with_context(CONTEXT))?;
        let expiration_block_num: BlockNumber =
            required(message.expiration_block_num, CONTEXT, "expiration block number")?
                .decode_and_verify()
                .map_err(with_context(CONTEXT))?;
        let logs = required(message.logs, CONTEXT, "logs")?
            .decode_and_verify()
            .map_err(with_context(CONTEXT))?;
        let code_patch = required(message.code_patch, CONTEXT, "code patch")?
            .decode_and_verify()
            .map_err(with_context(CONTEXT))?;
        let account_patch: AccountPatch =
            required(message.account_patch, CONTEXT, "account patch")?
                .decode_and_verify()
                .map_err(with_context(CONTEXT))?;
        let measurements = TransactionMeasurements::read_from_bytes(&message.measurements)
            .map_err(with_context(CONTEXT))?;

        // `ExecutedTransaction::new` panics on this mismatch.
        if tx_inputs.account().id() != final_account.id() {
            return Err(invalid(
                CONTEXT,
                "transaction inputs and transaction outputs name different accounts",
            ));
        }
        if account_patch.id() != final_account.id() {
            return Err(invalid(
                CONTEXT,
                "account patch and transaction outputs name different accounts",
            ));
        }

        // The transaction executor accepts a transaction only if the kernel commits to the patch
        // that the host built. The commitment of the patch is thus the commitment of the outputs.
        let tx_outputs = TransactionOutputs::new(
            final_account,
            account_patch.to_commitment(),
            output_notes,
            expiration_block_num,
            logs,
            code_patch,
        );

        Ok(ExecutedTransaction::new(tx_inputs, tx_outputs, account_patch, measurements))
    }
}

impl From<&TransactionResult> for TransactionResultMessage {
    fn from(result: &TransactionResult) -> Self {
        Self {
            executed_transaction: Some(result.executed_transaction().into()),
            future_notes: result.future_notes().iter().map(ProtobufValue::to_proto).collect(),
        }
    }
}

impl TryFrom<TransactionResultMessage> for TransactionResult {
    type Error = JsErr;

    fn try_from(message: TransactionResultMessage) -> Result<Self, Self::Error> {
        let executed_transaction =
            required(message.executed_transaction, TRANSACTION_RESULT, "executed transaction")?
                .try_into()?;
        let future_notes = decode_future_notes(message.future_notes, TRANSACTION_RESULT)?;

        Ok(TransactionResult::new(executed_transaction, future_notes))
    }
}

impl From<&TransactionStoreUpdate> for TransactionStoreUpdateMessage {
    fn from(update: &TransactionStoreUpdate) -> Self {
        let note_updates = update.note_updates();
        Self {
            executed_transaction: Some(update.executed_transaction().into()),
            submission_height: Some(update.submission_height().into()),
            future_notes: update.future_notes().iter().map(ProtobufValue::to_proto).collect(),
            input_notes: note_updates
                .input_notes()
                .iter()
                .map(|note_update| InputNoteUpdateMessage {
                    note: Some(note_update.inner().to_proto()),
                    update_type: NoteUpdateTypeMessage::from(*note_update.update_type()).into(),
                })
                .collect(),
            output_notes: note_updates
                .output_notes()
                .iter()
                .map(|note_update| OutputNoteUpdateMessage {
                    note: Some(note_update.inner().to_proto()),
                    update_type: NoteUpdateTypeMessage::from(*note_update.update_type()).into(),
                })
                .collect(),
            new_tags: update.new_tags().iter().map(ProtobufValue::to_proto).collect(),
        }
    }
}

impl TryFrom<TransactionStoreUpdateMessage> for TransactionStoreUpdate {
    type Error = JsErr;

    fn try_from(message: TransactionStoreUpdateMessage) -> Result<Self, Self::Error> {
        const CONTEXT: &str = TRANSACTION_STORE_UPDATE;

        let executed_transaction =
            required(message.executed_transaction, CONTEXT, "executed transaction")?.try_into()?;
        let submission_height: BlockNumber =
            required(message.submission_height, CONTEXT, "submission height")?
                .decode_and_verify()
                .map_err(with_context(CONTEXT))?;
        let future_notes = decode_future_notes(message.future_notes, CONTEXT)?;
        let input_notes = message
            .input_notes
            .into_iter()
            .map(|note_update| {
                let note = required(note_update.note, CONTEXT, "input note record")?;
                Ok(InputNoteUpdate::new(
                    InputNoteRecord::from_proto(note).map_err(with_context(CONTEXT))?,
                    note_update_type(note_update.update_type)?,
                ))
            })
            .collect::<Result<_, JsErr>>()?;
        let output_notes = message
            .output_notes
            .into_iter()
            .map(|note_update| {
                let note = required(note_update.note, CONTEXT, "output note record")?;
                Ok(OutputNoteUpdate::new(
                    OutputNoteRecord::from_proto(note).map_err(with_context(CONTEXT))?,
                    note_update_type(note_update.update_type)?,
                ))
            })
            .collect::<Result<_, JsErr>>()?;
        let new_tags = message
            .new_tags
            .into_iter()
            .map(NoteTagRecord::from_proto)
            .collect::<Result<_, _>>()
            .map_err(with_context(CONTEXT))?;

        Ok(TransactionStoreUpdate::new(
            executed_transaction,
            submission_height,
            NoteUpdates::new(input_notes, output_notes),
            future_notes,
            new_tags,
        ))
    }
}

impl From<NoteUpdateType> for NoteUpdateTypeMessage {
    fn from(update_type: NoteUpdateType) -> Self {
        match update_type {
            NoteUpdateType::Insert => Self::Insert,
            NoteUpdateType::Update => Self::Update,
            NoteUpdateType::InsertCommitted => Self::InsertCommitted,
        }
    }
}

/// Decodes the update type of a note record. The unspecified value and unknown values are
/// rejected, because the type sets how the store writes the note.
fn note_update_type(value: i32) -> Result<NoteUpdateType, JsErr> {
    match NoteUpdateTypeMessage::try_from(value) {
        Ok(NoteUpdateTypeMessage::Insert) => Ok(NoteUpdateType::Insert),
        Ok(NoteUpdateTypeMessage::Update) => Ok(NoteUpdateType::Update),
        Ok(NoteUpdateTypeMessage::InsertCommitted) => Ok(NoteUpdateType::InsertCommitted),
        Ok(NoteUpdateTypeMessage::Unspecified) => {
            Err(invalid(TRANSACTION_STORE_UPDATE, "the note update type is unspecified"))
        },
        Err(_) => Err(invalid(TRANSACTION_STORE_UPDATE, "the note update type is unknown")),
    }
}

fn decode_future_notes(
    notes: Vec<miden_client_proto::ExpectedFutureNote>,
    context: &'static str,
) -> Result<Vec<(NoteDetails, NoteTag)>, JsErr> {
    notes
        .into_iter()
        .map(<(NoteDetails, NoteTag)>::from_proto)
        .collect::<Result<_, _>>()
        .map_err(with_context(context))
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
pub fn decode_transaction_result(bytes: &JsBytes) -> Result<TransactionResult, JsErr> {
    TransactionResultMessage::decode(js_to_bytes(bytes).as_slice())
        .map_err(|err| js_error_with_context(err, TRANSACTION_RESULT))?
        .try_into()
}

/// Decodes the message of a transaction store update. Use it only for bytes from a trusted source.
pub fn decode_transaction_store_update(bytes: &JsBytes) -> Result<TransactionStoreUpdate, JsErr> {
    TransactionStoreUpdateMessage::decode(js_to_bytes(bytes).as_slice())
        .map_err(|err| js_error_with_context(err, TRANSACTION_STORE_UPDATE))?
        .try_into()
}

// TESTS
// ================================================================================================

#[cfg(all(test, feature = "nodejs"))]
mod tests {
    use alloc::boxed::Box;
    use alloc::vec;

    use miden_client::sync::NoteTagSource;
    use miden_client::testing::{Auth, MockChainBuilder, MockTransactionInput};
    use miden_protocol::Word;
    use miden_protocol::account::AccountId;
    use miden_protocol::asset::FungibleAsset;
    use miden_protocol::note::{Note, NoteType};
    use miden_protocol::testing::account_id::{
        ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET,
        ACCOUNT_ID_SENDER,
    };

    use super::*;

    /// Executes a transaction that consumes a P2ID note, and returns the transaction and the note.
    async fn executed_transaction() -> (ExecutedTransaction, Note) {
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

        (transaction, note)
    }

    #[tokio::test]
    async fn transaction_result_round_trips() {
        let (transaction, note) = executed_transaction().await;
        let tag = NoteTag::with_account_target(transaction.account_id());
        let result = TransactionResult::new(transaction, vec![(note.into(), tag)]);

        let bytes = TransactionResultMessage::from(&result).encode_to_vec();
        let message = TransactionResultMessage::decode(bytes.as_slice()).unwrap();
        assert_eq!(TransactionResult::try_from(message).unwrap(), result);
    }

    /// The update has every note update type, an output note and every tag source.
    #[tokio::test]
    async fn transaction_store_update_round_trips() {
        let (transaction, note) = executed_transaction().await;
        let account_id = transaction.account_id();
        let input_record = InputNoteRecord::from(note.clone());
        let output_record = OutputNoteRecord::from_full_note(note.clone(), BlockNumber::from(9u32));
        let note_updates = NoteUpdates::new(
            vec![
                InputNoteUpdate::new(input_record.clone(), NoteUpdateType::Insert),
                InputNoteUpdate::new(input_record.clone(), NoteUpdateType::Update),
                InputNoteUpdate::new(input_record, NoteUpdateType::InsertCommitted),
            ],
            vec![OutputNoteUpdate::new(output_record, NoteUpdateType::Insert)],
        );
        let tag = NoteTag::with_account_target(account_id);
        let new_tags = vec![
            NoteTagRecord::with_note_source(tag, note.details_commitment()),
            NoteTagRecord::with_account_source(tag, account_id),
            NoteTagRecord { tag, source: NoteTagSource::User },
            NoteTagRecord {
                tag,
                source: NoteTagSource::Subscription(Word::from([3u32; 4])),
            },
        ];
        let update = TransactionStoreUpdate::new(
            transaction,
            BlockNumber::from(42u32),
            note_updates,
            vec![(note.into(), tag)],
            new_tags,
        );

        let bytes = TransactionStoreUpdateMessage::from(&update).encode_to_vec();
        let message = TransactionStoreUpdateMessage::decode(bytes.as_slice()).unwrap();
        assert_eq!(TransactionStoreUpdate::try_from(message).unwrap(), update);
    }
}
