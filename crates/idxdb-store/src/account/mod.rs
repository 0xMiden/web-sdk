use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::account::{
    Account,
    AccountCode,
    AccountHeader,
    AccountId,
    AccountIdError,
    AccountPatch,
    AccountStorage,
    Address,
    PartialAccount,
    PartialStorage,
    PartialStorageMap,
    StorageMap,
    StorageMapKey,
    StorageSlot,
    StorageSlotName,
    StorageSlotType,
};
use miden_client::asset::{
    AccountStorageHeader,
    Asset,
    AssetId,
    AssetVault,
    AssetWitness,
    PartialVault,
    StorageMapWitness,
    StorageSlotHeader,
};
use miden_client::crypto::MerkleError;
use miden_client::store::{
    AccountRecord,
    AccountRecordData,
    AccountStatus,
    AccountStorageFilter,
    AccountUpdate,
    ClientAccountType,
    StoreError,
};
use miden_client::{AccountError, Felt, Word};
use miden_client_proto::{decode_unchecked, encode};

use super::IdxdbStore;
use crate::account::js_bindings::idxdb_get_account_addresses;
use crate::account::models::AddressIdxdbObject;
use crate::account::utils::{
    insert_account_address,
    parse_account_address_idxdb_object,
    remove_account_address,
};
use crate::promise::{await_js, await_js_value};

mod js_bindings;
mod witnesses;
pub use js_bindings::{JsStorageMapEntry, JsStorageSlot, JsVaultAsset};
use js_bindings::{
    idxdb_get_account_code,
    idxdb_get_account_header,
    idxdb_get_account_header_by_commitment,
    idxdb_get_account_headers,
    idxdb_get_account_ids,
    idxdb_get_account_snapshot,
    idxdb_get_account_storage,
    idxdb_get_account_storage_maps,
    idxdb_get_account_vault_assets,
    idxdb_get_foreign_account_code,
    idxdb_lock_account,
    idxdb_prune_account_history,
    idxdb_undo_account_states,
    idxdb_upsert_foreign_account_code,
};

mod models;
use models::{
    AccountAssetIdxdbObject,
    AccountCodeIdxdbObject,
    AccountRecordIdxdbObject,
    AccountSnapshotIdxdbObject,
    AccountStorageIdxdbObject,
    ForeignAccountCodeIdxdbObject,
    StorageMapEntryIdxdbObject,
};

pub(crate) mod utils;
use utils::{
    apply_account_patch,
    apply_full_account_state,
    parse_account_record_idxdb_object,
    patch_code_bytes,
    upsert_account_asset_vault,
    upsert_account_code,
    upsert_account_record,
    upsert_account_storage,
};

impl IdxdbStore {
    pub(super) async fn get_account_ids(&self) -> Result<Vec<AccountId>, StoreError> {
        let promise = idxdb_get_account_ids(self.db_id());
        let account_ids_as_strings: Vec<String> =
            await_js(promise, "failed to fetch account ids").await?;

        let native_account_ids: Vec<AccountId> = account_ids_as_strings
            .into_iter()
            .map(|id| AccountId::from_hex(&id))
            .collect::<Result<Vec<_>, AccountIdError>>()?;

        Ok(native_account_ids)
    }

    pub(super) async fn get_account_headers(
        &self,
    ) -> Result<Vec<(AccountHeader, AccountStatus)>, StoreError> {
        let promise = idxdb_get_account_headers(self.db_id());
        let account_headers_idxdb: Vec<AccountRecordIdxdbObject> =
            await_js(promise, "failed to fetch account headers").await?;
        let account_headers: Vec<(AccountHeader, AccountStatus)> = account_headers_idxdb
            .into_iter()
            .map(|obj| {
                parse_account_record_idxdb_object(obj).map(|(header, status, _)| (header, status))
            })
            .collect::<Result<Vec<_>, StoreError>>()?;

        Ok(account_headers)
    }

    /// Like [`Self::get_account_header`] but also returns how the client tracks the account.
    async fn get_account_header_with_type(
        &self,
        account_id: AccountId,
    ) -> Result<Option<(AccountHeader, AccountStatus, ClientAccountType)>, StoreError> {
        let account_id_str = account_id.to_string();
        let promise = idxdb_get_account_header(self.db_id(), account_id_str);
        let account_header_idxdb: Option<AccountRecordIdxdbObject> =
            await_js(promise, "failed to fetch account header").await?;

        account_header_idxdb.map(parse_account_record_idxdb_object).transpose()
    }

    pub(crate) async fn get_account_header(
        &self,
        account_id: AccountId,
    ) -> Result<Option<(AccountHeader, AccountStatus)>, StoreError> {
        match self.get_account_header_with_type(account_id).await? {
            None => Ok(None),
            Some((header, status, _client_account_type)) => Ok(Some((header, status))),
        }
    }

    pub(crate) async fn get_account_header_by_commitment(
        &self,
        account_commitment: Word,
    ) -> Result<Option<AccountHeader>, StoreError> {
        let account_commitment_str = account_commitment.to_string();

        let promise = idxdb_get_account_header_by_commitment(self.db_id(), account_commitment_str);
        let account_header_idxdb: Option<AccountRecordIdxdbObject> =
            await_js(promise, "failed to fetch account header by commitment").await?;

        let account_header: Result<Option<AccountHeader>, StoreError> = account_header_idxdb
            .map_or(Ok(None), |account_record| {
                let result = parse_account_record_idxdb_object(account_record);

                result.map(|(account_header, _status, _client_type)| Some(account_header))
            });

        account_header
    }

    pub(crate) async fn get_account_addresses(
        &self,
        account_id: AccountId,
    ) -> Result<Vec<Address>, StoreError> {
        let account_id_str = account_id.to_string();

        let promise = idxdb_get_account_addresses(self.db_id(), account_id_str);

        let account_addresses_idxdb: Vec<AddressIdxdbObject> =
            await_js(promise, "failed to fetch account addresses").await?;

        account_addresses_idxdb
            .into_iter()
            .map(|obj| parse_account_address_idxdb_object(&obj).map(|(addr, _)| addr))
            .collect::<Result<Vec<Address>, StoreError>>()
    }

    pub(crate) async fn get_account(
        &self,
        account_id: AccountId,
    ) -> Result<Option<AccountRecord>, StoreError> {
        let Some(snapshot) = self.get_account_snapshot(account_id, true).await? else {
            return Ok(None);
        };
        let (header, status, client_type) = parse_account_record_idxdb_object(snapshot.header)?;
        let code = snapshot
            .code
            .ok_or_else(|| StoreError::DatabaseError("account snapshot code not found".into()))?;
        let account = Account::new(
            header.id(),
            AssetVault::new(&Self::parse_assets(snapshot.assets)?)?,
            Self::parse_storage(snapshot.storage, snapshot.maps)?,
            decode_unchecked(&code.code)?,
            header.nonce(),
            status.seed().copied(),
        )?;
        if account.to_commitment() != header.to_commitment() {
            return Err(StoreError::DatabaseError(format!(
                "account snapshot commitment does not match header for {account_id}",
            )));
        }
        // Other clients share the tables, but each store owns its forest.
        self.smt_forest.write().refresh_account(&account)?;
        Ok(Some(AccountRecord::new(AccountRecordData::Full(account), status, client_type)))
    }

    async fn get_account_snapshot(
        &self,
        account_id: AccountId,
        full: bool,
    ) -> Result<Option<AccountSnapshotIdxdbObject>, StoreError> {
        await_js(
            idxdb_get_account_snapshot(self.db_id(), account_id.to_string(), full),
            "failed to fetch account snapshot",
        )
        .await
    }

    pub(crate) async fn account_for_forest(
        &self,
        account_id: AccountId,
    ) -> Result<Account, StoreError> {
        let record = self
            .get_account(account_id)
            .await?
            .ok_or(StoreError::AccountDataNotFound(account_id))?;
        Account::try_from(record).map_err(|error| StoreError::DatabaseError(error.to_string()))
    }

    /// Returns a tracked account's persisted header, refreshing this store's forest from the full
    /// account only when its roots differ from persisted state.
    pub(crate) async fn current_account_header(
        &self,
        account_id: AccountId,
    ) -> Result<AccountHeader, StoreError> {
        let record = self
            .get_minimal_partial_account(account_id)
            .await?
            .ok_or(StoreError::AccountDataNotFound(account_id))?;
        let account = PartialAccount::try_from(record)
            .map_err(|error| StoreError::DatabaseError(error.to_string()))?;
        let maps = account
            .storage()
            .header()
            .slots()
            .filter(|slot| slot.slot_type() == StorageSlotType::Map)
            .map(|slot| (slot.name(), slot.value()));
        if self.smt_forest.read().is_current(account_id, account.vault().root(), maps) {
            return Ok(account.to_header());
        }
        Ok(AccountHeader::from(&self.account_for_forest(account_id).await?))
    }

    pub(crate) async fn get_minimal_partial_account(
        &self,
        account_id: AccountId,
    ) -> Result<Option<AccountRecord>, StoreError> {
        let Some(snapshot) = self.get_account_snapshot(account_id, false).await? else {
            return Ok(None);
        };
        let (header, status, client_type) = parse_account_record_idxdb_object(snapshot.header)?;
        let code = snapshot
            .code
            .ok_or_else(|| StoreError::DatabaseError("account snapshot code not found".into()))?;
        let code: AccountCode = decode_unchecked(&code.code)?;
        let mut slots = snapshot
            .storage
            .into_iter()
            .map(|slot| {
                let name = StorageSlotName::new(slot.slot_name).map_err(|error| {
                    StoreError::DatabaseError(format!("invalid storage slot name in db: {error}"))
                })?;
                Ok(StorageSlotHeader::new(
                    name,
                    StorageSlotType::try_from(slot.slot_type)?,
                    Word::try_from(slot.slot_value.as_str())?,
                ))
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        slots.sort_by_key(StorageSlotHeader::id);
        let storage = AccountStorageHeader::new(slots)?;
        if storage.to_commitment() != header.storage_commitment()
            || code.commitment() != header.code_commitment()
        {
            return Err(StoreError::DatabaseError(format!(
                "account snapshot commitment does not match header for {account_id}",
            )));
        }
        let maps: Vec<_> = storage
            .slots()
            .filter(|slot| slot.slot_type() == StorageSlotType::Map)
            .map(|slot| PartialStorageMap::new(slot.value()))
            .collect();
        let account = PartialAccount::new(
            header.id(),
            header.nonce(),
            code,
            PartialStorage::new(storage, maps)?,
            PartialVault::new(header.vault_root()),
            status.seed().copied(),
        )?;
        Ok(Some(AccountRecord::new(
            AccountRecordData::Partial(account),
            status,
            client_type,
        )))
    }

    pub(super) async fn get_account_code(&self, root: Word) -> Result<AccountCode, StoreError> {
        let root_serialized = root.to_string();

        let promise = idxdb_get_account_code(self.db_id(), root_serialized);
        let account_code_idxdb: AccountCodeIdxdbObject =
            await_js(promise, "failed to fetch account code").await?;

        Ok(decode_unchecked(&account_code_idxdb.code)?)
    }

    pub(super) async fn get_storage(
        &self,
        account_id: AccountId,
        filter: AccountStorageFilter,
    ) -> Result<AccountStorage, StoreError> {
        let account_id_str = account_id.to_string();

        let promise = idxdb_get_account_storage(self.db_id(), account_id_str.clone(), vec![]);
        let account_storage_idxdb: Vec<AccountStorageIdxdbObject> =
            await_js(promise, "failed to fetch account storage").await?;

        if account_storage_idxdb.iter().any(|s| s.slot_name.is_empty()) {
            return Err(StoreError::DatabaseError(
                "account storage entries are missing `slotName`; clear IndexedDB and re-sync"
                    .to_string(),
            ));
        }

        let filtered_slots: Vec<AccountStorageIdxdbObject> = match filter {
            AccountStorageFilter::All => account_storage_idxdb,
            AccountStorageFilter::Root(map_root) => {
                let map_root_hex = map_root.to_hex();
                let slot = account_storage_idxdb.into_iter().find(|s| {
                    s.slot_value == map_root_hex
                        && StorageSlotType::try_from(s.slot_type).ok() == Some(StorageSlotType::Map)
                });
                match slot {
                    Some(slot) => vec![slot],
                    None => return Err(StoreError::AccountStorageRootNotFound(map_root)),
                }
            },
            AccountStorageFilter::SlotName(name) => {
                let wanted_name = name.as_str();
                let slot =
                    account_storage_idxdb.into_iter().find(|s| s.slot_name.as_str() == wanted_name);
                match slot {
                    Some(slot) => vec![slot],
                    None => {
                        return Err(StoreError::AccountError(
                            AccountError::StorageSlotNameNotFound { slot_name: name },
                        ));
                    },
                }
            },
            AccountStorageFilter::SlotNames(names) => {
                let wanted: alloc::collections::BTreeSet<&str> =
                    names.iter().map(StorageSlotName::as_str).collect();
                account_storage_idxdb
                    .into_iter()
                    .filter(|s| wanted.contains(s.slot_name.as_str()))
                    .collect()
            },
        };

        let promise = idxdb_get_account_storage_maps(self.db_id(), account_id_str);
        let account_maps_idxdb: Vec<StorageMapEntryIdxdbObject> =
            await_js(promise, "failed to fetch account storage maps").await?;

        Self::parse_storage(filtered_slots, account_maps_idxdb)
    }

    fn parse_storage(
        slots_rows: Vec<AccountStorageIdxdbObject>,
        map_rows: Vec<StorageMapEntryIdxdbObject>,
    ) -> Result<AccountStorage, StoreError> {
        if slots_rows.iter().any(|slot| slot.slot_name.is_empty()) {
            return Err(StoreError::DatabaseError(
                "account storage entries are missing `slotName`; clear IndexedDB and re-sync"
                    .into(),
            ));
        }
        let mut maps = BTreeMap::new();
        for entry in map_rows {
            let map = maps.entry(entry.slot_name).or_insert_with(StorageMap::new);
            map.insert(
                StorageMapKey::new(Word::try_from(entry.key.as_str())?),
                Word::try_from(entry.value.as_str())?,
            )?;
        }

        let slots: Vec<StorageSlot> = slots_rows
            .into_iter()
            .map(|slot| {
                let slot_name = StorageSlotName::new(slot.slot_name.clone()).map_err(|err| {
                    StoreError::DatabaseError(format!("invalid storage slot name in db: {err}"))
                })?;

                let slot_type = StorageSlotType::try_from(slot.slot_type)?;

                Ok(match slot_type {
                    StorageSlotType::Value => {
                        StorageSlot::with_value(slot_name, Word::try_from(slot.slot_value.as_str())?)
                    },
                    StorageSlotType::Map => {
                        let map = maps.remove(&slot.slot_name).unwrap_or_else(StorageMap::new);
                        if map.root().to_hex() != slot.slot_value {
                            return Err(StoreError::DatabaseError(format!(
                                "incomplete storage map for slot {slot_name} (expected root {}, got {})",
                                slot.slot_value,
                                map.root().to_hex(),
                            )));
                        }
                        StorageSlot::with_map(slot_name, map)
                    },
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;

        Ok(AccountStorage::new(slots)?)
    }

    pub(super) async fn get_vault_assets(
        &self,
        account_id: AccountId,
        vault_keys: Vec<String>,
    ) -> Result<Vec<Asset>, StoreError> {
        let promise =
            idxdb_get_account_vault_assets(self.db_id(), account_id.to_string(), vault_keys);
        let vault_assets_idxdb: Vec<AccountAssetIdxdbObject> =
            await_js(promise, "failed to fetch vault assets").await?;

        Self::parse_assets(vault_assets_idxdb)
    }

    fn parse_assets(entries: Vec<AccountAssetIdxdbObject>) -> Result<Vec<Asset>, StoreError> {
        let assets = entries
            .into_iter()
            .map(|entry| {
                let key_word = Word::try_from(&entry.vault_key)?;
                let value_word = Word::try_from(&entry.asset)?;
                Ok(Asset::from_id_and_value_words(key_word, value_word)?)
            })
            .collect::<Result<Vec<_>, StoreError>>()?;

        Ok(assets)
    }

    /// Applies an incremental (non-full-state) account patch: updates the SMT forest, then persists
    /// the resulting storage-map roots and vault changes atomically.
    ///
    /// The patch's values are already absolute, so no account reconstruction is needed. Applying
    /// the forest update also verifies it: `final_header`'s vault root is recorded on the update
    /// and checked, so a patch that does not reproduce it fails before anything is written.
    pub(crate) async fn apply_incremental_account_patch(
        &self,
        final_header: &AccountHeader,
        patch: &AccountPatch,
    ) -> Result<(), StoreError> {
        let account_id = final_header.id();
        let initial = self.current_account_header(account_id).await?;
        if final_header.nonce() <= initial.nonce() {
            return Err(StoreError::DatabaseError(format!(
                "account patch nonce does not advance persisted state for {account_id}",
            )));
        }
        let new_map_roots = self.apply_patch_to_forest(final_header, patch)?;
        let code_bytes = patch_code_bytes(patch, final_header)?;

        apply_account_patch(
            self.db_id(),
            account_id,
            final_header,
            &new_map_roots,
            patch,
            code_bytes,
            initial.to_commitment(),
        )
        .await
        .map_err(|err| StoreError::DatabaseError(format!("failed to apply account patch: {err:?}")))
    }

    /// Applies an account patch to the SMT forest, returning the new root of each map slot it
    /// changed — the only thing the store write needs that the patch does not already carry.
    ///
    /// Shared with the batch path, which writes once for several transactions instead of per patch.
    /// Each call advances the forest, so a later patch in a batch sees the earlier ones' results.
    ///
    /// The forest must be updated before the store write, because the write needs these roots. A
    /// write that then fails leaves the forest ahead of the tables; its readers compare roots with
    /// persisted state and refresh the account, so nothing has to walk it back.
    pub(crate) fn apply_patch_to_forest(
        &self,
        final_header: &AccountHeader,
        patch: &AccountPatch,
    ) -> Result<BTreeMap<StorageSlotName, Word>, StoreError> {
        let account_id = final_header.id();
        let mut smt_forest = self.smt_forest.write();

        // Patching an untracked account would build partial state from empty trees.
        if smt_forest.vault_root(account_id).is_none() {
            return Err(StoreError::AccountDataNotFound(account_id));
        }

        let mut update = AccountUpdate::new();
        update.vault_patch(account_id, patch.vault(), final_header.vault_root());
        update.storage_patch(account_id, patch.storage());
        smt_forest.apply(update)?;

        // Removed maps have no root: their rows are deleted and their lineage was emptied above.
        patch
            .storage()
            .maps()
            .filter(|(_, map_patch)| !map_patch.patch_op().is_remove())
            .map(|(slot_name, _)| {
                let root = smt_forest.map_root(account_id, slot_name).ok_or_else(|| {
                    StoreError::DatabaseError(format!("storage map slot {slot_name} is untracked"))
                })?;
                Ok((slot_name.clone(), root))
            })
            .collect()
    }

    pub(crate) async fn insert_account(
        &self,
        account: &Account,
        initial_address: Address,
        client_account_type: ClientAccountType,
    ) -> Result<(), StoreError> {
        upsert_account_code(self.db_id(), account.code()).await.map_err(|js_error| {
            StoreError::DatabaseError(format!("failed to insert account code: {js_error:?}"))
        })?;

        upsert_account_storage(self.db_id(), &account.id(), account.storage())
            .await
            .map_err(|js_error| {
                StoreError::DatabaseError(format!("failed to insert account storage:{js_error:?}"))
            })?;

        upsert_account_asset_vault(self.db_id(), &account.id(), account.vault())
            .await
            .map_err(|js_error| {
                StoreError::DatabaseError(format!("failed to insert account vault:{js_error:?}"))
            })?;

        upsert_account_record(self.db_id(), account, client_account_type)
            .await
            .map_err(|js_error| {
                StoreError::DatabaseError(format!("failed to insert account record: {js_error:?}"))
            })?;

        insert_account_address(self.db_id(), &account.id(), initial_address)
            .await
            .map_err(|js_error| {
                StoreError::DatabaseError(format!(
                    "failed to insert account addresses: {js_error:?}",
                ))
            })?;

        self.smt_forest.write().rebuild_account(account)?;

        Ok(())
    }

    pub(crate) async fn update_account(
        &self,
        new_account_state: &Account,
    ) -> Result<(), StoreError> {
        let account_id = new_account_state.id();
        self.get_account_header(account_id)
            .await?
            .ok_or(StoreError::AccountDataNotFound(account_id))?;

        apply_full_account_state(self.db_id(), new_account_state)
            .await
            .map_err(|_| StoreError::DatabaseError("failed to update account".to_string()))?;

        self.smt_forest.write().rebuild_account(new_account_state)?;

        Ok(())
    }

    pub(crate) async fn get_account_vault(
        &self,
        account_id: AccountId,
    ) -> Result<AssetVault, StoreError> {
        // Verify account exists
        self.get_account_header(account_id)
            .await?
            .ok_or(StoreError::AccountDataNotFound(account_id))?;

        let assets = self.get_vault_assets(account_id, vec![]).await?;
        Ok(AssetVault::new(&assets)?)
    }

    pub(crate) async fn get_account_storage(
        &self,
        account_id: AccountId,
        filter: AccountStorageFilter,
    ) -> Result<AccountStorage, StoreError> {
        // Verify account exists
        self.get_account_header(account_id)
            .await?
            .ok_or(StoreError::AccountDataNotFound(account_id))?;

        self.get_storage(account_id, filter).await
    }

    pub(crate) async fn get_account_asset(
        &self,
        account_id: AccountId,
        vault_id: AssetId,
    ) -> Result<Option<(Asset, AssetWitness)>, StoreError> {
        let account_header = self
            .get_account_header(account_id)
            .await?
            .ok_or(StoreError::AccountDataNotFound(account_id))?
            .0;

        let stale =
            self.smt_forest.read().vault_root(account_id) != Some(account_header.vault_root());
        let vault_root = if stale {
            self.account_for_forest(account_id).await?.vault().root()
        } else {
            account_header.vault_root()
        };
        let smt_forest = self.smt_forest.read();
        match smt_forest.get_asset_and_witness(account_id, vault_root, vault_id) {
            Ok(result) => Ok(Some(result)),
            Err(
                StoreError::VaultKeyNotTracked(..)
                | StoreError::MerkleStoreError(MerkleError::UntrackedKey(_)),
            ) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub(crate) async fn get_account_map_item(
        &self,
        account_id: AccountId,
        slot_name: StorageSlotName,
        key: StorageMapKey,
    ) -> Result<(Word, StorageMapWitness), StoreError> {
        let promise = idxdb_get_account_storage(
            self.db_id(),
            account_id.to_string(),
            vec![slot_name.as_str().to_string()],
        );
        let slots: Vec<AccountStorageIdxdbObject> =
            await_js(promise, "failed to fetch account storage").await?;

        let Some(slot) = slots.into_iter().next() else {
            self.get_account_header(account_id)
                .await?
                .ok_or(StoreError::AccountDataNotFound(account_id))?;
            return Err(StoreError::AccountError(AccountError::other("Storage slot not found")));
        };

        let slot_type = StorageSlotType::try_from(slot.slot_type)?;
        if slot_type != StorageSlotType::Map {
            return Err(StoreError::AccountError(AccountError::other("Storage slot is not a map")));
        }
        let mut map_root = Word::try_from(slot.slot_value.as_str())?;
        let stale = self.smt_forest.read().map_root(account_id, &slot_name) != Some(map_root);
        if stale {
            let account = self.account_for_forest(account_id).await?;
            let slot = account
                .storage()
                .slots()
                .iter()
                .find(|slot| slot.name() == &slot_name)
                .ok_or_else(|| {
                    StoreError::AccountError(AccountError::other("Storage slot not found"))
                })?;
            if slot.slot_type() != StorageSlotType::Map {
                return Err(StoreError::AccountError(AccountError::other(
                    "Storage slot is not a map",
                )));
            }
            map_root = slot.value();
        }

        let smt_forest = self.smt_forest.read();
        let witness =
            smt_forest.get_storage_map_item_witness(account_id, &slot_name, map_root, key)?;
        let value = witness.get(key).unwrap_or(miden_client::EMPTY_WORD);

        Ok((value, witness))
    }

    pub(crate) async fn upsert_foreign_account_code(
        &self,
        account_id: AccountId,
        code: AccountCode,
    ) -> Result<(), StoreError> {
        let root = code.commitment().to_string();
        let code = encode(&code);
        let account_id = account_id.to_string();

        let promise = idxdb_upsert_foreign_account_code(self.db_id(), account_id, code, root);
        await_js_value(promise, "failed to upsert foreign account code").await?;

        Ok(())
    }

    pub(crate) async fn get_foreign_account_code(
        &self,
        account_ids: Vec<AccountId>,
    ) -> Result<BTreeMap<AccountId, AccountCode>, StoreError> {
        let account_ids = account_ids.iter().map(ToString::to_string).collect::<Vec<_>>();
        let promise = idxdb_get_foreign_account_code(self.db_id(), account_ids);
        let foreign_account_code_idxdb: Option<Vec<ForeignAccountCodeIdxdbObject>> =
            await_js(promise, "failed to fetch foreign account code").await?;

        let foreign_account_code: BTreeMap<AccountId, AccountCode> = foreign_account_code_idxdb
            .unwrap_or_default()
            .into_iter()
            .map(|idxdb_object| {
                let account_id = AccountId::from_hex(&idxdb_object.account_id)
                    .map_err(StoreError::AccountIdError)?;
                let code: AccountCode = decode_unchecked(&idxdb_object.code)?;

                Ok((account_id, code))
            })
            .collect::<Result<BTreeMap<AccountId, AccountCode>, StoreError>>()?;

        Ok(foreign_account_code)
    }

    pub(crate) async fn undo_account_states(
        &self,
        account_states: &[Word],
    ) -> Result<(), StoreError> {
        let account_commitments =
            account_states.iter().map(ToString::to_string).collect::<Vec<_>>();
        let promise = idxdb_undo_account_states(self.db_id(), account_commitments);
        await_js_value(promise, "failed to undo account states").await?;

        Ok(())
    }

    /// Locks the account if the mismatched digest doesn't belong to a previous account state (stale
    /// data).
    pub(crate) async fn lock_account_on_unexpected_commitment(
        &self,
        account_id: &AccountId,
        mismatched_digest: &Word,
    ) -> Result<(), StoreError> {
        // Mismatched digests may be due to stale network data. If the mismatched digest is
        // tracked in the db and corresponds to the mismatched account, it means we
        // got a past update and shouldn't lock the account.
        if let Some(account) = self.get_account_header_by_commitment(*mismatched_digest).await?
            && account.id() == *account_id
        {
            return Ok(());
        }

        let account_id_str = account_id.to_string();
        let promise = idxdb_lock_account(self.db_id(), account_id_str);
        await_js_value(promise, "failed to lock account").await?;

        Ok(())
    }

    pub(crate) async fn insert_address(
        &self,
        address: Address,
        account_id: &AccountId,
    ) -> Result<(), StoreError> {
        insert_account_address(self.db_id(), account_id, address)
            .await
            .map_err(|js_error| {
                StoreError::DatabaseError(format!(
                    "failed to insert account addresses: {js_error:?}",
                ))
            })?;

        Ok(())
    }

    pub(crate) async fn remove_address(&self, address: Address) -> Result<bool, StoreError> {
        remove_account_address(self.db_id(), address).await.map_err(|js_error| {
            StoreError::DatabaseError(format!("failed to remove account address: {js_error:?}"))
        })
    }

    pub(crate) async fn prune_account_history(
        &self,
        account_id: AccountId,
        up_to_nonce: Felt,
    ) -> Result<usize, StoreError> {
        let promise = idxdb_prune_account_history(
            self.db_id(),
            account_id.to_string(),
            up_to_nonce.as_canonical_u64().to_string(),
        );
        await_js(promise, "failed to prune account history").await
    }
}
