use js_export_macro::js_export;
use miden_client::transaction::TransactionRecord as NativeTransactionRecord;

use super::models::transaction_filter::TransactionFilter;
use super::models::transaction_id::TransactionId;
use super::models::transaction_logs::TransactionLogs;
use super::models::transaction_record::TransactionRecord;
use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    #[js_export(js_name = "getTransactions")]
    pub async fn get_transactions(
        &self,
        transaction_filter: TransactionFilter,
    ) -> Result<Vec<TransactionRecord>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let transaction_records: Vec<NativeTransactionRecord> = client
            .get_transactions(transaction_filter.into())
            .await
            .map_err(|err| js_error_with_context(err, "failed to get transactions"))?;

        Ok(transaction_records.into_iter().map(Into::into).collect())
    }

    /// Returns the logs that a tracked transaction emitted, in emission order.
    ///
    /// The store records the logs when the transaction is applied, so this method does not contact
    /// the node. It resolves to `undefined` if the client does not track the transaction, and to
    /// an empty collection if the transaction emitted no logs.
    ///
    /// The store keeps the logs of a discarded transaction, so this method also returns them. The
    /// network did not apply these logs.
    ///
    /// @param `transaction_id` - The transaction that emitted the logs.
    /// @returns The logs, or `undefined` for a transaction that the client does not track.
    #[js_export(js_name = "getTransactionLogs")]
    pub async fn get_transaction_logs(
        &self,
        transaction_id: &TransactionId,
    ) -> Result<Option<TransactionLogs>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let logs = client
            .get_transaction_logs(transaction_id.into())
            .await
            .map_err(|err| js_error_with_context(err, "failed to get transaction logs"))?;

        Ok(logs.map(Into::into))
    }
}
