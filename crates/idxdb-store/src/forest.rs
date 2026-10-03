//! Account SMT forest held by [`IdxdbStore`](crate::IdxdbStore).

use core::ops::Deref;

use miden_client::Word;
use miden_client::account::{Account, AccountId, StorageSlotContent, StorageSlotName};
use miden_client::crypto::{ForestInMemoryBackend, VersionId};
use miden_client::store::{AccountSmtForest, AccountUpdate, StoreError};

/// The account vault and storage-map SMTs, which serve asset and storage-map witnesses.
///
/// The forest is kept in memory, starts empty on every store open and is filled from the account
/// tables as accounts are read: the forest storage `Backend` trait is synchronous, and every
/// `IndexedDB` access from WASM goes through a JS promise.
///
/// Updates are forward-only - there is no staging or rollback. Other clients sharing the database
/// change the tables, and a store write can fail after the forest advanced, so every reader
/// compares the roots it uses with persisted state and refreshes the account when they differ.
///
/// This wrapper exists to own the version counter. Reads go to the forest through [`Deref`].
pub(crate) struct AccountForest {
    forest: AccountSmtForest<ForestInMemoryBackend>,
    /// Version the next update is applied at. `apply` requires one strictly greater than every
    /// lineage it touches, and the backend starts empty on open, so a single counter suffices.
    next_version: VersionId,
}

impl AccountForest {
    pub(crate) fn new() -> Result<Self, StoreError> {
        Ok(Self {
            forest: AccountSmtForest::new(ForestInMemoryBackend::new())?,
            next_version: 1,
        })
    }

    /// Applies an update at a freshly allocated version.
    ///
    /// Roots recorded on the update are verified as part of applying it. Resulting roots are read
    /// back with `vault_root` / `map_root`.
    pub(crate) fn apply(&mut self, update: AccountUpdate) -> Result<(), StoreError> {
        let version = self.next_version;
        self.next_version += 1;
        self.forest.apply(version, update)
    }

    /// Whether the account's vault and the given map slots hold exactly these roots.
    pub(crate) fn is_current<'a>(
        &self,
        account_id: AccountId,
        vault_root: Word,
        map_roots: impl IntoIterator<Item = (&'a StorageSlotName, Word)>,
    ) -> bool {
        self.vault_root(account_id) == Some(vault_root)
            && map_roots
                .into_iter()
                .all(|(name, root)| self.map_root(account_id, name) == Some(root))
    }

    pub(crate) fn refresh_account(&mut self, account: &Account) -> Result<(), StoreError> {
        let maps = account.storage().slots().iter().filter_map(|slot| match slot.content() {
            StorageSlotContent::Map(map) => Some((slot.name(), map.root())),
            StorageSlotContent::Value(_) => None,
        });
        if self.is_current(account.id(), account.vault().root(), maps) {
            Ok(())
        } else {
            self.rebuild_account(account)
        }
    }

    /// Sets an account's vault and map slots to exactly the state it holds.
    ///
    /// Lineages of map slots the account no longer has keep their entries. They are unreachable -
    /// a read resolves the slot row first, and re-creating the slot replaces the tree wholesale -
    /// and the forest starts empty on every store open, so they do not outlive the session.
    pub(crate) fn rebuild_account(&mut self, account: &Account) -> Result<(), StoreError> {
        let mut update = AccountUpdate::new();
        update.full_state(account.id(), account.vault().assets(), account.storage().slots().iter());
        self.apply(update)
    }
}

impl Deref for AccountForest {
    type Target = AccountSmtForest<ForestInMemoryBackend>;

    fn deref(&self) -> &Self::Target {
        &self.forest
    }
}
