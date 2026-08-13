use alloc::collections::BTreeMap;
use alloc::string::ToString;
use alloc::vec::Vec;

use miden_client::account::{
    Account,
    AccountCode,
    AccountHeader,
    AccountId,
    AccountPatch,
    AccountStorage,
    Address,
    StorageMap,
    StorageSlotContent,
    StorageSlotName,
    StorageSlotType,
};
use miden_client::asset::{Asset, AssetId, AssetVault};
use miden_client::store::{AccountSmtForest, AccountStatus, ClientAccountType, StoreError};
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
    idxdb_upsert_account_code,
    idxdb_upsert_account_record,
    idxdb_upsert_account_storage,
    idxdb_upsert_storage_map_entries,
    idxdb_upsert_vault_assets,
};
use crate::account::js_bindings::idxdb_insert_account_address;
use crate::account::models::{AccountRecordIdxdbObject, AddressIdxdbObject};
use crate::sync::JsAccountUpdate;

pub async fn upsert_account_code(db_id: &str, account_code: &AccountCode) -> Result<(), JsValue> {
    let root = account_code.commitment().to_string();
    let code = account_code.to_bytes();

    let promise = idxdb_upsert_account_code(db_id, root, code);
    JsFuture::from(promise).await?;

    Ok(())
}

pub async fn upsert_account_storage(
    db_id: &str,
    account_id: &AccountId,
    account_storage: &AccountStorage,
) -> Result<(), JsValue> {
    let mut slots = vec![];
    let mut maps = vec![];
    for slot in account_storage.slots() {
        slots.push(JsStorageSlot::from_slot(slot));
        if let StorageSlotContent::Map(map) = slot.content() {
            maps.extend(JsStorageMapEntry::from_map(map, slot.name().as_str()));
        }
    }

    let account_id_str = account_id.to_string();
    JsFuture::from(idxdb_upsert_account_storage(db_id, account_id_str.clone(), slots)).await?;
    JsFuture::from(idxdb_upsert_storage_map_entries(db_id, account_id_str, maps)).await?;

    Ok(())
}

pub async fn upsert_account_asset_vault(
    db_id: &str,
    account_id: &AccountId,
    asset_vault: &AssetVault,
) -> Result<(), JsValue> {
    let js_assets: Vec<JsVaultAsset> =
        asset_vault.assets().map(|asset| JsVaultAsset::from_asset(&asset)).collect();

    let promise = idxdb_upsert_vault_assets(db_id, account_id.to_string(), js_assets);
    JsFuture::from(promise).await?;

    Ok(())
}

pub async fn upsert_account_record(
    db_id: &str,
    account: &Account,
    client_account_type: ClientAccountType,
) -> Result<(), JsValue> {
    let account_id_str = account.id().to_string();
    let code_root = account.code().commitment().to_string();
    let storage_root = account.storage().to_commitment().to_string();
    let vault_root = account.vault().root().to_string();
    let committed = account.is_public();
    let nonce = account.nonce().to_string();
    let account_seed = account.seed().map(|seed| seed.to_bytes());
    let commitment = account.to_commitment().to_string();
    let watched = matches!(client_account_type, ClientAccountType::Watched);

    let promise = idxdb_upsert_account_record(
        db_id,
        account_id_str,
        code_root,
        storage_root,
        vault_root,
        nonce,
        committed,
        commitment,
        account_seed,
        watched,
    );
    JsFuture::from(promise).await?;

    Ok(())
}

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

/// Computes the final values and map roots for the storage changes in `patch`.
pub fn compute_storage_patch(
    smt_forest: &mut AccountSmtForest,
    old_map_roots: &BTreeMap<StorageSlotName, Word>,
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

    let default_map_root = StorageMap::default().root();

    for (slot_name, map_patch) in patch.storage().maps() {
        let patch_op = map_patch.patch_op();
        let new_root = if patch_op.is_remove() {
            None
        } else {
            let old_root = if patch_op.is_create() {
                default_map_root
            } else {
                old_map_roots.get(slot_name).copied().ok_or_else(|| {
                    StoreError::DatabaseError(format!(
                        "storage map slot {slot_name} is missing while applying an update",
                    ))
                })?
            };
            let entries = map_patch
                .entries()
                .expect("create and update map patches always contain entries");
            Some(smt_forest.update_storage_map_nodes(
                old_root,
                entries.as_map().iter().map(|(key, value)| (*key, *value)),
            )?)
        };
        updated_slots.insert(slot_name.clone(), (new_root, StorageSlotType::Map, patch_op.as_u8()));
    }

    Ok(updated_slots)
}

/// Applies changed storage-map roots to the root list tracked by [`AccountSmtForest`].
pub fn update_tracked_storage_roots(
    tracked_roots: &mut Vec<Word>,
    old_map_roots: &BTreeMap<StorageSlotName, Word>,
    patched_slots: &PatchedStorageSlots,
) -> Result<(), StoreError> {
    for (slot_name, (new_root, slot_type, _patch_op)) in patched_slots {
        if *slot_type != StorageSlotType::Map {
            continue;
        }

        let old_root = old_map_roots.get(slot_name).copied();
        let old_root_position = old_root.and_then(|old_root| {
            // The vault root is always first and can equal a storage-map root (notably for empty
            // trees), so only search the storage-map portion of the list.
            tracked_roots
                .iter()
                .enumerate()
                .skip(1)
                .find_map(|(position, root)| (*root == old_root).then_some(position))
        });

        match (old_root, old_root_position, new_root) {
            (Some(_), Some(position), Some(new_root)) => tracked_roots[position] = *new_root,
            (Some(old_root), None, _) => {
                return Err(StoreError::DatabaseError(format!(
                    "storage map root {} for slot {slot_name} is not tracked",
                    old_root.to_hex(),
                )));
            },
            (None, _, Some(new_root)) => tracked_roots.push(*new_root),
            (Some(_), Some(position), None) => {
                tracked_roots.remove(position);
            },
            (None, _, None) => {
                return Err(StoreError::DatabaseError(format!(
                    "storage map slot {slot_name} is missing while applying a removal",
                )));
            },
        }
    }

    Ok(())
}

/// Applies an account patch atomically in a single Dexie transaction.
///
/// Takes pre-computed values (storage roots from SMT forest, vault changes) instead of
/// the full Account object. This avoids loading account code and full storage map entries.
pub async fn apply_account_patch(
    db_id: &str,
    account_id: AccountId,
    final_header: &AccountHeader,
    updated_storage_slots: &PatchedStorageSlots,
    updated_assets: &[Asset],
    removed_asset_ids: &[AssetId],
    patch: &AccountPatch,
) -> Result<(), JsValue> {
    let account_id_str = account_id.to_string();
    let nonce_str = final_header.nonce().to_string();

    // Build updated slot JS objects from pre-computed storage roots
    let mut js_slots = Vec::new();
    for (slot_name, (value, slot_type, patch_op)) in updated_storage_slots {
        js_slots.push(JsStorageSlot {
            slot_name: slot_name.to_string(),
            slot_value: value.map(|value| value.to_hex()),
            slot_type: *slot_type as u8,
            patch_operation: *patch_op,
        });
    }

    // Build changed map entries from the absolute patch. Map creation/removal is represented by
    // the slot's patch operation above; individual entries carry their final values (`None` for
    // removed entries).
    let mut changed_map_entries = Vec::new();
    for (slot_name, map_patch) in patch.storage().maps() {
        let Some(entries) = map_patch.entries() else {
            continue;
        };
        for (key, value) in entries.as_map() {
            let value = (!value.is_empty()).then(|| value.to_hex());

            changed_map_entries.push(JsStorageMapEntry {
                slot_name: slot_name.to_string(),
                key: Word::from(*key).to_hex(),
                value,
            });
        }
    }

    // Build changed assets: updated assets + removal markers
    let mut changed_assets: Vec<JsVaultAsset> =
        updated_assets.iter().map(JsVaultAsset::from_asset).collect();

    for asset_id in removed_asset_ids {
        changed_assets.push(JsVaultAsset {
            vault_key: asset_id.to_string(),
            asset: None,
        });
    }

    // Account record fields from final header
    let code_root = final_header.code_commitment().to_string();
    let storage_root = final_header.storage_commitment().to_string();
    let vault_root = final_header.vault_root().to_string();
    let committed = account_id.is_public();
    let commitment = final_header.to_commitment().to_string();
    JsFuture::from(idxdb_apply_account_patch(
        db_id,
        account_id_str,
        nonce_str,
        js_slots,
        changed_map_entries,
        changed_assets,
        code_root,
        storage_root,
        vault_root,
        committed,
        commitment,
    ))
    .await?;

    Ok(())
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

/// Writes the full account state atomically in a single Dexie transaction.
/// Combines storage upsert + map entries upsert + vault assets upsert + account record upsert.
pub async fn apply_full_account_state(db_id: &str, account: &Account) -> Result<(), JsValue> {
    let account_state = JsAccountUpdate::from_account(account, account.seed());

    JsFuture::from(idxdb_apply_full_account_state(db_id, account_state)).await?;

    Ok(())
}
