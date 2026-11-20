use js_export_macro::js_export;
use miden_client::rpc::domain::transaction::{
    TransactionLogsInfo as NativeTransactionLogsInfo,
    TransactionRecord as NativeTransactionRecord,
};

use super::RpcClient;
use crate::js_error_with_context;
use crate::models::account_id::AccountId;
use crate::models::transaction_id::TransactionId;
use crate::models::transaction_logs::TransactionLogs;
use crate::models::word::Word;
use crate::platform::{JsErr, from_str_err};

/// A transaction reported as included by `RpcClient.syncTransactions`.
///
/// Unlike the locally tracked `TransactionRecord`, this record comes directly from the node
/// and has no local status or submission height. Inclusion assumes trust in the RPC node;
/// this response does not independently prove inclusion in the canonical chain.
#[js_export]
pub struct RpcTransactionRecord(NativeTransactionRecord);

#[js_export]
impl RpcTransactionRecord {
    /// Returns the transaction ID. Compare it with the exact ID of the submitted transaction.
    pub fn id(&self) -> TransactionId {
        self.0.transaction_header.id().into()
    }

    /// Returns the account against which the transaction executed.
    #[js_export(js_name = "accountId")]
    pub fn account_id(&self) -> AccountId {
        self.0.transaction_header.account_id().into()
    }

    /// Returns the block in which the node reports the transaction was included.
    #[js_export(js_name = "blockNum")]
    pub fn block_num(&self) -> u32 {
        self.0.block_num.as_u32()
    }
}

/// The logs of a committed transaction as the node reports them, with the position of the
/// transaction in the chain.
///
/// The node holds the logs of a public account. For a private account it holds only the
/// commitment to the logs.
#[js_export]
pub struct TransactionLogsInfo(NativeTransactionLogsInfo);

#[js_export]
impl TransactionLogsInfo {
    /// Returns the ID of the transaction that emitted the logs.
    #[js_export(js_name = "transactionId")]
    pub fn transaction_id(&self) -> TransactionId {
        self.0.transaction_id.into()
    }

    /// Returns the account that executed the transaction.
    #[js_export(js_name = "accountId")]
    pub fn account_id(&self) -> AccountId {
        self.0.account_id.into()
    }

    /// Returns the block in which the transaction was included.
    #[js_export(js_name = "blockNum")]
    pub fn block_num(&self) -> u32 {
        self.0.block_num.as_u32()
    }

    /// Returns the index of the transaction in its block.
    #[js_export(js_name = "transactionIndex")]
    pub fn transaction_index(&self) -> u32 {
        self.0.transaction_index
    }

    /// Returns the commitment to the logs. It is available for public and private accounts.
    #[js_export(js_name = "logsCommitment")]
    pub fn logs_commitment(&self) -> Word {
        self.0.logs_commitment().into()
    }

    /// Returns the logs in emission order, or `undefined` if the node holds only their
    /// commitment, which is the case for a private account.
    pub fn logs(&self) -> Option<TransactionLogs> {
        self.0.logs().cloned().map(Into::into)
    }
}

#[js_export]
impl RpcClient {
    /// Fetches the logs of a committed transaction from the node, through its
    /// `GetTransactionLogs` endpoint.
    ///
    /// The transaction does not have to be tracked by a client, and no local store is read or
    /// updated. For a transaction that a client tracks, `WebClient.getTransactionLogs` returns the
    /// logs from the store without a request, also before the transaction is committed.
    ///
    /// The result relies on trusting the configured RPC node. It does not prove that the
    /// transaction is in the canonical chain.
    ///
    /// @param `account_id` - The account that executed the transaction.
    /// @param `transaction_id` - The transaction that emitted the logs.
    /// @returns A `TransactionLogsInfo`, or `undefined` if the node has no committed transaction
    ///   with this ID for this account. `logs()` is `undefined` for a private account, and
    ///   `logsCommitment()` is always available.
    #[js_export(js_name = "getTransactionLogs")]
    pub async fn get_transaction_logs(
        &self,
        account_id: &AccountId,
        transaction_id: &TransactionId,
    ) -> Result<Option<TransactionLogsInfo>, JsErr> {
        let info = self
            .inner
            .get_transaction_logs(account_id.into(), transaction_id.into())
            .await
            .map_err(|err| js_error_with_context(err, "failed to get transaction logs"))?;

        Ok(info.map(TransactionLogsInfo))
    }

    /// Fetches transactions for the requested accounts within an inclusive block range.
    ///
    /// Uses the Rust RPC client's account-list chunking, pagination and account-ID verification,
    /// returning all matching records across every page. Duplicate account IDs are scanned once.
    /// An empty account list returns an empty array without RPC calls. No local store or tracked
    /// accounts are required or updated.
    ///
    /// The caller must keep `block_to` at or below the node's chain tip, available through
    /// `(await rpc.getBlockHeaderByNumber()).blockNum()`. A reversed range rejects. Callers retain
    /// a polling cursor: after successfully scanning a range, start the next scan at `block_to
    /// + 1`. To confirm a submission, scan from its admission tip and match the exact
    /// transaction ID. Inclusion relies on trusting the configured RPC node; a polling timeout
    /// means unconfirmed, not failed. This method does not wait for future blocks or track
    /// confirmation itself.
    ///
    /// In the browser, this call consumes the `AccountId` wrappers, even if it rejects. Construct
    /// fresh wrappers from saved account ID strings for each array entry, poll or retry.
    ///
    /// @param block_from - First block to scan, inclusive.
    /// @param block_to - Last block to scan, inclusive; must be at least `block_from` and no higher
    ///   than the node's chain tip.
    /// @param account_ids - Accounts whose transactions to fetch.
    /// @returns All matching `RpcTransactionRecord` objects, each with `id()`, `accountId()` and
    ///   `blockNum()` accessors.
    #[allow(clippy::doc_markdown)]
    #[js_export(js_name = "syncTransactions")]
    pub async fn sync_transactions(
        &self,
        block_from: u32,
        block_to: u32,
        account_ids: Vec<AccountId>,
    ) -> Result<Vec<RpcTransactionRecord>, JsErr> {
        if block_from > block_to {
            return Err(from_str_err("block_from must be less than or equal to block_to"));
        }
        let mut account_ids = account_ids.into_iter().map(Into::into).collect::<Vec<_>>();
        account_ids.sort_unstable();
        account_ids.dedup();

        self.inner
            .sync_transactions(block_from.into(), block_to.into(), account_ids)
            .await
            .map_err(|err| js_error_with_context(err, "failed to sync transactions"))
            .and_then(|records| {
                if let Some(record) = records
                    .iter()
                    .find(|record| !(block_from..=block_to).contains(&record.block_num.as_u32()))
                {
                    return Err(from_str_err(&format!(
                        "failed to sync transactions: node returned transaction at block {} outside requested range {block_from}..={block_to}",
                        record.block_num.as_u32()
                    )));
                }

                Ok(records.into_iter().map(RpcTransactionRecord).collect())
            })
    }
}
