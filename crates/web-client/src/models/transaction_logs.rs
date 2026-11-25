use js_export_macro::js_export;
use miden_protocol::transaction::{
    TransactionLog as NativeTransactionLog,
    TransactionLogs as NativeTransactionLogs,
};

use super::account_id::AccountId;
use super::felt::Felt;
use super::word::Word;

/// A single transaction log emitted by an account during transaction execution.
#[derive(Clone)]
#[js_export]
pub struct TransactionLog(NativeTransactionLog);

#[js_export]
impl TransactionLog {
    /// Returns the account that emitted this log, which may be a foreign account.
    pub fn emitter(&self) -> AccountId {
        self.0.emitter().into()
    }

    /// Returns the prefix field element of the log topic.
    #[js_export(js_name = "topicPrefix")]
    pub fn topic_prefix(&self) -> Felt {
        self.0.topic().prefix().into()
    }

    /// Returns the suffix field element of the log topic.
    #[js_export(js_name = "topicSuffix")]
    pub fn topic_suffix(&self) -> Felt {
        self.0.topic().suffix().into()
    }

    /// Returns the log content words.
    pub fn content(&self) -> Vec<Word> {
        self.0.content().iter().copied().map(Into::into).collect()
    }

    /// Returns the commitment to the log content words.
    #[js_export(js_name = "contentCommitment")]
    pub fn content_commitment(&self) -> Word {
        self.0.content_commitment().into()
    }

    /// Returns the commitment to this transaction log.
    #[js_export(js_name = "toCommitment")]
    pub fn to_commitment(&self) -> Word {
        self.0.to_commitment().into()
    }
}

/// The logs that a transaction emitted, in emission order.
#[derive(Clone)]
#[js_export]
pub struct TransactionLogs(NativeTransactionLogs);

#[js_export]
impl TransactionLogs {
    /// Returns the commitment to the ordered transaction logs.
    pub fn commitment(&self) -> Word {
        self.0.commitment().into()
    }

    /// Returns the number of transaction logs.
    #[js_export(js_name = "numLogs")]
    pub fn num_logs(&self) -> u32 {
        u32::try_from(self.0.num_logs())
            .expect("protocol bounds transaction log count to TransactionLogs::MAX_COUNT")
    }

    /// Returns the total number of content words across all logs, excluding metadata.
    #[js_export(js_name = "numContentWords")]
    pub fn num_content_words(&self) -> u32 {
        u32::try_from(self.0.num_content_words())
            .expect("protocol bounds total content words to TransactionLogs::MAX_NUM_WORDS")
    }

    /// Returns `true` when no transaction logs were emitted.
    #[js_export(js_name = "isEmpty")]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Returns the transaction logs in emission order.
    pub fn logs(&self) -> Vec<TransactionLog> {
        self.0.iter().cloned().map(Into::into).collect()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeTransactionLog> for TransactionLog {
    fn from(log: NativeTransactionLog) -> Self {
        TransactionLog(log)
    }
}

impl From<NativeTransactionLogs> for TransactionLogs {
    fn from(logs: NativeTransactionLogs) -> Self {
        TransactionLogs(logs)
    }
}

impl_napi_from_value!(TransactionLog);
impl_napi_from_value!(TransactionLogs);
