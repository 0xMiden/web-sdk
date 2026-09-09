//! Account SMT forest held by [`IdxdbStore`](crate::IdxdbStore).

use core::ops::Deref;

use miden_client::account::{Account, AccountId, StorageSlot};
use miden_client::asset::Asset;
use miden_client::crypto::{ForestInMemoryBackend, VersionId};
use miden_client::store::{AccountSmtForest, AccountUpdate, StoreError};

/// The account vault and storage-map SMTs, which serve asset and storage-map witnesses.
///
/// The forest is kept in memory and rebuilt from the account tables on open: the forest storage
/// `Backend` trait is synchronous, and every `IndexedDB` access from WASM goes through a JS
/// promise.
///
/// Updates are forward-only — there is no staging or rollback. A store write that fails after the
/// forest advanced is recovered by
/// [`IdxdbStore::rebuild_account_forest`](crate::IdxdbStore::rebuild_account_forest).
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

    /// Sets an account's vault and map slots to exactly the state it holds.
    pub(crate) fn rebuild_account(&mut self, account: &Account) -> Result<(), StoreError> {
        self.rebuild(account.id(), account.vault().assets(), account.storage().slots().iter())
    }

    /// Sets an account's vault and map slots to exactly the given state.
    ///
    /// Takes the vault and slots loosely so the store can rebuild from its own tables, which yield
    /// no code or nonce and so cannot produce an [`Account`].
    ///
    /// Lineages of map slots the account no longer has keep their entries. They are unreachable —
    /// a read resolves the slot row first, and re-creating the slot replaces the tree wholesale —
    /// and this forest is rebuilt on every store open, so they do not outlive the session.
    pub(crate) fn rebuild<'a>(
        &mut self,
        account_id: AccountId,
        assets: impl Iterator<Item = Asset>,
        slots: impl Iterator<Item = &'a StorageSlot>,
    ) -> Result<(), StoreError> {
        let mut update = AccountUpdate::new();
        update.full_state(account_id, assets, slots);
        self.apply(update)
    }
}

impl Deref for AccountForest {
    type Target = AccountSmtForest<ForestInMemoryBackend>;

    fn deref(&self) -> &Self::Target {
        &self.forest
    }
}
