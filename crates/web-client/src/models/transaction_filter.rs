use alloc::vec::Vec;

use js_export_macro::js_export;
use miden_client::account::AccountId as NativeAccountId;
use miden_client::store::TransactionFilter as NativeTransactionFilter;
use miden_client::transaction::{
    TransactionId as NativeTransactionId,
    TransactionRecord as NativeTransactionRecord,
    TransactionStatusVariant,
};

use super::transaction_id::TransactionId;
use crate::platform::{JsErr, from_str_err};

/// Filter used when querying stored transactions.
#[derive(Clone)]
#[js_export]
pub struct TransactionFilter {
    native: NativeTransactionFilter,
    query: Option<TransactionQuery>,
}

/// The criteria of [`TransactionFilter::query`]; `None` matches every transaction.
#[derive(Clone)]
struct TransactionQuery {
    account_id: Option<NativeAccountId>,
    /// A `TransactionStatusVariant` discriminant, which has no `PartialEq` to compare by.
    status: Option<u8>,
    limit: Option<u32>,
}

#[js_export]
impl TransactionFilter {
    /// Matches all transactions.
    pub fn all() -> TransactionFilter {
        TransactionFilter::native(NativeTransactionFilter::All)
    }

    /// Matches specific transaction IDs.
    pub fn ids(ids: Vec<TransactionId>) -> TransactionFilter {
        let native_transaction_ids: Vec<NativeTransactionId> =
            ids.into_iter().map(Into::into).collect();
        TransactionFilter::native(NativeTransactionFilter::Ids(native_transaction_ids))
    }

    /// Matches transactions that are not yet committed.
    pub fn uncommitted() -> TransactionFilter {
        TransactionFilter::native(NativeTransactionFilter::Uncommitted)
    }

    /// Matches the transactions executed by `account_id` (hex) in `status` (`"pending"`,
    /// `"committed"` or `"discarded"`), newest first, keeping at most `limit` of them. An omitted
    /// criterion matches every transaction.
    pub fn query(
        account_id: Option<String>,
        status: Option<String>,
        limit: Option<u32>,
    ) -> Result<TransactionFilter, JsErr> {
        let account_id = account_id
            .map(|hex| {
                NativeAccountId::from_hex(&hex)
                    .map_err(|err| from_str_err(&format!("Invalid account ID: {err}")))
            })
            .transpose()?;
        let status = status
            .map(|status| match status.as_str() {
                "pending" => Ok(TransactionStatusVariant::Pending as u8),
                "committed" => Ok(TransactionStatusVariant::Committed as u8),
                "discarded" => Ok(TransactionStatusVariant::Discarded as u8),
                other => Err(from_str_err(&format!("Unknown transaction status: {other}"))),
            })
            .transpose()?;
        // A pending query reads the store's indexed pending rows instead of the whole history.
        let native = if status == Some(TransactionStatusVariant::Pending as u8) {
            NativeTransactionFilter::Uncommitted
        } else {
            NativeTransactionFilter::All
        };
        Ok(TransactionFilter {
            native,
            query: Some(TransactionQuery { account_id, status, limit }),
        })
    }
}

impl TransactionFilter {
    fn native(native: NativeTransactionFilter) -> TransactionFilter {
        TransactionFilter { native, query: None }
    }

    /// Applies a [`TransactionFilter::query`] to the records the store returned; any other
    /// filter was already applied by the store.
    ///
    /// Mirrors the upstream store's transaction query: the account, status and limit are
    /// applied to decoded records, ordered by creation time, newest first, with the transaction
    /// ID breaking a tie.
    pub(crate) fn select(
        &self,
        records: Vec<NativeTransactionRecord>,
    ) -> Vec<NativeTransactionRecord> {
        let Some(query) = &self.query else { return records };
        let records = records
            .into_iter()
            .filter(|record| query.account_id.is_none_or(|id| record.details.account_id == id))
            .filter(|record| {
                query.status.is_none_or(|status| record.status.variant() as u8 == status)
            })
            .collect();
        crate::bounded::newest_first(
            records,
            |record| (record.details.creation_timestamp, record.id.to_hex()),
            query.limit,
        )
    }
}

// CONVERSIONS
// ================================================================================================

impl From<TransactionFilter> for NativeTransactionFilter {
    fn from(filter: TransactionFilter) -> Self {
        filter.native
    }
}

impl From<&TransactionFilter> for NativeTransactionFilter {
    fn from(filter: &TransactionFilter) -> Self {
        filter.native.clone()
    }
}

impl_napi_from_value!(TransactionFilter);
