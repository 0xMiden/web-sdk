use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::account::{
    Account,
    AccountHeader,
    AccountId,
    AccountPatch,
    Address,
    StorageMapKey,
    StorageSlotName,
    StorageSlotType,
};
use miden_client::asset::{Asset, AssetId};
use miden_client::store::forest_backend::{ForestRowStore, SmtForestUpdateBatch};
use miden_client::store::{
    AccountStatus,
    ClientAccountType,
    StoreError,
    add_storage_map_ops,
    storage_map_lineage_id,
};
use miden_client::utils::{Deserializable, Serializable};
use miden_client::{Felt, Word};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

use super::js_bindings::{
    JsStorageMapEntry,
    JsStorageSlot,
    JsVaultAsset,
    idxdb_apply_account_patch,
    idxdb_apply_full_account_state,
    idxdb_insert_account,
};
use crate::account::js_bindings::idxdb_insert_account_address;
use crate::account::models::{
    AccountRecordIdxdbObject,
    AddressIdxdbObject,
    PostUndoAccountStateIdxdbObject,
};
use crate::forest::CachedAccountForest;
use crate::forest::cache::ForestRowCache;
use crate::sync::{JsAccountPatchUpdate, JsAccountUpdate};

pub async fn insert_account_address(
    db_id: &str,
    account_id: &AccountId,
    address: Address,
) -> Result<(), JsValue> {
    let account_id_str = account_id.to_string();
    let serialized_address = address.to_bytes();
    let promise = idxdb_insert_account_address(db_id, account_id_str, serialized_address);
    JsFuture::from(promise).await?;

    Ok(())
}

pub async fn remove_account_address(db_id: &str, address: Address) -> Result<(), JsValue> {
    let serialized_address = address.to_bytes();
    let promise = crate::account::js_bindings::idxdb_remove_account_address(
        db_id,
        serialized_address.clone(),
    );
    JsFuture::from(promise).await?;

    Ok(())
}

pub fn parse_account_record_idxdb_object(
    account_header_idxdb: AccountRecordIdxdbObject,
) -> Result<(AccountHeader, AccountStatus, ClientAccountType), StoreError> {
    let native_account_id: AccountId = AccountId::from_hex(&account_header_idxdb.id)?;
    let native_nonce: u64 = account_header_idxdb
        .nonce
        .parse::<u64>()
        .map_err(|err| StoreError::ParsingError(err.to_string()))?;
    let nonce = Felt::new(native_nonce)
        .map_err(|err| StoreError::ParsingError(format!("invalid account nonce: {err}")))?;
    let account_seed = account_header_idxdb
        .account_seed
        .map(|seed| Word::read_from_bytes(&seed))
        .transpose()?;

    let account_header = AccountHeader::new(
        native_account_id,
        nonce,
        Word::try_from(&account_header_idxdb.vault_root)?,
        Word::try_from(&account_header_idxdb.storage_root)?,
        Word::try_from(&account_header_idxdb.code_root)?,
    );

    let status = match (account_seed, account_header_idxdb.locked) {
        (seed, true) => AccountStatus::Locked { seed },
        (Some(seed), _) => AccountStatus::New { seed },
        _ => AccountStatus::Tracked,
    };

    let client_account_type = if account_header_idxdb.watched {
        ClientAccountType::Watched
    } else {
        ClientAccountType::Native
    };

    Ok((account_header, status, client_account_type))
}

pub fn parse_account_address_idxdb_object(
    account_address_idxdb: &AddressIdxdbObject,
) -> Result<(Address, AccountId), StoreError> {
    let native_account_id: AccountId = AccountId::from_hex(&account_address_idxdb.id)?;

    let address = Address::read_from_bytes(&account_address_idxdb.address)?;

    Ok((address, native_account_id))
}

/// Storage slot changes derived from an account patch.
///
/// The optional word is the slot's final value/root. It is `None` when the slot is removed.
pub type PatchedStorageSlots = BTreeMap<StorageSlotName, (Option<Word>, StorageSlotType, u8)>;

/// Adds the storage-map operations of `patch` to a forest update batch, returning the touched
/// map slot names.
///
/// Create and remove patches first remove every key currently stored for the slot's lineage
/// (read through the prefetched `rows`); keys re-inserted by the patch below win over these
/// removals because the batch keeps the last operation per key.
pub fn add_storage_map_patch_ops(
    rows: &ForestRowCache,
    account_id: AccountId,
    batch: &mut SmtForestUpdateBatch,
    patch: &AccountPatch,
) -> Result<Vec<StorageSlotName>, StoreError> {
    let mut touched = Vec::new();
    for (slot_name, map_patch) in patch.storage().maps() {
        touched.push(slot_name.clone());
        let lineage = storage_map_lineage_id(account_id, slot_name);

        let patch_op = map_patch.patch_op();
        if patch_op.is_create() || patch_op.is_remove() {
            let mut stored_keys = Vec::new();
            rows.for_each_entry(lineage, &mut |row| {
                stored_keys.push(row.key);
                Ok(())
            })
            .map_err(crate::forest::backend_error)?;
            for key in stored_keys {
                batch.operations(lineage).add_remove(key);
            }
        }

        let entries = map_patch
            .entries()
            .into_iter()
            .flat_map(|e| e.as_map().iter())
            .map(|(key, value)| (*key, *value));
        add_storage_map_ops(batch, account_id, slot_name, entries);
    }
    Ok(touched)
}

/// Collects the final values and map roots for the storage changes in `patch`.
///
/// Value slots come straight from the patch; map roots are read from `forest` after the update
/// batch was applied, so they reflect the persisted post-apply state.
pub fn patched_storage_slots(
    forest: &CachedAccountForest,
    account_id: AccountId,
    patch: &AccountPatch,
) -> Result<PatchedStorageSlots, StoreError> {
    let mut updated_slots: PatchedStorageSlots = patch
        .storage()
        .values()
        .map(|(slot_name, value_patch)| {
            (
                slot_name.clone(),
                (value_patch.value(), StorageSlotType::Value, value_patch.patch_op().as_u8()),
            )
        })
        .collect();

    for (slot_name, map_patch) in patch.storage().maps() {
        let patch_op = map_patch.patch_op();
        let new_root = if patch_op.is_remove() {
            None
        } else {
            let lineage = storage_map_lineage_id(account_id, slot_name);
            Some(forest.latest_root(lineage).ok_or_else(|| {
                StoreError::DatabaseError(format!(
                    "storage map slot {slot_name} has no forest root after applying an update",
                ))
            })?)
        };
        updated_slots.insert(slot_name.clone(), (new_root, StorageSlotType::Map, patch_op.as_u8()));
    }

    Ok(updated_slots)
}

/// Applies an account patch atomically in a single Dexie transaction.
///
/// Takes pre-computed values (storage roots from SMT forest, vault changes) instead of
/// the full Account object. This avoids loading account code and full storage map entries.
/// The write transaction validates that the stored account still matches `init_header`'s
/// commitment before writing.
#[allow(clippy::too_many_arguments)]
pub async fn apply_account_patch(
    db_id: &str,
    account_id: AccountId,
    init_header: &AccountHeader,
    final_header: &AccountHeader,
    updated_storage_slots: &PatchedStorageSlots,
    updated_assets: &[Asset],
    removed_asset_ids: &[AssetId],
    patch: &AccountPatch,
    forest_update: JsValue,
) -> Result<(), JsValue> {
    let update = build_js_account_patch_update(
        account_id,
        final_header,
        updated_storage_slots,
        updated_assets,
        removed_asset_ids,
        patch,
    );

    JsFuture::from(idxdb_apply_account_patch(
        db_id,
        update.account_id,
        update.nonce,
        update.updated_slots,
        update.changed_map_entries,
        update.changed_assets,
        update.code_root,
        update.storage_root,
        update.vault_root,
        update.committed,
        update.commitment,
        init_header.to_commitment().to_string(),
        forest_update,
    ))
    .await?;

    Ok(())
}

/// Serializes the per-account pieces of an incremental patch for the JS write functions.
pub fn build_js_account_patch_update(
    account_id: AccountId,
    final_header: &AccountHeader,
    updated_storage_slots: &PatchedStorageSlots,
    updated_assets: &[Asset],
    removed_asset_ids: &[AssetId],
    patch: &AccountPatch,
) -> JsAccountPatchUpdate {
    // Build updated slot JS objects from pre-computed storage roots
    let mut js_slots = Vec::new();
    for (slot_name, (value, slot_type, patch_op)) in updated_storage_slots {
        js_slots.push(JsStorageSlot {
            slot_name: slot_name.to_string(),
            slot_value: value.map_or_else(String::new, |value| value.to_hex()),
            slot_type: *slot_type as u8,
            patch_operation: *patch_op,
        });
    }

    // Build changed map entries from the absolute patch. Map creation/removal is represented by
    // the slot's patch operation above; individual entries carry their final values.
    let mut changed_map_entries = Vec::new();
    for (slot_name, map_patch) in patch.storage().maps() {
        let Some(entries) = map_patch.entries() else {
            continue;
        };
        for (key, value) in entries.as_map() {
            let value_str = if value.is_empty() {
                String::new()
            } else {
                value.to_hex()
            };

            changed_map_entries.push(JsStorageMapEntry {
                slot_name: slot_name.to_string(),
                key: Word::from(*key).to_hex(),
                value: value_str,
            });
        }
    }

    // Build changed assets: updated assets + removal markers
    let mut changed_assets: Vec<JsVaultAsset> =
        updated_assets.iter().map(JsVaultAsset::from_asset).collect();

    for asset_id in removed_asset_ids {
        changed_assets.push(JsVaultAsset {
            vault_key: asset_id.to_string(),
            asset: String::new(),
        });
    }

    JsAccountPatchUpdate {
        account_id: account_id.to_string(),
        nonce: final_header.nonce().to_string(),
        updated_slots: js_slots,
        changed_map_entries,
        changed_assets,
        code_root: final_header.code_commitment().to_string(),
        storage_root: final_header.storage_commitment().to_string(),
        vault_root: final_header.vault_root().to_string(),
        committed: account_id.is_public(),
        commitment: final_header.to_commitment().to_string(),
    }
}

/// Converts a full-state account patch into an [`Account`] and verifies that its commitment
/// matches the expected final header.
pub fn account_from_full_state_patch(
    patch: &AccountPatch,
    expected_header: &AccountHeader,
) -> Result<Account, StoreError> {
    let account = Account::try_from(patch)?;
    if account.to_commitment() != expected_header.to_commitment() {
        return Err(StoreError::AccountCommitmentMismatch(account.id()));
    }
    Ok(account)
}

/// Inserts a new account's code, storage, vault, header and address rows plus its forest rows
/// in one Dexie transaction. Fails if the account already exists.
pub async fn insert_account_atomic(
    db_id: &str,
    account: &Account,
    client_account_type: ClientAccountType,
    initial_address: Address,
    forest_update: JsValue,
) -> Result<(), JsValue> {
    let account_state = JsAccountUpdate::from_account(account, account.seed());
    let code_root = account.code().commitment().to_string();
    let code = account.code().to_bytes();
    let address = initial_address.to_bytes();
    let watched = matches!(client_account_type, ClientAccountType::Watched);

    JsFuture::from(idxdb_insert_account(
        db_id,
        account_state,
        code,
        code_root,
        address,
        watched,
        forest_update,
    ))
    .await?;
    Ok(())
}

/// Writes the full account state atomically in a single Dexie transaction.
/// Combines storage upsert + map entries upsert + vault assets upsert + account record upsert,
/// plus the account's forest row changes.
///
/// With `expected_initial_commitment`, the write transaction requires the stored account to
/// still match that commitment (local transaction results pin their exact base state); without
/// it, the transaction only rejects a nonce regression (network updates supersede by nonce).
pub async fn apply_full_account_state(
    db_id: &str,
    account: &Account,
    forest_update: JsValue,
    expected_initial_commitment: Option<String>,
) -> Result<(), JsValue> {
    let account_state = JsAccountUpdate::from_account(account, account.seed());

    JsFuture::from(idxdb_apply_full_account_state(
        db_id,
        account_state,
        forest_update,
        expected_initial_commitment,
    ))
    .await?;

    Ok(())
}

// FOREST TARGETS
// ================================================================================================

/// Explicit forest target state of one account, keyed by hashed SMT key.
pub struct AccountForestTargets {
    pub account_id: AccountId,
    pub vault: BTreeMap<Word, Word>,
    pub maps: BTreeMap<StorageSlotName, BTreeMap<Word, Word>>,
}

/// Parses the post-undo resolver's rows into forest targets.
pub fn parse_post_undo_targets(
    state: &PostUndoAccountStateIdxdbObject,
) -> Result<AccountForestTargets, StoreError> {
    let account_id = AccountId::from_hex(&state.account_id)?;

    let mut vault = BTreeMap::new();
    for row in &state.vault_assets {
        let key_word = Word::try_from(&row.vault_key)?;
        let value_word = Word::try_from(&row.asset)?;
        let asset = Asset::from_id_and_value_words(key_word, value_word)?;
        vault.insert(asset.id().hash().into(), asset.to_value_word());
    }

    let mut maps: BTreeMap<StorageSlotName, BTreeMap<Word, Word>> = BTreeMap::new();
    // Seed map slots first so a map that is empty after the undo still reconciles to the empty
    // tree.
    for slot in &state.storage_slots {
        if StorageSlotType::try_from(slot.slot_type).ok() == Some(StorageSlotType::Map) {
            let slot_name = StorageSlotName::new(slot.slot_name.clone())
                .map_err(|e| StoreError::ParsingError(e.to_string()))?;
            maps.entry(slot_name).or_default();
        }
    }
    for row in &state.storage_map_entries {
        let slot_name = StorageSlotName::new(row.slot_name.clone())
            .map_err(|e| StoreError::ParsingError(e.to_string()))?;
        let key = StorageMapKey::new(Word::try_from(&row.key)?);
        maps.entry(slot_name)
            .or_default()
            .insert(Word::from(key.hash()), Word::try_from(&row.value)?);
    }

    Ok(AccountForestTargets { account_id, vault, maps })
}

/// Overlays an incremental patch's absolute values onto reconcile targets.
pub fn overlay_patch_on_targets(targets: &mut AccountForestTargets, patch: &AccountPatch) {
    for asset in patch.vault().updated_assets() {
        targets.vault.insert(asset.id().hash().into(), asset.to_value_word());
    }
    for asset_id in patch.vault().removed_asset_ids() {
        targets.vault.remove(&Word::from(asset_id.hash()));
    }

    for (slot_name, map_patch) in patch.storage().maps() {
        let patch_op = map_patch.patch_op();
        if patch_op.is_remove() {
            targets.maps.remove(slot_name);
            continue;
        }
        if patch_op.is_create() {
            targets.maps.insert(slot_name.clone(), BTreeMap::new());
        }
        let slot_target = targets.maps.entry(slot_name.clone()).or_default();
        if let Some(entries) = map_patch.entries() {
            for (key, value) in entries.as_map() {
                let key_word = Word::from(key.hash());
                if value.is_empty() {
                    slot_target.remove(&key_word);
                } else {
                    slot_target.insert(key_word, *value);
                }
            }
        }
    }
}
