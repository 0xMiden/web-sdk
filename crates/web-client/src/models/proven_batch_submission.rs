use js_export_macro::js_export;
use miden_client::transaction::ProvenBatchSubmission as NativeProvenBatchSubmission;

use crate::models::transaction_id::TransactionId;

/// An already-proven batch that can be resent after an indeterminate submission.
///
/// Obtained only from a batch submit failure with
/// `code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN"`. Pass it to
/// [`WebClient::retry_proven_batch`](crate::WebClient::retry_proven_batch) to
/// resubmit without executing or proving again. The type has no public
/// constructor: the Rust client builds it inside the submit path.
#[derive(Clone)]
#[js_export]
pub struct ProvenBatchSubmission {
    inner: NativeProvenBatchSubmission,
}

#[js_export]
impl ProvenBatchSubmission {
    /// Number of transactions in the batch.
    #[js_export(js_name = "transactionCount")]
    pub fn transaction_count(&self) -> usize {
        self.inner.transaction_count()
    }

    /// Transaction ids the batch was submitted with. Nothing is recorded for
    /// them until a retry (or the original attempt) is accepted.
    #[js_export(js_name = "transactionIds")]
    pub fn transaction_ids(&self) -> Vec<TransactionId> {
        self.inner.transaction_ids().map(Into::into).collect()
    }
}

impl ProvenBatchSubmission {
    pub(crate) fn from_native(inner: NativeProvenBatchSubmission) -> Self {
        Self { inner }
    }

    pub(crate) fn native(&self) -> &NativeProvenBatchSubmission {
        &self.inner
    }
}

impl From<NativeProvenBatchSubmission> for ProvenBatchSubmission {
    fn from(inner: NativeProvenBatchSubmission) -> Self {
        Self::from_native(inner)
    }
}

impl From<ProvenBatchSubmission> for NativeProvenBatchSubmission {
    fn from(submission: ProvenBatchSubmission) -> Self {
        submission.inner
    }
}
