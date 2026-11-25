//! Opening the store a browser client keeps its state in, together with the database its keystore
//! keeps keys in.

use alloc::sync::Arc;

use idxdb_store::IdxdbStore;
use miden_client::store::Store;
use wasm_bindgen::prelude::*;

use crate::idxdb_store_init_error;
use crate::platform::from_str_err;
use crate::web_keystore_db::KeystoreDb;

// STORE BACKEND
// ================================================================================================

/// Which storage a browser client keeps its store and its keys in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StoreBackend {
    /// `IndexedDB`.
    IndexedDb,
    /// `SQLite` databases in the origin private file system (OPFS).
    Sqlite,
}

impl StoreBackend {
    /// The name `IndexedDB` is selected by.
    const INDEXED_DB: &'static str = "indexeddb";
    /// The name `SQLite` is selected by.
    const SQLITE: &'static str = "sqlite";

    /// Parses the store backend argument of the client constructors. `None` is `IndexedDB`.
    ///
    /// # Errors
    ///
    /// Returns an error if `value` names no backend.
    pub(crate) fn parse(value: Option<&str>) -> Result<Self, JsValue> {
        match value {
            None | Some(Self::INDEXED_DB) => Ok(Self::IndexedDb),
            Some(Self::SQLITE) => Ok(Self::Sqlite),
            Some(other) => Err(from_str_err(&format!(
                "Unknown store backend \"{other}\": expected \"{}\" or \"{}\"",
                Self::INDEXED_DB,
                Self::SQLITE
            ))),
        }
    }
}

/// Opens the store named `store_name` in `backend`, and the database the keystore of the same
/// client keeps its keys in.
pub(crate) async fn open_store(
    store_name: &str,
    backend: StoreBackend,
) -> Result<(Arc<dyn Store>, KeystoreDb), JsValue> {
    match backend {
        StoreBackend::IndexedDb => {
            let store = IdxdbStore::new(store_name.into())
                .await
                .map_err(|err| idxdb_store_init_error(&err))?;
            Ok((Arc::new(store), KeystoreDb::Idxdb { db_id: store_name.into() }))
        },
        StoreBackend::Sqlite => {
            #[cfg(feature = "sqlite-store")]
            {
                sqlite::open(store_name).await
            }
            #[cfg(not(feature = "sqlite-store"))]
            {
                Err(sqlite_store_unavailable())
            }
        },
    }
}

/// The error of a call that needs the `SQLite` store in a build that has none.
#[cfg(not(feature = "sqlite-store"))]
fn sqlite_store_unavailable() -> JsValue {
    from_str_err(
        "This build of the SDK has no SQLite store. The SQLite store is part of the \
         multi-threaded build.",
    )
}

// SQLITE STORE DUMPS
// ================================================================================================

/// Exports the `SQLite` store named `store_name` as the bytes of its two database files: `store`,
/// the store itself, and `keystore`, the keys and the accounts they belong to.
///
/// Use together with [`import_sqlite_store`]. Like a client on the store, it has to run in a
/// dedicated Web Worker, and it can run while clients of that worker have the store open.
///
/// # Errors
/// Fails if this build has no `SQLite` store, if the store does not exist, or if its files cannot
/// be opened.
#[wasm_bindgen(
    js_name = "exportSqliteStore",
    unchecked_return_type = "{ store: Uint8Array; keystore: Uint8Array }"
)]
#[cfg_attr(
    not(feature = "sqlite-store"),
    allow(clippy::unused_async, reason = "returns a promise in every build")
)]
pub async fn export_sqlite_store(store_name: String) -> Result<JsValue, JsValue> {
    #[cfg(feature = "sqlite-store")]
    {
        let (store, keystore) = sqlite::export(&store_name).await?;
        let dump = js_sys::Object::new();
        for (key, bytes) in [("store", store), ("keystore", keystore)] {
            js_sys::Reflect::set(
                &dump,
                &JsValue::from_str(key),
                &js_sys::Uint8Array::from(bytes.as_slice()),
            )?;
        }
        Ok(dump.into())
    }
    #[cfg(not(feature = "sqlite-store"))]
    {
        let _ = store_name;
        Err(sqlite_store_unavailable())
    }
}

/// Replaces the `SQLite` store named `store_name` with the two database files
/// [`export_sqlite_store`] returned, creating the store if it does not exist.
///
/// The files are checked by opening them as a client would, which also brings a store exported by
/// an older client up to date. If they do not open, the store is left as it was.
///
/// # Errors
/// Fails if this build has no `SQLite` store, if a client of this worker has the store open, or if
/// the files are not a store this client can open.
#[wasm_bindgen(js_name = "importSqliteStore")]
#[cfg_attr(
    not(feature = "sqlite-store"),
    allow(clippy::unused_async, reason = "returns a promise in every build")
)]
pub async fn import_sqlite_store(
    store_name: String,
    store: Vec<u8>,
    keystore: Vec<u8>,
) -> Result<(), JsValue> {
    #[cfg(feature = "sqlite-store")]
    {
        sqlite::import(&store_name, &store, &keystore).await
    }
    #[cfg(not(feature = "sqlite-store"))]
    {
        let _ = (store_name, store, keystore);
        Err(sqlite_store_unavailable())
    }
}

// SQLITE
// ================================================================================================

#[cfg(feature = "sqlite-store")]
mod sqlite {
    use alloc::sync::{Arc, Weak};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;

    use miden_client::store::Store;
    use miden_client_sqlite_store::SqliteStore;
    use sqlite_wasm_rs::WasmOsCallback;
    use sqlite_wasm_vfs::sahpool::{self, OpfsSAHError, OpfsSAHPoolCfgBuilder, OpfsSAHPoolUtil};
    use wasm_bindgen::JsValue;

    use crate::js_error_message;
    use crate::platform::from_str_err;
    use crate::sqlite_keystore_db::SqliteKeystoreDb;
    use crate::web_keystore_db::KeystoreDb;

    /// The OPFS directory that holds the `SQLite` files of every client of the origin.
    const OPFS_DIRECTORY: &str = "miden-client-sqlite";

    /// The name the OPFS file system is registered under with `SQLite`.
    const VFS_NAME: &str = "miden-opfs";

    /// The files one client can have open at a time: its store database, its keystore database,
    /// and the rollback journal of each.
    const FILES_PER_CLIENT: u32 = 4;

    /// The two databases of one `SQLite` store, as the clients on it share them.
    struct OpenDatabases {
        store: Weak<SqliteStore>,
        keystore_db: Weak<SqliteKeystoreDb>,
    }

    thread_local! {
        /// The databases of the `SQLite` stores that clients on this thread have open, by store
        /// name.
        ///
        /// The OPFS file system is not built for a database that is open more than once, so every
        /// client on a store shares one connection to each of its two databases. A connection runs
        /// one query at a time to completion, so the clients cannot interleave inside one.
        static OPEN_DATABASES: RefCell<HashMap<String, OpenDatabases>> =
            RefCell::new(HashMap::new());
    }

    /// The path of the store database of the store named `store_name` in the OPFS file system.
    fn store_path(store_name: &str) -> String {
        format!("/{store_name}.sqlite3")
    }

    /// The path of the keystore database of the store named `store_name` in the OPFS file system.
    fn keystore_path(store_name: &str) -> String {
        format!("/{store_name}.keystore.sqlite3")
    }

    /// Registers the OPFS file system with `SQLite` as the default one, and returns the tool that
    /// manages its files. Installing it again returns the file system that is already registered.
    ///
    /// Being the default is what makes `SqliteStore` and the keystore database, which open their
    /// files through the default file system, use it.
    async fn install_file_system() -> Result<OpfsSAHPoolUtil, JsValue> {
        let config = OpfsSAHPoolCfgBuilder::new()
            .vfs_name(VFS_NAME)
            .directory(OPFS_DIRECTORY)
            .initial_capacity(FILES_PER_CLIENT)
            .build();

        sahpool::install::<WasmOsCallback>(&config, true)
            .await
            .map_err(|err| opfs_error(&err))
    }

    /// Returns the databases a live client on this thread has open for the store named
    /// `store_name`, each as `None` if no client holds it any more.
    fn open_databases(
        store_name: &str,
    ) -> (Option<Arc<SqliteStore>>, Option<Arc<SqliteKeystoreDb>>) {
        OPEN_DATABASES.with_borrow(|open| {
            open.get(store_name).map_or((None, None), |databases| {
                (databases.store.upgrade(), databases.keystore_db.upgrade())
            })
        })
    }

    /// Opens the `SQLite` store named `store_name` and the keystore database beside it, both in
    /// OPFS, or joins the connections a live client on this thread already has to them.
    ///
    /// The OPFS file system holds its files through synchronous access handles, which are
    /// exclusive and which only a dedicated worker can open. So this fails outside a dedicated
    /// worker, and while another worker or tab of the origin holds the files.
    pub(super) async fn open(store_name: &str) -> Result<(Arc<dyn Store>, KeystoreDb), JsValue> {
        let pool = install_file_system().await?;

        let (store, keystore_db) = open_databases(store_name);
        if store.is_none() || keystore_db.is_none() {
            // The file system only holds as many files as it has capacity for, so make room for
            // the files of this store beside the ones that are already there.
            pool.reserve_minimum_capacity(pool.count() + FILES_PER_CLIENT)
                .await
                .map_err(|err| opfs_error(&err))?;
        }

        let store = match store {
            Some(store) => store,
            None => {
                Arc::new(SqliteStore::new(PathBuf::from(store_path(store_name))).await.map_err(
                    |err| from_str_err(&format!("Failed to initialize SqliteStore: {err}")),
                )?)
            },
        };
        let keystore_db = match keystore_db {
            Some(keystore_db) => keystore_db,
            None => {
                Arc::new(SqliteKeystoreDb::open(&keystore_path(store_name)).map_err(|err| {
                    from_str_err(&format!("Failed to initialize the SQLite keystore: {err}"))
                })?)
            },
        };

        // Another client may have opened the store while this one waited above. Its connections
        // win, and the ones opened here close when they are dropped.
        let (store, keystore_db) = match open_databases(store_name) {
            (Some(store), Some(keystore_db)) => (store, keystore_db),
            (opened_store, opened_keystore_db) => {
                let store = opened_store.unwrap_or(store);
                let keystore_db = opened_keystore_db.unwrap_or(keystore_db);
                OPEN_DATABASES.with_borrow_mut(|open| {
                    open.retain(|_, databases| {
                        databases.store.strong_count() > 0
                            || databases.keystore_db.strong_count() > 0
                    });
                    open.insert(
                        store_name.to_string(),
                        OpenDatabases {
                            store: Arc::downgrade(&store),
                            keystore_db: Arc::downgrade(&keystore_db),
                        },
                    );
                });
                (store, keystore_db)
            },
        };

        Ok((store, KeystoreDb::Sqlite(keystore_db)))
    }

    /// Opens the two databases of the store named `store_name` the way a client does, and closes
    /// them again.
    ///
    /// Opening a database makes `SQLite` finish a write that was cut short, checks that the file
    /// is a store this client can open, and brings its schema up to date.
    async fn open_and_close(store_name: &str) -> Result<(), JsValue> {
        SqliteStore::new(PathBuf::from(store_path(store_name)))
            .await
            .map_err(|err| from_str_err(&format!("Failed to initialize SqliteStore: {err}")))?;
        SqliteKeystoreDb::open(&keystore_path(store_name)).map_err(|err| {
            from_str_err(&format!("Failed to initialize the SQLite keystore: {err}"))
        })?;
        Ok(())
    }

    /// Returns the bytes of the store database and of the keystore database of the store named
    /// `store_name`.
    pub(super) async fn export(store_name: &str) -> Result<(Vec<u8>, Vec<u8>), JsValue> {
        let pool = install_file_system().await?;

        let store_path = store_path(store_name);
        if !pool.exists(&store_path).map_err(|err| opfs_error(&err))? {
            return Err(from_str_err(&format!(
                "Failed to export the SQLite store: there is no store named \"{store_name}\""
            )));
        }

        // The files are read as they are, so no write may be half done in them. A client that has
        // a database open has already settled it; a database nobody has open is opened once here.
        let (store, keystore_db) = open_databases(store_name);
        if store.is_none() || keystore_db.is_none() {
            pool.reserve_minimum_capacity(pool.count() + FILES_PER_CLIENT)
                .await
                .map_err(|err| opfs_error(&err))?;
            if store.is_none() && keystore_db.is_none() {
                open_and_close(store_name).await?;
            }
        }

        let read = |path: &str| {
            pool.export_db(path)
                .map_err(|err| from_str_err(&format!("Failed to export the SQLite store: {err}")))
        };
        Ok((read(&store_path)?, read(&keystore_path(store_name))?))
    }

    /// The error of an import that failed for the reason `err`.
    fn import_error(err: &dyn core::fmt::Display) -> JsValue {
        from_str_err(&format!("Failed to import the SQLite store: {err}"))
    }

    /// Removes the database at `path` from the OPFS file system, with the rollback journal that
    /// may be left beside it.
    fn remove_database(pool: &OpfsSAHPoolUtil, path: &str) -> Result<(), JsValue> {
        pool.delete_db(&format!("{path}-journal")).map_err(|err| import_error(&err))?;
        pool.delete_db(path).map_err(|err| import_error(&err))?;
        Ok(())
    }

    /// Makes the file system write the database at `path` through to disk.
    ///
    /// An imported database is written without `SQLite`, which is what asks the file system to
    /// flush a file. Setting the schema version to the value it has is a write that changes
    /// nothing, and committing it flushes the file.
    fn flush_database(path: &str) -> rusqlite::Result<()> {
        let conn = rusqlite::Connection::open(path)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        conn.pragma_update(None, "user_version", version)
    }

    /// Replaces the two databases of the store named `store_name` with `store` and `keystore_db`,
    /// or puts back what was there if the new databases do not open.
    pub(super) async fn import(
        store_name: &str,
        store: &[u8],
        keystore_db: &[u8],
    ) -> Result<(), JsValue> {
        let pool = install_file_system().await?;

        let (open_store, open_keystore_db) = open_databases(store_name);
        if open_store.is_some() || open_keystore_db.is_some() {
            return Err(from_str_err(&format!(
                "Failed to import the SQLite store: a client has the store \"{store_name}\" open. \
                 Terminate it first."
            )));
        }

        pool.reserve_minimum_capacity(pool.count() + FILES_PER_CLIENT)
            .await
            .map_err(|err| opfs_error(&err))?;

        let paths = [store_path(store_name), keystore_path(store_name)];

        // What is there now, to put back if the new databases do not open.
        let mut previous = Vec::with_capacity(paths.len());
        for path in &paths {
            let bytes = if pool.exists(path).map_err(|err| opfs_error(&err))? {
                Some(pool.export_db(path).map_err(|err| import_error(&err))?)
            } else {
                None
            };
            previous.push(bytes);
        }

        let mut imported = Ok(());
        for (path, bytes) in paths.iter().zip([store, keystore_db]) {
            imported = remove_database(&pool, path)
                .and_then(|()| pool.import_db(path, bytes).map_err(|err| import_error(&err)));
            if imported.is_err() {
                break;
            }
        }
        if imported.is_ok() {
            imported = open_and_close(store_name).await;
        }
        if imported.is_ok() {
            imported = paths
                .iter()
                .try_for_each(|path| flush_database(path))
                .map_err(|err| import_error(&err));
        }

        let Err(err) = imported else {
            return Ok(());
        };

        // Put back what was there. The bytes were read from databases that opened, so they are
        // written back unchecked.
        for (path, bytes) in paths.iter().zip(previous) {
            remove_database(&pool, path)?;
            if let Some(bytes) = bytes {
                pool.import_db_unchecked(path, &bytes).map_err(|err| import_error(&err))?;
            }
        }
        Err(err)
    }

    /// The error a client constructor reports when the OPFS file system fails to open, carrying
    /// the reason the browser gave.
    fn opfs_error(err: &OpfsSAHError) -> JsValue {
        let cause = match err {
            OpfsSAHError::NotSupported => {
                return from_str_err(
                    "Failed to open the SQLite store: its files are kept in OPFS through \
                     synchronous access handles, which only a dedicated Web Worker can open. \
                     Create the client inside a dedicated worker.",
                );
            },
            OpfsSAHError::GetDirHandle(cause)
            | OpfsSAHError::GetFileHandle(cause)
            | OpfsSAHError::CreateSyncAccessHandle(cause)
            | OpfsSAHError::IterHandle(cause)
            | OpfsSAHError::GetPath(cause)
            | OpfsSAHError::RemoveEntity(cause)
            | OpfsSAHError::GetSize(cause)
            | OpfsSAHError::Read(cause)
            | OpfsSAHError::Write(cause)
            | OpfsSAHError::Flush(cause)
            | OpfsSAHError::Truncate(cause)
            | OpfsSAHError::Reflect(cause) => Some(js_error_message(cause)),
            _ => None,
        };

        match cause {
            Some(cause) => {
                from_str_err(&format!("Failed to open the SQLite store: {err}: {cause}"))
            },
            None => from_str_err(&format!("Failed to open the SQLite store: {err}")),
        }
    }
}
