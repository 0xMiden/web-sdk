use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::account::{AccountId, AccountIdError};
use miden_client::block::AccountWitness;
use miden_client::store::StoreError;
use miden_client_proto::{decode_unchecked, encode};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen_futures::js_sys;

use super::super::IdxdbStore;
use crate::promise::{await_js, await_js_value};

#[wasm_bindgen(module = "/src/js/witnesses.js")]
extern "C" {
    #[wasm_bindgen(js_name = trackAccountWitness)]
    fn idxdb_track_account_witness(db_id: &str, account_id: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = untrackAccountWitness)]
    fn idxdb_untrack_account_witness(db_id: &str, account_id: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = trackedAccountWitnesses)]
    fn idxdb_tracked_account_witnesses(db_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_name = getAccountWitness)]
    fn idxdb_get_account_witness(db_id: &str, account_id: String) -> js_sys::Promise;

    #[wasm_bindgen(js_name = updateAccountWitness)]
    fn idxdb_update_account_witness(
        db_id: &str,
        account_id: String,
        witness: Vec<u8>,
    ) -> js_sys::Promise;
}

impl IdxdbStore {
    pub(crate) async fn track_account_witness(
        &self,
        account_id: AccountId,
    ) -> Result<bool, StoreError> {
        let promise = idxdb_track_account_witness(self.db_id(), account_id.to_string());
        await_js(promise, "failed to track account witness").await
    }

    pub(crate) async fn untrack_account_witness(
        &self,
        account_id: AccountId,
    ) -> Result<bool, StoreError> {
        let promise = idxdb_untrack_account_witness(self.db_id(), account_id.to_string());
        await_js(promise, "failed to untrack account witness").await
    }

    pub(crate) async fn tracked_account_witnesses(&self) -> Result<Vec<AccountId>, StoreError> {
        let promise = idxdb_tracked_account_witnesses(self.db_id());
        let ids: Vec<String> = await_js(promise, "failed to list account witnesses").await?;
        let ids = ids
            .into_iter()
            .map(|id| AccountId::from_hex(&id))
            .collect::<Result<Vec<_>, AccountIdError>>()?;
        Ok(ids)
    }

    pub(crate) async fn get_account_witness(
        &self,
        account_id: AccountId,
    ) -> Result<Option<AccountWitness>, StoreError> {
        let promise = idxdb_get_account_witness(self.db_id(), account_id.to_string());
        let value = await_js_value(promise, "failed to get account witness").await?;
        if value.is_null() || value.is_undefined() {
            return Ok(None);
        }
        // Witness bytes are a Uint8Array column. serde would treat that as a
        // sequence of numbers, which is not how the other byte columns are read.
        if !value.is_instance_of::<js_sys::Uint8Array>() {
            return Err(StoreError::DatabaseError("account witness was not a byte array".into()));
        }
        let bytes = js_sys::Uint8Array::new(&value).to_vec();
        Ok(Some(decode_unchecked::<AccountWitness>(&bytes)?))
    }

    pub(crate) async fn update_account_witness(
        &self,
        account_id: AccountId,
        witness: &AccountWitness,
    ) -> Result<bool, StoreError> {
        let promise =
            idxdb_update_account_witness(self.db_id(), account_id.to_string(), encode(witness));
        await_js(promise, "failed to update account witness").await
    }
}
