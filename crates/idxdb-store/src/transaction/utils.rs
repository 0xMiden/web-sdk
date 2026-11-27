use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::AccountId;
use miden_client::store::StoreError;
use miden_client::transaction::{
    LogTopic,
    TransactionLog,
    TransactionLogs,
    TransactionRecord,
    TransactionScript,
};
use miden_client_proto::encode;
use serde::Serialize;
use wasm_bindgen::prelude::wasm_bindgen;

use super::models::TransactionLogIdxdbObject;
use crate::bytes::{FromStoreBytes, ToStoreBytes};

// TYPES
// ================================================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[wasm_bindgen(getter_with_clone)]
pub struct SerializedTransactionData {
    pub id: String,
    #[serde(with = "serde_bytes")]
    pub details: Vec<u8>,
    #[wasm_bindgen(js_name = "scriptRoot")]
    #[serde(with = "serde_bytes")]
    pub script_root: Option<Vec<u8>>,
    #[wasm_bindgen(js_name = "txScript")]
    #[serde(with = "serde_bytes")]
    pub tx_script: Option<Vec<u8>>,
    #[wasm_bindgen(js_name = "blockNum")]
    pub block_num: u32,
    #[wasm_bindgen(js_name = "statusVariant")]
    pub status_variant: u8,
    #[serde(with = "serde_bytes")]
    pub status: Vec<u8>,
}

/// A transaction log as the JS side stores it. The JS side adds the position of the log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SerializedTransactionLog {
    pub emitter: String,
    #[serde(with = "serde_bytes")]
    pub topic: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub content: Vec<u8>,
}

// TRANSACTION LOGS
// ================================================================================================

/// Serializes the logs of a transaction, in emission order. The content of a log is the bytes of
/// its words, one after the other.
pub(crate) fn serialize_transaction_logs(logs: &TransactionLogs) -> Vec<SerializedTransactionLog> {
    logs.iter()
        .map(|log| SerializedTransactionLog {
            emitter: log.emitter().to_hex(),
            topic: log.topic().to_store_bytes(),
            content: log.content().iter().flat_map(ToStoreBytes::to_store_bytes).collect(),
        })
        .collect()
}

/// Builds the logs of a transaction from its stored rows, which are in emission order.
///
/// # Errors
/// - If a row does not decode. The logs of a transaction are returned whole or not at all.
pub(crate) fn transaction_logs_from_idxdb(
    rows: Vec<TransactionLogIdxdbObject>,
) -> Result<TransactionLogs, StoreError> {
    let logs = rows
        .into_iter()
        .map(|row| {
            TransactionLog::new(
                AccountId::from_hex(&row.emitter)?,
                LogTopic::from_store_bytes(&row.topic)?,
                log_content_from_bytes(&row.content)?,
            )
            .map_err(|err| invalid_logs(&err))
        })
        .collect::<Result<Vec<_>, StoreError>>()?;

    TransactionLogs::new(logs).map_err(|err| invalid_logs(&err))
}

fn log_content_from_bytes(bytes: &[u8]) -> Result<Vec<Word>, StoreError> {
    let (words, remainder) = bytes.as_chunks::<{ Word::SERIALIZED_SIZE }>();
    if !remainder.is_empty() {
        return Err(invalid_logs(&format!("log content has {} bytes", bytes.len())));
    }

    words.iter().map(|word| Word::from_store_bytes(word)).collect()
}

fn invalid_logs(err: &impl ToString) -> StoreError {
    StoreError::ParsingError(format!("invalid transaction logs: {}", err.to_string()))
}

/// Serializes the transaction record into a format suitable for storage in the database.
pub(crate) fn serialize_transaction_record(
    transaction_record: &TransactionRecord,
) -> SerializedTransactionData {
    let transaction_id: String = transaction_record.id.as_word().to_hex();

    let script_root =
        transaction_record.script.as_ref().map(|script| script.root().to_store_bytes());
    let tx_script = transaction_record.script.as_ref().map(encode::<TransactionScript>);

    SerializedTransactionData {
        id: transaction_id,
        script_root,
        tx_script,
        details: encode(&transaction_record.details),
        block_num: transaction_record.details.block_num.as_u32(),
        status_variant: transaction_record.status.variant() as u8,
        status: encode(&transaction_record.status),
    }
}
