use js_export_macro::js_export;
use miden_client::note::{BlockNumber, NoteDetails, NoteTag};
use miden_client::transaction::{
    TransactionOutcome as NativeTransactionOutcome,
    TransactionStoreUpdate as NativeTransactionStoreUpdate,
};

use crate::models::account_patch::AccountPatch;
use crate::models::executed_transaction::ExecutedTransaction;
use crate::models::output_notes::OutputNotes;
use crate::models::transaction_request::note_details_and_tag::NoteDetailsAndTag;
use crate::models::transaction_result::TransactionResult;

/// Represents the changes that need to be applied to the client store as a result of a transaction
/// execution.
#[derive(Clone)]
#[js_export]
pub struct TransactionStoreUpdate {
    outcome: NativeTransactionOutcome,
    submission_height: BlockNumber,
    future_notes: Vec<(NoteDetails, NoteTag)>,
}

#[js_export]
impl TransactionStoreUpdate {
    /// Builds a store update from a transaction result and its submission height.
    #[js_export(js_name = "fromResult")]
    pub fn from_result(
        result: &TransactionResult,
        submission_height: u32,
    ) -> TransactionStoreUpdate {
        Self {
            outcome: result.outcome().clone(),
            submission_height: BlockNumber::from(submission_height),
            future_notes: result.expected_future_notes().to_vec(),
        }
    }

    /// Returns the executed transaction associated with this update.
    ///
    /// The update does not hold the transaction inputs, so `txArgs()` and `blockHeader()` of the
    /// returned transaction throw.
    #[js_export(js_name = "executedTransaction")]
    pub fn executed_transaction(&self) -> ExecutedTransaction {
        ExecutedTransaction::new(self.outcome.clone(), None)
    }

    /// Returns the block height at which the transaction was submitted.
    #[js_export(js_name = "submissionHeight")]
    pub fn submission_height(&self) -> u32 {
        self.submission_height.as_u32()
    }

    /// Returns the output notes created by the transaction.
    #[js_export(js_name = "createdNotes")]
    pub fn created_notes(&self) -> OutputNotes {
        self.outcome.effects().output_notes().into()
    }

    /// Returns the absolute account patch applied by the transaction.
    #[js_export(js_name = "accountPatch")]
    pub fn account_patch(&self) -> AccountPatch {
        self.outcome.effects().account_patch().into()
    }

    /// Returns notes expected to be created in follow-up executions.
    #[js_export(js_name = "futureNotes")]
    pub fn future_notes(&self) -> Vec<NoteDetailsAndTag> {
        self.future_notes
            .iter()
            .cloned()
            .map(|(details, tag)| NoteDetailsAndTag::new(details.into(), tag.into()))
            .collect()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeTransactionStoreUpdate> for TransactionStoreUpdate {
    fn from(update: NativeTransactionStoreUpdate) -> Self {
        Self {
            outcome: update.transaction().clone(),
            submission_height: update.submission_height(),
            future_notes: update.future_notes().to_vec(),
        }
    }
}

impl From<&NativeTransactionStoreUpdate> for TransactionStoreUpdate {
    fn from(update: &NativeTransactionStoreUpdate) -> Self {
        Self {
            outcome: update.transaction().clone(),
            submission_height: update.submission_height(),
            future_notes: update.future_notes().to_vec(),
        }
    }
}
