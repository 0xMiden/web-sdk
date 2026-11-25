use alloc::format;
use alloc::string::String;
#[cfg(feature = "sqlite-store")]
use alloc::sync::Arc;
use alloc::vec::Vec;

use idxdb_store::auth::{
    idxdb_get_account_auth_by_pub_key_commitment,
    idxdb_get_account_id_by_key_commitment,
    idxdb_get_key_commitments_by_account_id,
    idxdb_insert_account_auth,
    idxdb_insert_account_key_mapping,
    idxdb_remove_account_auth,
    idxdb_remove_all_mappings_for_key,
};
use serde::{Deserialize, Serialize};
use serde_wasm_bindgen::from_value;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

#[cfg(feature = "sqlite-store")]
use crate::sqlite_keystore_db::SqliteKeystoreDb;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountAuthIdxdbObject {
    pub secret_key: String,
}

/// Where a [`WebKeyStore`](crate::WebKeyStore) keeps its keys and the accounts they belong to.
pub(crate) enum KeystoreDb {
    /// The `accountAuth` and `accountKeyMapping` tables of the `IndexedDB` store named `db_id`,
    /// which the client's store has to hold open.
    Idxdb { db_id: String },
    /// A `SQLite` database of the keystore's own, for a client whose store is `SQLite`. The
    /// clients on one store share it.
    #[cfg(feature = "sqlite-store")]
    Sqlite(Arc<SqliteKeystoreDb>),
}

impl KeystoreDb {
    /// The name of the storage, for an error message about it.
    pub(crate) fn storage_name(&self) -> &'static str {
        match self {
            KeystoreDb::Idxdb { .. } => "IndexedDB",
            #[cfg(feature = "sqlite-store")]
            KeystoreDb::Sqlite(_) => "SQLite",
        }
    }

    pub(crate) async fn insert_account_auth(
        &self,
        pub_key_commitment_hex: String,
        secret_key: String,
    ) -> Result<(), JsValue> {
        match self {
            KeystoreDb::Idxdb { db_id } => {
                let promise = idxdb_insert_account_auth(db_id, pub_key_commitment_hex, secret_key);
                JsFuture::from(promise).await?;
                Ok(())
            },
            #[cfg(feature = "sqlite-store")]
            KeystoreDb::Sqlite(db) => db
                .insert_account_auth(&pub_key_commitment_hex, &secret_key)
                .map_err(|err| JsValue::from_str(&err)),
        }
    }

    /// Returns the secret key stored under `pub_key_commitment_hex`.
    ///
    /// When there is none, the `IndexedDB` tables report an error and the `SQLite` database
    /// returns `None`.
    pub(crate) async fn get_account_auth_by_pub_key_commitment(
        &self,
        pub_key_commitment_hex: String,
    ) -> Result<Option<String>, JsValue> {
        match self {
            KeystoreDb::Idxdb { db_id } => {
                let promise =
                    idxdb_get_account_auth_by_pub_key_commitment(db_id, pub_key_commitment_hex);
                let js_secret_key = JsFuture::from(promise).await?;

                let account_auth_idxdb: Option<AccountAuthIdxdbObject> = from_value(js_secret_key)
                    .map_err(|err| {
                        JsValue::from_str(&format!(
                            "Error: failed to deserialize secret key: {err}"
                        ))
                    })?;

                Ok(account_auth_idxdb.map(|auth| auth.secret_key))
            },
            #[cfg(feature = "sqlite-store")]
            KeystoreDb::Sqlite(db) => db
                .get_account_auth(&pub_key_commitment_hex)
                .map_err(|err| JsValue::from_str(&err)),
        }
    }

    pub(crate) async fn remove_account_auth(
        &self,
        pub_key_commitment_hex: String,
    ) -> Result<(), JsValue> {
        match self {
            KeystoreDb::Idxdb { db_id } => {
                let promise = idxdb_remove_account_auth(db_id, pub_key_commitment_hex);
                JsFuture::from(promise).await?;
                Ok(())
            },
            #[cfg(feature = "sqlite-store")]
            KeystoreDb::Sqlite(db) => db
                .remove_account_auth(&pub_key_commitment_hex)
                .map_err(|err| JsValue::from_str(&err)),
        }
    }

    pub(crate) async fn insert_account_key_mapping(
        &self,
        account_id_hex: String,
        pub_key_commitment_hex: String,
    ) -> Result<(), JsValue> {
        match self {
            KeystoreDb::Idxdb { db_id } => {
                let promise =
                    idxdb_insert_account_key_mapping(db_id, account_id_hex, pub_key_commitment_hex);
                JsFuture::from(promise).await?;
                Ok(())
            },
            #[cfg(feature = "sqlite-store")]
            KeystoreDb::Sqlite(db) => db
                .insert_account_key_mapping(&account_id_hex, &pub_key_commitment_hex)
                .map_err(|err| JsValue::from_str(&err)),
        }
    }

    pub(crate) async fn get_key_commitments_by_account_id(
        &self,
        account_id_hex: String,
    ) -> Result<Vec<String>, JsValue> {
        match self {
            KeystoreDb::Idxdb { db_id } => {
                let promise = idxdb_get_key_commitments_by_account_id(db_id, account_id_hex);
                let js_commitments = JsFuture::from(promise).await?;

                let commitments: Vec<String> = from_value(js_commitments).map_err(|err| {
                    JsValue::from_str(&format!(
                        "Error: failed to deserialize key commitments: {err}"
                    ))
                })?;

                Ok(commitments)
            },
            #[cfg(feature = "sqlite-store")]
            KeystoreDb::Sqlite(db) => db
                .get_key_commitments_by_account_id(&account_id_hex)
                .map_err(|err| JsValue::from_str(&err)),
        }
    }

    pub(crate) async fn remove_all_mappings_for_key(
        &self,
        pub_key_commitment_hex: String,
    ) -> Result<(), JsValue> {
        match self {
            KeystoreDb::Idxdb { db_id } => {
                let promise = idxdb_remove_all_mappings_for_key(db_id, pub_key_commitment_hex);
                JsFuture::from(promise).await?;
                Ok(())
            },
            #[cfg(feature = "sqlite-store")]
            KeystoreDb::Sqlite(db) => db
                .remove_all_mappings_for_key(&pub_key_commitment_hex)
                .map_err(|err| JsValue::from_str(&err)),
        }
    }

    pub(crate) async fn get_account_id_by_key_commitment(
        &self,
        pub_key_commitment_hex: String,
    ) -> Result<Option<String>, JsValue> {
        match self {
            KeystoreDb::Idxdb { db_id } => {
                let promise = idxdb_get_account_id_by_key_commitment(db_id, pub_key_commitment_hex);
                let js_account_id = JsFuture::from(promise).await?;
                Ok(js_account_id.as_string())
            },
            #[cfg(feature = "sqlite-store")]
            KeystoreDb::Sqlite(db) => db
                .get_account_id_by_key_commitment(&pub_key_commitment_hex)
                .map_err(|err| JsValue::from_str(&err)),
        }
    }
}
