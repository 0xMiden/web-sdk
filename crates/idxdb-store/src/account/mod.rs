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
    ClientAccountType,
    StoreError,
};
use miden_client::utils::{Deserializable, Serializable};
use miden_client::{AccountError, Felt, Word};

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
pub use js_bindings::{JsStorageMapEntry, JsStorageSlot, JsVaultAsset};
use js_bindings::{
    idxdb_get_account_code,
    idxdb_get_account_header,
    idxdb_get_account_header_by_commitment,
    idxdb_get_account_headers,
    idxdb_get_account_ids,
    idxdb_get_account_storage,
    idxdb_get_account_storage_maps,
    idxdb_get_account_vault_assets,
    idxdb_get_foreign_account_code,
    idxdb_get_post_undo_account_states,
    idxdb_lock_account,
    idxdb_prune_account_history,
    idxdb_upsert_foreign_account_code,
};

mod models;
use models::{
    AccountAssetIdxdbObject,
    AccountCodeIdxdbObject,
    AccountRecordIdxdbObject,
    AccountStorageIdxdbObject,
    ForeignAccountCodeIdxdbObject,
    PostUndoAccountStateIdxdbObject,
    StorageMapEntryIdxdbObject,
};

pub(crate) mod utils;
use miden_client::store::forest_backend::{
    ForestPrefetchPlan,
    LineageId,
    RowForestBackend,
    SmtForestUpdateBatch,
    plan_update,
    plan_witness_read,
};
use miden_client::store::{add_vault_ops, storage_map_lineage_id, vault_lineage_id};
use utils::{
    AccountForestTargets,
    add_storage_map_patch_ops,
    apply_account_patch,
    apply_full_account_state,
    insert_account_atomic,
    parse_account_record_idxdb_object,
    patched_storage_slots,
};

use crate::forest::cache::ForestRowCache;
use crate::forest::{self, CachedAccountForest};

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
        let Some((account_header, status, client_account_type)) =
            self.get_account_header_with_type(account_id).await?
        else {
            return Ok(None);
        };
        let account_code = self.get_account_code(account_header.code_commitment()).await?;

        let account_storage = self.get_storage(account_id, AccountStorageFilter::All).await?;
        let assets = self.get_vault_assets(account_id, vec![]).await?;
        let account_vault = AssetVault::new(&assets)?;

        let account = Account::new(
            account_header.id(),
            account_vault,
            account_storage,
            account_code,
            account_header.nonce(),
            status.seed().copied(),
        )?;

        let account_data = AccountRecordData::Full(account);
        Ok(Some(AccountRecord::new(account_data, status, client_account_type)))
    }

    pub(crate) async fn get_minimal_partial_account(
        &self,
        account_id: AccountId,
    ) -> Result<Option<AccountRecord>, StoreError> {
        let Some((account_header, status, client_account_type)) =
            self.get_account_header_with_type(account_id).await?
        else {
            return Ok(None);
        };

        let partial_vault = PartialVault::new(account_header.vault_root());

        let storage_slot_headers = self.get_storage_slot_headers(account_id).await?;

        let mut storage_header_vec = Vec::new();
        let mut maps = Vec::new();

        // Storage maps are always minimal here (just roots, no entries).
        // New accounts that need full storage data are handled by the DataStore layer,
        // which fetches the full account via `get_account()` when nonce == 0.
        for (slot_name, slot_type, value) in storage_slot_headers {
            storage_header_vec.push(StorageSlotHeader::new(slot_name, slot_type, value));
            if slot_type == StorageSlotType::Map {
                maps.push(PartialStorageMap::new(value));
            }
        }

        storage_header_vec.sort_by_key(StorageSlotHeader::id);
        let storage_header =
            AccountStorageHeader::new(storage_header_vec).map_err(StoreError::AccountError)?;
        let partial_storage =
            PartialStorage::new(storage_header, maps).map_err(StoreError::AccountError)?;

        let account_code = self.get_account_code(account_header.code_commitment()).await?;

        let partial_account = PartialAccount::new(
            account_header.id(),
            account_header.nonce(),
            account_code,
            partial_storage,
            partial_vault,
            status.seed().copied(),
        )?;

        let account_data = AccountRecordData::Partial(partial_account);
        Ok(Some(AccountRecord::new(account_data, status, client_account_type)))
    }

    pub(super) async fn get_account_code(&self, root: Word) -> Result<AccountCode, StoreError> {
        let root_serialized = root.to_string();

        let promise = idxdb_get_account_code(self.db_id(), root_serialized);
        let account_code_idxdb: AccountCodeIdxdbObject =
            await_js(promise, "failed to fetch account code").await?;

        let code = AccountCode::read_from_bytes(&account_code_idxdb.code)?;

        Ok(code)
    }

    /// Retrieves storage slot headers without fetching full map entries.
    async fn get_storage_slot_headers(
        &self,
        account_id: AccountId,
    ) -> Result<Vec<(StorageSlotName, StorageSlotType, Word)>, StoreError> {
        let account_id_str = account_id.to_string();

        let promise = idxdb_get_account_storage(self.db_id(), account_id_str, vec![]);
        let account_storage_idxdb: Vec<AccountStorageIdxdbObject> =
            await_js(promise, "failed to fetch account storage").await?;

        if account_storage_idxdb.iter().any(|s| s.slot_name.is_empty()) {
            return Err(StoreError::DatabaseError(
                "account storage entries are missing `slotName`; clear IndexedDB and re-sync"
                    .to_string(),
            ));
        }

        account_storage_idxdb
            .into_iter()
            .map(|slot| {
                let slot_name = StorageSlotName::new(slot.slot_name).map_err(|err| {
                    StoreError::DatabaseError(format!("invalid storage slot name in db: {err}"))
                })?;
                let slot_type = StorageSlotType::try_from(slot.slot_type)?;
                let value = Word::try_from(slot.slot_value.as_str())?;
                Ok((slot_name, slot_type, value))
            })
            .collect()
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

        let mut maps = BTreeMap::new();
        for entry in account_maps_idxdb {
            let map = maps.entry(entry.slot_name).or_insert_with(StorageMap::new);
            map.insert(
                StorageMapKey::new(Word::try_from(entry.key.as_str())?),
                Word::try_from(entry.value.as_str())?,
            )?;
        }

        let slots: Vec<StorageSlot> = filtered_slots
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

        let assets = vault_assets_idxdb
            .into_iter()
            .map(|entry| {
                let key_word = Word::try_from(&entry.vault_key)?;
                let value_word = Word::try_from(&entry.asset)?;
                Ok(Asset::from_id_and_value_words(key_word, value_word)?)
            })
            .collect::<Result<Vec<_>, StoreError>>()?;

        Ok(assets)
    }

    /// Returns a map from slot name to map root for Map-type storage slots.
    /// When `slot_names` is non-empty, only loads the specified slots.
    /// Only loads slot metadata — does NOT load map entries.
    pub(crate) async fn get_storage_map_roots(
        &self,
        account_id: AccountId,
        slot_names: Vec<String>,
    ) -> Result<BTreeMap<StorageSlotName, Word>, StoreError> {
        let promise = idxdb_get_account_storage(self.db_id(), account_id.to_string(), slot_names);
        let slots: Vec<AccountStorageIdxdbObject> =
            await_js(promise, "failed to fetch account storage").await?;

        slots
            .into_iter()
            .filter(|s| StorageSlotType::try_from(s.slot_type).ok() == Some(StorageSlotType::Map))
            .map(|s| {
                let name = StorageSlotName::new(s.slot_name).map_err(|err| {
                    StoreError::DatabaseError(format!("invalid storage slot name: {err}"))
                })?;
                let root = Word::try_from(s.slot_value.as_str())?;
                Ok((name, root))
            })
            .collect()
    }

    /// Applies an incremental (non-full-state) account patch: computes the new storage-map and
    /// vault roots via the SMT forest, verifies the resulting vault root against `final_header`,
    /// and persists the changes atomically.
    ///
    /// The patch's storage and vault values are already absolute, so no full account or
    /// relative-delta reconstruction is required; only the previous roots of changed maps are
    /// read back from the store.
    pub(crate) async fn apply_incremental_account_patch(
        &self,
        final_header: &AccountHeader,
        patch: &AccountPatch,
    ) -> Result<(), StoreError> {
        let account_id = final_header.id();

        // Phase 1: load the forest snapshot, then prefetch the rows the patch will read. Map
        // slots that reset (create or remove) also need their lineage's stored keys.
        let snapshot = forest::load_forest_snapshot(self.db_id()).await?;
        let revision = snapshot.next_revision;
        let cache = ForestRowCache::new(snapshot.trees.clone(), Some(revision));

        let mut reset_plan = ForestPrefetchPlan::default();
        for (slot_name, map_patch) in patch.storage().maps() {
            let patch_op = map_patch.patch_op();
            let lineage = storage_map_lineage_id(account_id, slot_name);
            if (patch_op.is_create() || patch_op.is_remove())
                && snapshot.trees.contains_key(&lineage)
            {
                reset_plan.full_lineages.insert(lineage);
            }
        }
        forest::prefetch_rows(self.db_id(), &reset_plan, &cache).await?;

        // Build one update batch covering the vault and every changed map slot.
        let mut batch = SmtForestUpdateBatch::empty();
        add_vault_ops(
            &mut batch,
            account_id,
            patch.vault().updated_assets(),
            patch.vault().removed_asset_ids().copied(),
        );
        add_storage_map_patch_ops(&cache, account_id, &mut batch, patch)?;

        let plan = plan_update(batch.clone(), &snapshot.trees);
        forest::prefetch_rows(self.db_id(), &plan, &cache).await?;

        // Phase 2: compute and stage the forest changes against the cache.
        let mut smt_forest = CachedAccountForest::new(RowForestBackend::new(cache.clone()))?;
        smt_forest.apply_updates(revision, batch)?;

        let new_vault_root = smt_forest
            .latest_root(vault_lineage_id(account_id))
            .ok_or(StoreError::AccountDataNotFound(account_id))?;
        if new_vault_root != final_header.vault_root() {
            return Err(StoreError::MerkleStoreError(MerkleError::ConflictingRoots {
                expected_root: final_header.vault_root(),
                actual_root: new_vault_root,
            }));
        }

        let updated_storage_slots = patched_storage_slots(&smt_forest, account_id, patch)?;
        let updated_assets: Vec<Asset> = patch.vault().updated_assets().collect();
        let removed_asset_ids: Vec<AssetId> = patch.vault().removed_asset_ids().copied().collect();

        // Phase 3: write account rows and forest rows in one Dexie transaction.
        drop(smt_forest);
        let forest_update = forest::forest_update_payload(cache.into_dirty_delta());
        apply_account_patch(
            self.db_id(),
            account_id,
            final_header,
            &updated_storage_slots,
            &updated_assets,
            &removed_asset_ids,
            patch,
            forest_update,
        )
        .await
        .map_err(|err| StoreError::DatabaseError(format!("failed to apply account patch: {err:?}")))
    }

    /// Computes a forest update that resets the account's lineages to the provided full state:
    /// stored keys missing from the target state are removed, all target pairs are upserted, and
    /// slots listed in `stale_map_slots` without a target are reset to the empty tree.
    pub(crate) async fn compute_account_reset_update(
        &self,
        account_id: AccountId,
        vault: &AssetVault,
        storage: &AccountStorage,
        stale_map_slots: &[StorageSlotName],
    ) -> Result<crate::forest::js_bindings::JsForestUpdate, StoreError> {
        let snapshot = forest::load_forest_snapshot(self.db_id()).await?;
        let revision = snapshot.next_revision;
        let cache = ForestRowCache::new(snapshot.trees.clone(), Some(revision));

        let (vault_target, map_targets) = forest::account_forest_targets(vault, storage);
        let empty_target = BTreeMap::new();
        let mut lineages: Vec<(LineageId, &BTreeMap<Word, Word>)> =
            vec![(vault_lineage_id(account_id), &vault_target)];
        for (slot_name, target) in &map_targets {
            lineages.push((storage_map_lineage_id(account_id, slot_name), target));
        }
        for slot_name in stale_map_slots {
            if !map_targets.contains_key(slot_name) {
                lineages.push((storage_map_lineage_id(account_id, slot_name), &empty_target));
            }
        }

        // Reconciliation reads every stored key of the touched lineages, so existing lineages
        // are prefetched with full coverage before the batch is built.
        let mut pre_plan = ForestPrefetchPlan::default();
        for (lineage, _) in &lineages {
            if snapshot.trees.contains_key(lineage) {
                pre_plan.full_lineages.insert(*lineage);
            }
        }
        forest::prefetch_rows(self.db_id(), &pre_plan, &cache).await?;

        let mut batch = SmtForestUpdateBatch::empty();
        for (lineage, target) in lineages {
            forest::add_reconcile_ops(&cache, &mut batch, lineage, target)?;
        }

        let plan = plan_update(batch.clone(), &snapshot.trees);
        forest::prefetch_rows(self.db_id(), &plan, &cache).await?;

        let mut smt_forest = CachedAccountForest::new(RowForestBackend::new(cache.clone()))?;
        smt_forest.apply_updates(revision, batch)?;
        drop(smt_forest);
        Ok(forest::forest_update_payload(cache.into_dirty_delta()))
    }

    pub(crate) async fn insert_account(
        &self,
        account: &Account,
        initial_address: Address,
        client_account_type: ClientAccountType,
    ) -> Result<(), StoreError> {
        let forest_update = self
            .compute_account_reset_update(account.id(), account.vault(), account.storage(), &[])
            .await?;

        insert_account_atomic(
            self.db_id(),
            account,
            client_account_type,
            initial_address,
            forest_update,
        )
        .await
        .map_err(|js_error| {
            StoreError::DatabaseError(format!("failed to insert account: {js_error:?}"))
        })
    }

    pub(crate) async fn update_account(
        &self,
        new_account_state: &Account,
    ) -> Result<(), StoreError> {
        let account_id = new_account_state.id();
        self.get_account_header(account_id)
            .await?
            .ok_or(StoreError::AccountDataNotFound(account_id))?;

        // Map slots stored today but absent from the new state reset to the empty tree.
        let stale_map_slots: Vec<StorageSlotName> =
            self.get_storage_map_roots(account_id, Vec::new()).await?.into_keys().collect();
        let forest_update = self
            .compute_account_reset_update(
                account_id,
                new_account_state.vault(),
                new_account_state.storage(),
                &stale_map_slots,
            )
            .await?;

        apply_full_account_state(self.db_id(), new_account_state, forest_update)
            .await
            .map_err(|_| StoreError::DatabaseError("failed to update account".to_string()))?;

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

        let snapshot = forest::load_forest_snapshot(self.db_id()).await?;
        let plan = plan_witness_read(vault_lineage_id(account_id), vault_id.hash().into());
        let (smt_forest, _cache) =
            forest::forest_for_plan(self.db_id(), snapshot, &plan, false).await?;

        match smt_forest.get_asset_and_witness(account_id, account_header.vault_root(), vault_id) {
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
        let map_root = Word::try_from(slot.slot_value.as_str())?;

        let snapshot = forest::load_forest_snapshot(self.db_id()).await?;
        let lineage = storage_map_lineage_id(account_id, &slot_name);
        let plan = plan_witness_read(lineage, Word::from(key.hash()));
        let (smt_forest, _cache) =
            forest::forest_for_plan(self.db_id(), snapshot, &plan, false).await?;

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
        let code = code.to_bytes();
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
                let code = AccountCode::read_from_bytes(&idxdb_object.code)?;

                Ok((account_id, code))
            })
            .collect::<Result<BTreeMap<AccountId, AccountCode>, StoreError>>()?;

        Ok(foreign_account_code)
    }

    /// Reads, without writing, the latest account state that undoing the provided commitments
    /// would restore for each affected account.
    pub(crate) async fn get_post_undo_account_states(
        &self,
        account_commitments: &[String],
    ) -> Result<Vec<PostUndoAccountStateIdxdbObject>, StoreError> {
        if account_commitments.is_empty() {
            return Ok(Vec::new());
        }
        let promise =
            idxdb_get_post_undo_account_states(self.db_id(), account_commitments.to_vec());
        await_js(promise, "failed to compute post-undo account states").await
    }

    /// Adds reconcile operations for explicit per-account targets, prefetching full coverage of
    /// every candidate lineage (targets plus currently stored map slots) that exists.
    pub(crate) async fn add_targets_reconcile_ops(
        &self,
        snapshot: &forest::ForestSnapshot,
        cache: &ForestRowCache,
        batch: &mut SmtForestUpdateBatch,
        targets: &[AccountForestTargets],
    ) -> Result<(), StoreError> {
        let empty_target = BTreeMap::new();
        let mut pre_plan = ForestPrefetchPlan::default();
        let mut jobs: Vec<(LineageId, &BTreeMap<Word, Word>)> = Vec::new();

        for target in targets {
            let account_id = target.account_id;
            jobs.push((vault_lineage_id(account_id), &target.vault));
            let mut candidate_slots: Vec<StorageSlotName> = target.maps.keys().cloned().collect();
            // Map slots stored today but absent from the target reset to the empty tree.
            for slot_name in self.get_storage_map_roots(account_id, Vec::new()).await?.into_keys() {
                if !target.maps.contains_key(&slot_name) && !candidate_slots.contains(&slot_name) {
                    candidate_slots.push(slot_name);
                }
            }
            for slot_name in candidate_slots {
                let lineage = storage_map_lineage_id(account_id, &slot_name);
                let target_entries = target.maps.get(&slot_name).unwrap_or(&empty_target);
                jobs.push((lineage, target_entries));
            }
        }

        for (lineage, _) in &jobs {
            if snapshot.trees.contains_key(lineage) {
                pre_plan.full_lineages.insert(*lineage);
            }
        }
        forest::prefetch_rows(self.db_id(), &pre_plan, cache).await?;

        for (lineage, target) in jobs {
            forest::add_reconcile_ops(cache, batch, lineage, target)?;
        }
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

    pub(crate) async fn remove_address(&self, address: Address) -> Result<(), StoreError> {
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
