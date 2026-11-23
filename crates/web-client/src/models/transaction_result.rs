use js_export_macro::js_export;
use miden_client::note::{NoteDetails, NoteTag};
use miden_client::transaction::{
    TransactionInputs as NativeTransactionInputs,
    TransactionOutcome as NativeTransactionOutcome,
    TransactionResult as NativeTransactionResult,
    TransactionWitness as NativeTransactionWitness,
};

use crate::models::executed_transaction::ExecutedTransaction;
use crate::models::transaction_id::TransactionId;
use crate::models::transaction_request::note_details_and_tag::NoteDetailsAndTag;
use crate::platform::{JsBytes, JsErr};
use crate::serialization::encode_message;
use crate::serialization::transaction::{
    TransactionResultMessage,
    TransactionResultParts,
    decode_transaction_result,
};

/// Represents the result of executing a transaction by the client.
///
/// It contains an `ExecutedTransaction`, and a list of `future_notes`
/// that we expect to receive in the future (you can check at swap notes for an example of this).
///
/// The result holds the transaction as two parts: the witness that a prover needs, and the outcome
/// that the store records. Each step after execution uses one of them, so the result crosses
/// between the main thread and the worker without an encoding of the whole executed transaction.
#[derive(Clone)]
#[js_export]
pub struct TransactionResult(TransactionResultParts);

#[js_export]
impl TransactionResult {
    /// Returns the ID of the transaction.
    pub fn id(&self) -> TransactionId {
        self.0.outcome.id().into()
    }

    /// Returns the executed transaction.
    #[js_export(js_name = "executedTransaction")]
    pub fn executed_transaction(&self) -> ExecutedTransaction {
        ExecutedTransaction::new(self.0.outcome.clone(), Some(self.0.witness.clone()))
    }

    /// Returns notes that are expected to be created as a result of follow-up executions.
    #[js_export(js_name = "futureNotes")]
    pub fn future_notes(&self) -> Vec<NoteDetailsAndTag> {
        self.0
            .future_notes
            .iter()
            .cloned()
            .map(|(note_details, note_tag)| {
                NoteDetailsAndTag::new(note_details.into(), note_tag.into())
            })
            .collect()
    }

    /// Serializes the transaction result into bytes.
    pub fn serialize(&self) -> JsBytes {
        encode_message(&TransactionResultMessage::from(&self.0))
    }

    /// Deserializes a transaction result from bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<TransactionResult, JsErr> {
        decode_transaction_result(&bytes).map(TransactionResult)
    }
}

impl TransactionResult {
    /// Returns the data that a prover needs to prove the transaction.
    pub(crate) fn witness(&self) -> &NativeTransactionWitness {
        &self.0.witness
    }

    /// Returns the parts of the transaction that the store records.
    pub(crate) fn outcome(&self) -> &NativeTransactionOutcome {
        &self.0.outcome
    }

    /// Returns the inputs that the transaction executed with.
    pub(crate) fn tx_inputs(&self) -> &NativeTransactionInputs {
        self.0.witness.tx_inputs()
    }

    /// Returns the notes that later transactions create from this transaction.
    pub(crate) fn expected_future_notes(&self) -> &[(NoteDetails, NoteTag)] {
        &self.0.future_notes
    }
}

impl From<NativeTransactionResult> for TransactionResult {
    fn from(result: NativeTransactionResult) -> Self {
        Self(TransactionResultParts::from(&result))
    }
}
