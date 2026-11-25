use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use miden_client::account::{
    Account,
    AccountHeader,
    AccountId,
    AccountPatch,
    Address,
    StorageSlotContent,
    StorageSlotName,
    StorageSlotType,
};
use miden_client::store::{AccountStatus, ClientAccountType, StoreError};
use miden_client::utils::{Deserializable, Serializable};
use miden_client::{Felt, Word};
use miden_client_proto::encode;
use wasm_bindgen::{JsError, JsValue};
use wasm_bindgen_futures::JsFuture;

use super::js_bindings::{
    JsStorageMapEntry,
    JsStorageSlot,
    JsVaultAsset,
    idxdb_apply_full_account_state,
    idxdb_insert_account,
};
use crate::account::js_bindings::idxdb_insert_account_address;
use crate::account::models::{AccountRecordIdxdbObject, AddressIdxdbObject};
use crate::sync::JsAccountUpdate;

/// Writes code, storage, vault, header and address in one `IndexedDB` transaction.
pub async fn insert_account(
    db_id: &str,
    account: &Account,
    initial_address: Address,
    client_account_type: ClientAccountType,
) -> Result<(), JsValue> {
    let mut slots = vec![];
    let mut maps = vec![];
    for slot in account.storage().slots() {
        slots.push(JsStorageSlot::from_slot(slot));
        if let StorageSlotContent::Map(map) = slot.content() {
            maps.extend(JsStorageMapEntry::from_map(map, slot.name().as_str()));
        }
    }
    let assets: Vec<JsVaultAsset> =
        account.vault().assets().map(|asset| JsVaultAsset::from_asset(&asset)).collect();

    let promise = idxdb_insert_account(
        db_id,
        account.id().to_string(),
        account.code().commitment().to_string(),
        encode(account.code()),
        slots,
        maps,
        assets,
        account.storage().to_commitment().to_string(),
        account.vault().root().to_string(),
        account.nonce().to_string(),
        account.is_public(),
        account.to_commitment().to_string(),
        account.seed().map(|seed| seed.to_bytes()),
        matches!(client_account_type, ClientAccountType::Watched),
        initial_address.to_bytes(),
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

/// Resolves to whether the address was tracked, which `Store::remove_address`
/// reports to its caller.
pub async fn remove_account_address(db_id: &str, address: Address) -> Result<bool, JsValue> {
    let serialized_address = address.to_bytes();
    let promise = crate::account::js_bindings::idxdb_remove_account_address(
        db_id,
        serialized_address.clone(),
    );
    let removed = JsFuture::from(promise).await?;

    removed
        .as_bool()
        .ok_or_else(|| JsError::new("removeAccountAddress did not resolve to a boolean").into())
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

/// Builds the JS-side objects an account-patch write needs: the updated storage slots, the map
/// entries carried by the patch, and the changed vault assets (updates plus removal markers).
///
/// `new_map_roots` holds the root the forest computed for each changed map slot. Removed slots are
/// absent from it: their rows are deleted rather than rewritten, so they have no root. Everything
/// else is read off `patch`.
pub fn build_account_patch_payload(
    new_map_roots: &BTreeMap<StorageSlotName, Word>,
    patch: &AccountPatch,
) -> (Vec<JsStorageSlot>, Vec<JsStorageMapEntry>, Vec<JsVaultAsset>) {
    // A removed map has no root; its empty value tells the JS layer to delete the row.
    let mut js_slots: Vec<JsStorageSlot> = patch
        .storage()
        .values()
        .map(|(slot_name, value_patch)| JsStorageSlot {
            slot_name: slot_name.to_string(),
            slot_value: value_patch.value().map_or_else(String::new, |value| value.to_hex()),
            slot_type: StorageSlotType::Value as u8,
            patch_operation: value_patch.patch_op().as_u8(),
        })
        .chain(patch.storage().maps().map(|(slot_name, map_patch)| JsStorageSlot {
            slot_name: slot_name.to_string(),
            slot_value: new_map_roots.get(slot_name).map_or_else(String::new, Word::to_hex),
            slot_type: StorageSlotType::Map as u8,
            patch_operation: map_patch.patch_op().as_u8(),
        }))
        .collect();
    js_slots.sort_by(|a, b| a.slot_name.cmp(&b.slot_name));

    // Map creation/removal is represented by the slot's patch operation above; individual entries
    // carry their final values.
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

    let changed_assets: Vec<JsVaultAsset> = patch
        .vault()
        .updated_assets()
        .map(|asset| JsVaultAsset::from_asset(&asset))
        .chain(patch.vault().removed_asset_ids().map(|asset_id| JsVaultAsset {
            vault_key: asset_id.to_string(),
            asset: String::new(),
        }))
        .collect();

    (js_slots, changed_map_entries, changed_assets)
}

/// Bytes of the code a patch carries, or empty when it carries none.
///
/// The header names code by commitment, so a carried code that does not match the final header is
/// rejected before anything is written.
pub fn patch_code_bytes(
    patch: &AccountPatch,
    final_header: &AccountHeader,
) -> Result<Vec<u8>, StoreError> {
    match patch.code().as_code() {
        Some(code) if code.commitment() == final_header.code_commitment() => Ok(encode(code)),
        Some(code) => Err(StoreError::DatabaseError(format!(
            "account patch code commitment {} does not match the final code commitment {}",
            code.commitment(),
            final_header.code_commitment()
        ))),
        None => Ok(Vec::new()),
    }
}

/// Reconstructs an account from a creation patch.
///
/// A creation patch has final nonce 1. [`AccountPatch::try_to_new_account`] can also succeed for a
/// later patch whose storage happens to contain only creates, and that account would not be the
/// one on chain, so the nonce is checked first. Code on a patch with a higher nonce is an upgrade
/// and returns [`None`], so the caller applies it incrementally.
pub fn creation_account_from_patch(
    patch: &AccountPatch,
    expected_header: &AccountHeader,
) -> Result<Option<Account>, StoreError> {
    if expected_header.nonce().as_canonical_u64() != 1 {
        return Ok(None);
    }
    let Ok(account) = patch.try_to_new_account() else {
        return Ok(None);
    };
    if account.to_commitment() != expected_header.to_commitment() {
        return Err(StoreError::AccountCommitmentMismatch(account.id()));
    }
    Ok(Some(account))
}

/// Writes the full account state atomically in a single Dexie transaction.
/// Combines storage upsert + map entries upsert + vault assets upsert + account record upsert.
pub async fn apply_full_account_state(db_id: &str, account: &Account) -> Result<(), JsValue> {
    let account_state = JsAccountUpdate::from_account(account, account.seed());

    JsFuture::from(idxdb_apply_full_account_state(db_id, account_state)).await?;

    Ok(())
}
