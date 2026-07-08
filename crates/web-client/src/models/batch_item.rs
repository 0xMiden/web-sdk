use js_export_macro::js_export;

use crate::models::account_id::AccountId;
use crate::models::transaction_request::TransactionRequest;

/// A single (account, request) pair to be executed in a transaction batch.
///
/// Used as the element type of `WebClient::submit_new_transaction_batch`'s input — keeping the
/// account id and its transaction request together at the type level removes the mismatched-arrays
/// failure mode parallel `Vec`s would have.
#[derive(Clone)]
#[js_export]
pub struct BatchItem {
    account_id: AccountId,
    request: TransactionRequest,
}

#[js_export]
impl BatchItem {
    /// Creates a new (account, request) pair for a transaction batch.
    #[js_export(constructor)]
    pub fn new(account_id: &AccountId, request: &TransactionRequest) -> BatchItem {
        BatchItem {
            account_id: *account_id,
            request: request.clone(),
        }
    }
}

impl BatchItem {
    pub(crate) fn account_id(&self) -> &AccountId {
        &self.account_id
    }

    pub(crate) fn request(&self) -> &TransactionRequest {
        &self.request
    }
}

impl_napi_from_value!(BatchItem);
