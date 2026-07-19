use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::Word;
use miden_client::account::Account;
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
use super::account::utils::{
    apply_account_patch,
    apply_full_account_state,
    compute_storage_patch,
    compute_vault_patch,
    update_tracked_storage_roots,
};
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
        let account_id = executed_tx.account_id();

        if patch.is_full_state() {
            // Full-state patches contain everything needed to reconstruct the new account.
            let account = Account::try_from(patch)?;
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
            // Partial patches carry absolute final values, so only the previous roots of changed
            // maps are needed to update the SMT forest.
            let map_slot_names: Vec<String> =
                patch.storage().maps().map(|(slot_name, _)| slot_name.to_string()).collect();
            let old_map_roots = self.get_storage_map_roots(account_id, map_slot_names).await?;

            let final_header = executed_tx.final_account();

            // Compute storage and vault changes using SMT forest, then stage new roots.
            let (updated_storage_slots, updated_assets, removed_asset_ids) = {
                let mut smt_forest = self.smt_forest.write();

                // Get current tracked roots to build the final roots from
                let mut final_roots = smt_forest
                    .get_roots(&account_id)
                    .cloned()
                    .ok_or(StoreError::AccountDataNotFound(account_id))?;

                // Storage: compute new map roots via SMT forest and update the tracked root list.
                let updated_storage_slots =
                    compute_storage_patch(&mut smt_forest, &old_map_roots, patch)?;
                update_tracked_storage_roots(
                    &mut final_roots,
                    &old_map_roots,
                    &updated_storage_slots,
                )?;

                // Vault patches already contain absolute final asset values.
                let old_vault_root = final_roots[0];
                let (updated_assets, removed_asset_ids) = compute_vault_patch(patch);
                let new_vault_root = smt_forest.update_asset_nodes(
                    old_vault_root,
                    updated_assets.iter().copied(),
                    removed_asset_ids.iter().copied(),
                )?;

                if new_vault_root != final_header.vault_root() {
                    return Err(StoreError::DatabaseError(format!(
                        "computed vault root {} does not match final account header {}",
                        new_vault_root.to_hex(),
                        final_header.vault_root().to_hex(),
                    )));
                }

                // Update vault root in final_roots (first element is always vault root)
                final_roots[0] = new_vault_root;

                // Stage the new roots for later commit/discard during sync
                smt_forest.stage_roots(account_id, final_roots);

                (updated_storage_slots, updated_assets, removed_asset_ids)
            };

            apply_account_patch(
                self.db_id(),
                account_id,
                final_header,
                &updated_storage_slots,
                &updated_assets,
                &removed_asset_ids,
                patch,
            )
            .await
            .map_err(|err| {
                StoreError::DatabaseError(format!("failed to apply transaction patch: {err:?}"))
            })?;
        }

        // Updates for notes
        apply_note_updates_tx(self.db_id(), tx_update.note_updates()).await?;

        for tag_record in tx_update.new_tags() {
            self.add_note_tag(*tag_record).await?;
        }

        Ok(())
    }
}
