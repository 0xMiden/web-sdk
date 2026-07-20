use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
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
use super::account::RootsUpdateMode;
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
        let final_header = executed_tx.final_account();

        if patch.is_full_state() {
            // Full-state patches contain everything needed to reconstruct the new account.
            let account = account_from_full_state_patch(patch, final_header)?;
            apply_full_account_state(self.db_id(), &account).await.map_err(|err| {
                StoreError::DatabaseError(format!("failed to apply full account state: {err:?}"))
            })?;

            let mut smt_forest = self.smt_forest.write();
            smt_forest.insert_and_stage_account_state(
                account.id(),
                account.vault(),
                account.storage(),
            )?;
        } else {
            // Stage the new roots so they are committed or discarded when the transaction is
            // confirmed or dropped during sync.
            self.apply_incremental_account_patch(final_header, patch, RootsUpdateMode::Stage)
                .await?;
        }

        // Updates for notes
        apply_note_updates_tx(self.db_id(), tx_update.note_updates()).await?;

        for tag_record in tx_update.new_tags() {
            self.add_note_tag(*tag_record).await?;
        }

        Ok(())
    }
}
