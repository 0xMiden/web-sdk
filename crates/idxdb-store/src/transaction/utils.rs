use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::AccountId;
use miden_client::note::{BlockNumber, ToInputNoteCommitments};
use miden_client::store::StoreError;
use miden_client::transaction::{
    ExecutedTransaction,
    LogTopic,
    TransactionDetails,
    TransactionLog,
    TransactionLogs,
    TransactionRecord,
    TransactionScript,
    TransactionStatus,
};
use miden_client_proto::encode;
use serde::Serialize;
use wasm_bindgen::prelude::wasm_bindgen;

use super::js_bindings::{
    idxdb_insert_transaction_logs,
    idxdb_insert_transaction_script,
    idxdb_upsert_transaction_record,
};
use super::models::TransactionLogIdxdbObject;
use crate::bytes::{FromStoreBytes, ToStoreBytes};
use crate::promise::await_ok;

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

// ================================================================================================

/// Converts an `ExecutedTransaction` into a pending `TransactionRecord`.
/// `submission_height` is the block number at which the transaction was submitted to the network.
pub(crate) fn build_transaction_record(
    executed_transaction: &ExecutedTransaction,
    submission_height: BlockNumber,
) -> TransactionRecord {
    let nullifiers: Vec<Word> = executed_transaction
        .input_notes()
        .iter()
        .map(|x| x.nullifier().as_word())
        .collect();

    let output_notes = executed_transaction.output_notes();

    let details = TransactionDetails {
        account_id: executed_transaction.account_id(),
        init_account_state: executed_transaction.initial_account().initial_commitment(),
        final_account_state: executed_transaction.final_account().to_commitment(),
        input_note_nullifiers: nullifiers,
        output_notes: output_notes.clone(),
        block_num: executed_transaction.block_header().block_num(),
        submission_height,
        expiration_block_num: executed_transaction.expiration_block_num(),
        creation_timestamp: crate::current_timestamp_u64(),
    };

    TransactionRecord::new(
        executed_transaction.id(),
        details,
        executed_transaction.tx_args().tx_script().cloned(),
        TransactionStatus::Pending,
    )
}

/// Converts an `ExecutedTransaction` into a `TransactionRecord` and inserts it into the store,
/// with the logs that the transaction emitted.
/// `submission_height` is the block number at which the transaction was submitted to the network.
pub async fn insert_proven_transaction_data(
    db_id: &str,
    executed_transaction: &ExecutedTransaction,
    submission_height: BlockNumber,
) -> Result<(), StoreError> {
    let transaction_record = build_transaction_record(executed_transaction, submission_height);

    upsert_transaction_record(db_id, &transaction_record).await?;

    let logs =
        serde_wasm_bindgen::to_value(&serialize_transaction_logs(executed_transaction.logs()))
            .map_err(|err| StoreError::DatabaseError(format!("serialization error: {err}")))?;
    let promise =
        idxdb_insert_transaction_logs(db_id, transaction_record.id.as_word().to_hex(), logs);
    await_ok(promise, "failed to insert transaction logs").await?;

    Ok(())
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

/// Updates the transaction record in the database, inserting it if it doesn't exist.
pub(crate) async fn upsert_transaction_record(
    db_id: &str,
    transaction: &TransactionRecord,
) -> Result<(), StoreError> {
    let serialized_data = serialize_transaction_record(transaction);

    if let Some(root) = serialized_data.script_root.clone() {
        let promise = idxdb_insert_transaction_script(db_id, root, serialized_data.tx_script);
        await_ok(promise, "failed to insert script").await?;
    }

    let promise = idxdb_upsert_transaction_record(
        db_id,
        serialized_data.id,
        serialized_data.details,
        serialized_data.block_num,
        serialized_data.status_variant,
        serialized_data.status,
        serialized_data.script_root,
    );
    await_ok(promise, "failed to insert transaction data").await?;

    Ok(())
}
