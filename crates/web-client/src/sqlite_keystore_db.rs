//! The `SQLite` database a browser keystore keeps its keys in when the client's store is `SQLite`.
//!
//! It is a database of its own, beside the store's, so the store's schema stays the one
//! `miden-client-sqlite-store` defines. It holds what the `accountAuth` and `accountKeyMapping`
//! tables of the `IndexedDB` store hold for a client on that store.

use std::sync::{Mutex, MutexGuard, TryLockError};

use rusqlite::{Connection, OptionalExtension, params};

/// The schema version this module builds, as recorded in `PRAGMA user_version`.
const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
    CREATE TABLE account_auth (
        pub_key_commitment_hex TEXT NOT NULL PRIMARY KEY,
        secret_key_hex TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE account_key_mapping (
        account_id_hex TEXT NOT NULL,
        pub_key_commitment_hex TEXT NOT NULL,
        PRIMARY KEY (account_id_hex, pub_key_commitment_hex)
    ) WITHOUT ROWID;

    CREATE INDEX idx_account_key_mapping_pub_key
        ON account_key_mapping (pub_key_commitment_hex);
";

/// The keys of a keystore and the accounts they belong to, in a `SQLite` database.
pub(crate) struct SqliteKeystoreDb {
    conn: Mutex<Connection>,
}

impl SqliteKeystoreDb {
    /// Opens the keystore database at `path`, creating its tables if the database is new.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be opened, or if it was written by a later version
    /// of this module.
    pub(crate) fn open(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path)
            .map_err(|err| format!("failed to open the keystore database: {err}"))?;
        Self::from_connection(conn)
    }

    fn from_connection(mut conn: Connection) -> Result<Self, String> {
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|err| format!("failed to read the keystore schema version: {err}"))?;

        match version {
            0 => create_schema(&mut conn)
                .map_err(|err| format!("failed to create the keystore schema: {err}"))?,
            SCHEMA_VERSION => {},
            newer => {
                return Err(format!(
                    "the keystore database is at schema version {newer}, which is newer than the \
                     highest version this client supports ({SCHEMA_VERSION})"
                ));
            },
        }

        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Stores `secret_key_hex` under `pub_key_commitment_hex`.
    ///
    /// # Errors
    ///
    /// Returns an error if a key is already stored under `pub_key_commitment_hex`.
    pub(crate) fn insert_account_auth(
        &self,
        pub_key_commitment_hex: &str,
        secret_key_hex: &str,
    ) -> Result<(), String> {
        self.lock()?
            .execute(
                "INSERT INTO account_auth (pub_key_commitment_hex, secret_key_hex) VALUES (?1, ?2)",
                params![pub_key_commitment_hex, secret_key_hex],
            )
            .map_err(|err| format!("failed to insert the secret key: {err}"))?;
        Ok(())
    }

    /// Returns the secret key stored under `pub_key_commitment_hex`, or `None` if there is none.
    pub(crate) fn get_account_auth(
        &self,
        pub_key_commitment_hex: &str,
    ) -> Result<Option<String>, String> {
        self.lock()?
            .query_row(
                "SELECT secret_key_hex FROM account_auth WHERE pub_key_commitment_hex = ?1",
                params![pub_key_commitment_hex],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("failed to read the secret key: {err}"))
    }

    /// Removes the secret key stored under `pub_key_commitment_hex`, if there is one.
    pub(crate) fn remove_account_auth(&self, pub_key_commitment_hex: &str) -> Result<(), String> {
        self.lock()?
            .execute(
                "DELETE FROM account_auth WHERE pub_key_commitment_hex = ?1",
                params![pub_key_commitment_hex],
            )
            .map_err(|err| format!("failed to remove the secret key: {err}"))?;
        Ok(())
    }

    /// Records that the key `pub_key_commitment_hex` belongs to the account `account_id_hex`.
    /// Recording a mapping that is already there changes nothing.
    pub(crate) fn insert_account_key_mapping(
        &self,
        account_id_hex: &str,
        pub_key_commitment_hex: &str,
    ) -> Result<(), String> {
        self.lock()?
            .execute(
                "INSERT OR REPLACE INTO account_key_mapping \
                 (account_id_hex, pub_key_commitment_hex) VALUES (?1, ?2)",
                params![account_id_hex, pub_key_commitment_hex],
            )
            .map_err(|err| format!("failed to insert the account key mapping: {err}"))?;
        Ok(())
    }

    /// Returns the commitments of the keys that belong to the account `account_id_hex`.
    pub(crate) fn get_key_commitments_by_account_id(
        &self,
        account_id_hex: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT pub_key_commitment_hex FROM account_key_mapping \
                 WHERE account_id_hex = ?1 ORDER BY pub_key_commitment_hex",
            )
            .map_err(|err| format!("failed to read the account key mappings: {err}"))?;
        let rows = stmt
            .query_map(params![account_id_hex], |row| row.get::<_, String>(0))
            .map_err(|err| format!("failed to read the account key mappings: {err}"))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()
            .map_err(|err| format!("failed to read the account key mappings: {err}"))
    }

    /// Removes every mapping of the key `pub_key_commitment_hex` to an account.
    pub(crate) fn remove_all_mappings_for_key(
        &self,
        pub_key_commitment_hex: &str,
    ) -> Result<(), String> {
        self.lock()?
            .execute(
                "DELETE FROM account_key_mapping WHERE pub_key_commitment_hex = ?1",
                params![pub_key_commitment_hex],
            )
            .map_err(|err| format!("failed to remove the account key mappings: {err}"))?;
        Ok(())
    }

    /// Returns an account the key `pub_key_commitment_hex` belongs to, or `None` if it belongs to
    /// none. A key that belongs to more than one account yields the one with the lowest ID.
    pub(crate) fn get_account_id_by_key_commitment(
        &self,
        pub_key_commitment_hex: &str,
    ) -> Result<Option<String>, String> {
        self.lock()?
            .query_row(
                "SELECT account_id_hex FROM account_key_mapping \
                 WHERE pub_key_commitment_hex = ?1 ORDER BY account_id_hex LIMIT 1",
                params![pub_key_commitment_hex],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("failed to read the account key mapping: {err}"))
    }

    /// Returns the connection, without waiting for it.
    ///
    /// Every method runs its query to completion before it returns, so the connection is only
    /// found locked after a panic that did not unwind left it so. Waiting for it then would never
    /// end.
    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        match self.conn.try_lock() {
            Ok(conn) => Ok(conn),
            Err(TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {
                Err("the keystore database is already running a query".to_string())
            },
        }
    }
}

/// Creates the tables of a new keystore database and records the schema version, in one
/// transaction.
fn create_schema(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(SCHEMA)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()
}

// TESTS
// ================================================================================================

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{SCHEMA_VERSION, SqliteKeystoreDb};

    fn open_in_memory() -> SqliteKeystoreDb {
        SqliteKeystoreDb::from_connection(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn secret_key_round_trips() {
        let db = open_in_memory();

        assert_eq!(db.get_account_auth("0xkey").unwrap(), None);

        db.insert_account_auth("0xkey", "secret").unwrap();
        assert_eq!(db.get_account_auth("0xkey").unwrap(), Some("secret".to_string()));
        assert_eq!(db.get_account_auth("0xother").unwrap(), None);

        db.remove_account_auth("0xkey").unwrap();
        assert_eq!(db.get_account_auth("0xkey").unwrap(), None);
        // Removing a key that is not there is not an error.
        db.remove_account_auth("0xkey").unwrap();
    }

    #[test]
    fn inserting_a_stored_key_again_is_rejected() {
        let db = open_in_memory();

        db.insert_account_auth("0xkey", "secret").unwrap();
        let err = db.insert_account_auth("0xkey", "replacement").unwrap_err();

        assert!(err.contains("failed to insert the secret key"), "unexpected error: {err}");
        assert_eq!(db.get_account_auth("0xkey").unwrap(), Some("secret".to_string()));
    }

    #[test]
    fn mappings_are_listed_per_account() {
        let db = open_in_memory();

        db.insert_account_key_mapping("0xaccount1", "0xkey2").unwrap();
        db.insert_account_key_mapping("0xaccount1", "0xkey1").unwrap();
        db.insert_account_key_mapping("0xaccount2", "0xkey3").unwrap();
        // Recording a mapping twice leaves one.
        db.insert_account_key_mapping("0xaccount1", "0xkey1").unwrap();

        assert_eq!(
            db.get_key_commitments_by_account_id("0xaccount1").unwrap(),
            vec!["0xkey1".to_string(), "0xkey2".to_string()]
        );
        assert_eq!(
            db.get_key_commitments_by_account_id("0xaccount2").unwrap(),
            vec!["0xkey3".to_string()]
        );
        assert_eq!(
            db.get_key_commitments_by_account_id("0xunknown").unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn account_is_found_by_key() {
        let db = open_in_memory();

        assert_eq!(db.get_account_id_by_key_commitment("0xkey").unwrap(), None);

        db.insert_account_key_mapping("0xaccount2", "0xkey").unwrap();
        db.insert_account_key_mapping("0xaccount1", "0xkey").unwrap();
        db.insert_account_key_mapping("0xaccount3", "0xother").unwrap();

        assert_eq!(
            db.get_account_id_by_key_commitment("0xkey").unwrap(),
            Some("0xaccount1".to_string())
        );
    }

    #[test]
    fn removing_the_mappings_of_a_key_leaves_other_keys() {
        let db = open_in_memory();

        db.insert_account_key_mapping("0xaccount1", "0xkey1").unwrap();
        db.insert_account_key_mapping("0xaccount2", "0xkey1").unwrap();
        db.insert_account_key_mapping("0xaccount1", "0xkey2").unwrap();

        db.remove_all_mappings_for_key("0xkey1").unwrap();

        assert_eq!(db.get_account_id_by_key_commitment("0xkey1").unwrap(), None);
        assert_eq!(
            db.get_key_commitments_by_account_id("0xaccount1").unwrap(),
            vec!["0xkey2".to_string()]
        );
        assert_eq!(
            db.get_key_commitments_by_account_id("0xaccount2").unwrap(),
            Vec::<String>::new()
        );
    }

    /// A database the module already created is opened as it is, with its contents.
    #[test]
    fn reopening_keeps_the_contents() {
        let dir = std::env::temp_dir().join(format!(
            "miden-keystore-db-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keystore.sqlite3");
        let path = path.to_str().unwrap();

        let db = SqliteKeystoreDb::open(path).unwrap();
        db.insert_account_auth("0xkey", "secret").unwrap();
        db.insert_account_key_mapping("0xaccount", "0xkey").unwrap();
        drop(db);

        let reopened = SqliteKeystoreDb::open(path).unwrap();
        assert_eq!(reopened.get_account_auth("0xkey").unwrap(), Some("secret".to_string()));
        assert_eq!(
            reopened.get_account_id_by_key_commitment("0xkey").unwrap(),
            Some("0xaccount".to_string())
        );
        drop(reopened);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn database_from_a_later_version_is_rejected() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();

        // `SqliteKeystoreDb` is not `Debug`, so this cannot go through `unwrap_err`.
        let Err(err) = SqliteKeystoreDb::from_connection(conn) else {
            panic!("a database from a later version must be rejected");
        };
        assert!(err.contains("newer than the highest version"), "unexpected error: {err}");
    }
}
