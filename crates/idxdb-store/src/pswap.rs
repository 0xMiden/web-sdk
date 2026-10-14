//! PSWAP lineage storage over the `settings` object store, encoded as protobuf messages.
//!
//! ```text
//! pswap/order/{order_id_hex}  →  PswapLineageRecord  (stable, never re-keyed)
//! pswap/tip/{tip_note_id}     →  order_id            (index of active tips, re-keyed each round)
//! ```

use alloc::string::String;
use alloc::vec::Vec;

use miden_client::Felt;
use miden_client::note::NoteId;
use miden_client::pswap::{PswapLineageFilter, PswapLineageRecord, PswapLineageState};
use miden_client::store::{SettingMutation, SettingScope, StoreError};
use miden_client_proto::encode;

use crate::IdxdbStore;

const ORDER_PREFIX: &str = "pswap/order/";
const TIP_PREFIX: &str = "pswap/tip/";

fn order_key(order_id: Felt) -> String {
    format!("{ORDER_PREFIX}{:016x}", order_id.as_canonical_u64())
}

fn tip_key(tip: NoteId) -> String {
    format!("{TIP_PREFIX}{}", tip.as_word())
}

impl IdxdbStore {
    pub(crate) async fn get_pswap_lineage(
        &self,
        order_id: Felt,
    ) -> Result<Option<PswapLineageRecord>, StoreError> {
        self.get_client_setting(order_key(order_id)).await
    }

    pub(crate) async fn get_pswap_order_id_by_tip(
        &self,
        tip: NoteId,
    ) -> Result<Option<Felt>, StoreError> {
        self.get_client_setting(tip_key(tip)).await
    }

    pub(crate) async fn get_pswap_lineages(
        &self,
        filter: &PswapLineageFilter,
    ) -> Result<Vec<PswapLineageRecord>, StoreError> {
        let mut lineages = Vec::new();
        for key in self.list_setting_keys(SettingScope::Client).await? {
            if !key.starts_with(ORDER_PREFIX) {
                continue;
            }
            let Some(record) = self.get_client_setting::<PswapLineageRecord>(key).await? else {
                continue;
            };
            if filter.matches(&record) {
                lineages.push(record);
            }
        }
        Ok(lineages)
    }

    /// Writes the record and moves the tip index in one `IndexedDB` transaction. The read of the
    /// previous tip runs before that transaction.
    pub(crate) async fn upsert_pswap_lineage(
        &self,
        record: &PswapLineageRecord,
    ) -> Result<(), StoreError> {
        let order_id = record.order_id();
        let mut mutations = Vec::new();
        // The removal comes first, so a set on the same tip key wins.
        if let Some(previous) = self.get_pswap_lineage(order_id).await? {
            mutations.push(SettingMutation::Remove {
                key: tip_key(previous.current_tip_note_id),
            });
        }
        mutations.push(SettingMutation::Set {
            key: order_key(order_id),
            value: encode(record),
        });
        if record.state == PswapLineageState::Active {
            mutations.push(SettingMutation::Set {
                key: tip_key(record.current_tip_note_id),
                value: encode(&order_id),
            });
        }
        self.apply_settings_mutations(SettingScope::Client, mutations).await
    }
}
