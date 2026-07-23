use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::AccountHeader;
use miden_client::store::{StoreError, TransactionFilter};
use miden_client::transaction::{
    TransactionDetails,
    TransactionId,
    TransactionRecord,
    TransactionScript,
    TransactionStatus,
    TransactionStoreUpdate,
};
use miden_client::utils::Deserializable;

use super::IdxdbStore;
use super::account::utils::{account_from_full_state_patch, apply_full_account_state};
use super::note::utils::apply_note_updates_tx;
use crate::promise::await_js;

mod js_bindings;
use js_bindings::idxdb_get_transactions;

mod models;
use models::TransactionIdxdbObject;

pub mod utils;
use utils::insert_proven_transaction_data;

impl IdxdbStore {
    pub async fn get_transactions(
        &self,
        filter: TransactionFilter,
    ) -> Result<Vec<TransactionRecord>, StoreError> {
        let filter_as_str = match filter {
            TransactionFilter::All => "All",
            TransactionFilter::Uncommitted => "Uncommitted",
            TransactionFilter::Ids(ids) => &{
                let ids_str =
                    ids.iter().map(ToString::to_string).collect::<Vec<String>>().join(",");
                format!("Ids:{ids_str}")
            },
            TransactionFilter::ExpiredBefore(block_number) => {
                &format!("ExpiredPending:{block_number}")
            },
        };

        let promise = idxdb_get_transactions(self.db_id(), filter_as_str.to_string());
        let transactions_idxdb: Vec<TransactionIdxdbObject> =
            await_js(promise, "failed to get transactions").await?;

        let transaction_records: Result<Vec<TransactionRecord>, StoreError> = transactions_idxdb
            .into_iter()
            .map(|tx_idxdb| {
                let id: Word = tx_idxdb.id.try_into()?;

                let details = TransactionDetails::read_from_bytes(&tx_idxdb.details)?;

                let script: Option<TransactionScript> = if tx_idxdb.script_root.is_some() {
                    let tx_script = tx_idxdb
                        .tx_script
                        .map(|script| TransactionScript::read_from_bytes(&script))
                        .transpose()?
                        .ok_or(StoreError::DatabaseError(
                            "transaction script missing from store despite script_root being set"
                                .into(),
                        ))?;

                    Some(tx_script)
                } else {
                    None
                };

                let status = TransactionStatus::read_from_bytes(&tx_idxdb.status)?;

                Ok(TransactionRecord {
                    id: TransactionId::from_raw(id),
                    details,
                    script,
                    status,
                })
            })
            .collect();

        transaction_records
    }

    pub async fn apply_transaction(
        &self,
        tx_update: TransactionStoreUpdate,
    ) -> Result<(), StoreError> {
        let executed_tx = tx_update.executed_transaction();

        // Transaction Data
        insert_proven_transaction_data(self.db_id(), executed_tx, tx_update.submission_height())
            .await?;

        let patch = executed_tx.account_patch();
        let init_header: AccountHeader = executed_tx.initial_account().into();
        let final_header = executed_tx.final_account();

        if patch.is_full_state() {
            // Full-state patches contain everything needed to reconstruct the new account. The
            // write transaction pins the transaction's initial commitment, so a competing
            // transaction from the same base state cannot silently overwrite this one.
            let account = account_from_full_state_patch(patch, final_header)?;
            let expected_initial_commitment = init_header.to_commitment().to_string();
            let mut attempt = 0;
            loop {
                attempt += 1;
                let forest_update = self
                    .compute_account_reset_update(account.id(), account.vault(), account.storage())
                    .await?;
                let result = apply_full_account_state(
                    self.db_id(),
                    &account,
                    forest_update,
                    Some(expected_initial_commitment.clone()),
                )
                .await
                .map_err(|err| {
                    StoreError::DatabaseError(format!(
                        "failed to apply full account state: {err:?}"
                    ))
                });
                match result {
                    Err(err)
                        if attempt < crate::forest::MAX_FOREST_ATTEMPTS
                            && crate::forest::is_forest_conflict(&err) => {},
                    result => break result?,
                }
            }
        } else {
            self.apply_incremental_account_patch(&init_header, final_header, patch).await?;
        }

        // Updates for notes
        apply_note_updates_tx(self.db_id(), tx_update.note_updates()).await?;

        for tag_record in tx_update.new_tags() {
            self.add_note_tag(*tag_record).await?;
        }

        Ok(())
    }
}
