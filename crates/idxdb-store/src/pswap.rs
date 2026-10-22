//! PSWAP lineage storage in the `pswapLineages` object store.
//!
//! The `record` field holds the lineage record as a protobuf message. The other fields repeat the
//! record fields that the queries filter on. The order id is the zero-padded hex of its `u64`
//! value, because a `u64` does not fit in a JavaScript number.

use alloc::string::String;
use alloc::vec::Vec;

use base64::Engine;
use base64::engine::general_purpose;
use miden_client::Felt;
use miden_client::note::NoteId;
use miden_client::pswap::{PswapLineageFilter, PswapLineageRecord};
use miden_client::store::StoreError;
use miden_client::utils::DeserializationError;
use miden_client_proto::{decode_unchecked, encode};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::js_sys;

use crate::IdxdbStore;
use crate::promise::{await_js, await_js_value};

#[wasm_bindgen(module = "/src/js/pswap.js")]
extern "C" {
    #[wasm_bindgen(js_name = getPswapLineage)]
    fn idxdb_get_pswap_lineage(db_id: &str, order_id: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = getPswapOrderIdByTip)]
    fn idxdb_get_pswap_order_id_by_tip(db_id: &str, tip: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = getPswapLineages)]
    fn idxdb_get_pswap_lineages(
        db_id: &str,
        active_only: bool,
        creator_account_id: Option<String>,
    ) -> js_sys::Promise;

    #[wasm_bindgen(js_name = upsertPswapLineage)]
    fn idxdb_upsert_pswap_lineage(
        db_id: &str,
        order_id: String,
        creator_account_id: String,
        current_tip_note_id: String,
        state: u8,
        record: Vec<u8>,
    ) -> js_sys::Promise;
}

fn order_id_key(order_id: Felt) -> String {
    format!("{:016x}", order_id.as_canonical_u64())
}

fn decode_record(record: &str) -> Result<PswapLineageRecord, StoreError> {
    let bytes = general_purpose::STANDARD.decode(record).map_err(|err| {
        StoreError::DataDeserializationError(DeserializationError::InvalidValue(err.to_string()))
    })?;
    Ok(decode_unchecked(&bytes)?)
}

impl IdxdbStore {
    pub(crate) async fn get_pswap_lineage(
        &self,
        order_id: Felt,
    ) -> Result<Option<PswapLineageRecord>, StoreError> {
        let promise = idxdb_get_pswap_lineage(self.db_id(), order_id_key(order_id));
        let record: Option<String> = await_js(promise, "failed to get PSWAP lineage").await?;
        record.as_deref().map(decode_record).transpose()
    }

    pub(crate) async fn get_pswap_order_id_by_tip(
        &self,
        tip: NoteId,
    ) -> Result<Option<Felt>, StoreError> {
        let promise = idxdb_get_pswap_order_id_by_tip(self.db_id(), tip.to_hex());
        let order_id: Option<String> =
            await_js(promise, "failed to get PSWAP order id by tip").await?;
        order_id
            .map(|order_id| {
                let value = u64::from_str_radix(&order_id, 16).map_err(|err| {
                    StoreError::ParsingError(format!("stored order id is not hex: {err}"))
                })?;
                Felt::new(value).map_err(|err| {
                    StoreError::ParsingError(format!("stored order id is not a valid Felt: {err}"))
                })
            })
            .transpose()
    }

    pub(crate) async fn get_pswap_lineages(
        &self,
        filter: &PswapLineageFilter,
    ) -> Result<Vec<PswapLineageRecord>, StoreError> {
        let (active_only, creator) = match filter {
            PswapLineageFilter::All => (false, None),
            PswapLineageFilter::Active => (true, None),
            PswapLineageFilter::ByCreator(creator) => (false, Some(creator.to_hex())),
        };
        let promise = idxdb_get_pswap_lineages(self.db_id(), active_only, creator);
        let records: Vec<String> = await_js(promise, "failed to get PSWAP lineages").await?;
        records.iter().map(|record| decode_record(record)).collect()
    }

    /// Inserts the record, or replaces the stored record of the same order. The store rejects an
    /// active record whose tip is the tip of another active lineage.
    pub(crate) async fn upsert_pswap_lineage(
        &self,
        record: &PswapLineageRecord,
    ) -> Result<(), StoreError> {
        let promise = idxdb_upsert_pswap_lineage(
            self.db_id(),
            order_id_key(record.order_id()),
            record.creator_account_id().to_hex(),
            record.current_tip_note_id.to_hex(),
            record.state.as_u8(),
            encode(record),
        );
        await_js_value(promise, "failed to upsert PSWAP lineage").await?;
        Ok(())
    }
}
