use alloc::string::{String, ToString};
use alloc::vec::Vec;

use chrono::Utc;
use miden_client::Word;
use miden_client::account::AccountId;
use miden_client::note::{
    NoteAssets,
    NoteAttachments,
    NoteDetails,
    NoteMetadata,
    NoteRecipient,
    NoteScript,
    NoteStorage,
    NoteUpdateTracker,
    Nullifier,
};
use miden_client::store::{InputNoteRecord, InputNoteState, OutputNoteRecord, StoreError};
use miden_client::utils::{Deserializable, Serializable};
use miden_client_proto::{
    decode_output_note_state_without_script,
    decode_unchecked,
    encode,
    encode_output_note_state_without_script,
};
use serde::Serialize;
use wasm_bindgen::prelude::wasm_bindgen;

use super::js_bindings::{
    idxdb_upsert_input_note,
    idxdb_upsert_note_script,
    idxdb_upsert_output_note,
};
use super::{InputNoteIdxdbObject, OutputNoteIdxdbObject};
use crate::note::models::NoteScriptIdxdbObject;
use crate::promise::await_js_value;

// TYPES
// ================================================================================================

#[wasm_bindgen(getter_with_clone)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedInputNoteData {
    #[wasm_bindgen(js_name = "detailsCommitment")]
    pub details_commitment: String,
    #[wasm_bindgen(js_name = "noteId")]
    pub note_id: Option<String>,
    #[wasm_bindgen(js_name = "noteAssets")]
    #[serde(with = "serde_bytes")]
    pub note_assets: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub attachments: Vec<u8>,
    #[wasm_bindgen(js_name = "serialNumber")]
    #[serde(with = "serde_bytes")]
    pub serial_number: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub inputs: Vec<u8>,
    #[wasm_bindgen(js_name = "noteScriptRoot")]
    pub note_script_root: String,
    #[wasm_bindgen(js_name = "noteScript")]
    #[serde(with = "serde_bytes")]
    pub note_script: Vec<u8>,
    pub nullifier: Option<String>,
    #[wasm_bindgen(js_name = "stateDiscriminant")]
    pub state_discriminant: u8,
    #[serde(with = "serde_bytes")]
    pub state: Vec<u8>,
    #[wasm_bindgen(js_name = "createdAt")]
    pub created_at: String,
    #[wasm_bindgen(js_name = "consumedBlockHeight")]
    pub consumed_block_height: Option<u32>,
    #[wasm_bindgen(js_name = "consumedTxOrder")]
    pub consumed_tx_order: Option<u32>,
    #[wasm_bindgen(js_name = "consumerAccountId")]
    pub consumer_account_id: Option<String>,
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedOutputNoteData {
    #[wasm_bindgen(js_name = "detailsCommitment")]
    pub details_commitment: String,
    #[wasm_bindgen(js_name = "noteId")]
    pub note_id: String,
    #[wasm_bindgen(js_name = "noteAssets")]
    #[serde(with = "serde_bytes")]
    pub note_assets: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub attachments: Vec<u8>,
    #[wasm_bindgen(js_name = "recipientDigest")]
    pub recipient_digest: String,
    #[serde(with = "serde_bytes")]
    pub metadata: Vec<u8>,
    #[wasm_bindgen(js_name = "noteScriptRoot")]
    pub note_script_root: Option<String>,
    #[wasm_bindgen(js_name = "noteScript")]
    #[serde(with = "serde_bytes")]
    pub note_script: Option<Vec<u8>>,
    pub nullifier: Option<String>,
    #[wasm_bindgen(js_name = "expectedHeight")]
    pub expected_height: u32,
    #[wasm_bindgen(js_name = "stateDiscriminant")]
    pub state_discriminant: u8,
    #[serde(with = "serde_bytes")]
    pub state: Vec<u8>,
}

// ================================================================================================

pub(crate) fn serialize_input_note(note: &InputNoteRecord) -> SerializedInputNoteData {
    let details_commitment = note.details_commitment().to_hex();
    let note_id = note.id().map(|id| id.to_hex());
    let note_assets = encode(note.assets());
    let attachments = encode(note.attachments());

    let details = note.details();
    let serial_number = details.serial_num().to_bytes();
    let inputs = encode(details.storage());
    let nullifier = note
        .metadata()
        .map(|metadata| Nullifier::from_details_and_metadata(details, metadata).to_hex());

    let recipient = details.recipient();
    let note_script: Vec<u8> = encode(recipient.script());
    let note_script_root = recipient.script().root().to_hex();

    let state_discriminant = note.state().discriminant();
    let state = encode(note.state());
    let created_at = Utc::now().timestamp().to_string();

    let consumed_block_height = note.state().consumed_block_height().map(|h| h.as_u32());
    let consumed_tx_order = note.state().consumed_tx_order();
    let consumer_account_id = note.consumer_account().map(AccountId::to_hex);

    SerializedInputNoteData {
        details_commitment,
        note_id,
        note_assets,
        attachments,
        serial_number,
        inputs,
        note_script_root,
        note_script,
        nullifier,
        state_discriminant,
        state,
        created_at,
        consumed_block_height,
        consumed_tx_order,
        consumer_account_id,
    }
}

pub async fn upsert_input_note_tx(db_id: &str, note: &InputNoteRecord) -> Result<(), StoreError> {
    let serialized_data = serialize_input_note(note);

    let promise = idxdb_upsert_input_note(
        db_id,
        serialized_data.details_commitment,
        serialized_data.note_id,
        serialized_data.note_assets,
        serialized_data.attachments,
        serialized_data.serial_number,
        serialized_data.inputs,
        serialized_data.note_script_root,
        serialized_data.note_script,
        serialized_data.nullifier,
        serialized_data.created_at,
        serialized_data.state_discriminant,
        serialized_data.state,
        serialized_data.consumed_block_height,
        serialized_data.consumed_tx_order,
        serialized_data.consumer_account_id,
    );
    await_js_value(promise, "failed to upsert input note").await?;

    Ok(())
}

pub async fn upsert_note_script_tx(
    db_id: &str,
    note_script: &NoteScript,
) -> Result<(), StoreError> {
    let note_script_bytes = encode(note_script);
    let note_script_root = note_script.root().to_string();

    let promise = idxdb_upsert_note_script(db_id, note_script_root, note_script_bytes);
    await_js_value(promise, "failed to upsert note script").await?;

    Ok(())
}

pub(crate) fn serialize_output_note(note: &OutputNoteRecord) -> SerializedOutputNoteData {
    let details_commitment = note.details_commitment().to_hex();
    let note_id = note.id().to_hex();
    let note_assets = encode(note.assets());
    let attachments = encode(note.attachments());
    let recipient_digest = note.recipient_digest().to_hex();
    let metadata = encode(note.metadata());

    let nullifier = note.nullifier().map(|nullifier| nullifier.to_hex());

    // The script is known only when the recipient is known. It goes to `notesScripts`, and the
    // state keeps only the root.
    let note_script_root = note.script_root().map(|root| root.to_hex());
    let note_script = note.recipient().map(|recipient| encode(recipient.script()));

    let state_discriminant = note.state().discriminant();
    let state = encode_output_note_state_without_script(note.state());

    SerializedOutputNoteData {
        details_commitment,
        note_id,
        note_assets,
        attachments,
        recipient_digest,
        metadata,
        note_script_root,
        note_script,
        nullifier,
        state_discriminant,
        state,
        expected_height: note.expected_height().as_u32(),
    }
}

pub async fn upsert_output_note_tx(db_id: &str, note: &OutputNoteRecord) -> Result<(), StoreError> {
    let serialized_data = serialize_output_note(note);

    let promise = idxdb_upsert_output_note(
        db_id,
        serialized_data.details_commitment,
        serialized_data.note_id,
        serialized_data.note_assets,
        serialized_data.attachments,
        serialized_data.recipient_digest,
        serialized_data.metadata,
        serialized_data.nullifier,
        serialized_data.expected_height,
        serialized_data.state_discriminant,
        serialized_data.state,
        serialized_data.note_script_root,
        serialized_data.note_script,
    );
    await_js_value(promise, "failed to upsert output note").await?;
    Ok(())
}

/// Decodes the serialized `NoteAttachments` bytes persisted on a note row.
///
/// A row written by this store always carries a serialized `NoteAttachments`
/// (empty or not). Empty bytes only occur for a row that predates the
/// attachments column; the 0.14 -> 0.15 store reset normally drops such rows,
/// but decode them as an empty `NoteAttachments` rather than erroring so a
/// stale row never makes a note permanently unreadable.
fn decode_attachments(bytes: &[u8]) -> Result<NoteAttachments, StoreError> {
    if bytes.is_empty() {
        return Ok(NoteAttachments::default());
    }
    Ok(decode_unchecked(bytes)?)
}

pub fn parse_input_note_idxdb_object(
    note_idxdb: InputNoteIdxdbObject,
) -> Result<InputNoteRecord, StoreError> {
    // Merge the info that comes from the input notes table and the notes script table
    let InputNoteIdxdbObject {
        assets,
        serial_number,
        inputs,
        serialized_note_script,
        state,
        created_at,
        attachments,
    } = note_idxdb;

    let assets: NoteAssets = decode_unchecked(&assets)?;

    let serial_number = Word::read_from_bytes(&serial_number)?;
    let script: NoteScript = decode_unchecked(&serialized_note_script)?;
    let inputs: NoteStorage = decode_unchecked(&inputs)?;
    let recipient = NoteRecipient::new(serial_number, script, inputs);

    let details = NoteDetails::new(assets, recipient);
    let attachments = decode_attachments(&attachments)?;

    let state: InputNoteState = decode_unchecked(&state)?;
    let created_at = created_at
        .parse::<u64>()
        .map_err(|_| StoreError::QueryError("Failed to parse created_at timestamp".to_string()))?;

    Ok(InputNoteRecord::new(details, attachments, Some(created_at), state))
}

pub fn parse_output_note_idxdb_object(
    note_idxdb: OutputNoteIdxdbObject,
) -> Result<OutputNoteRecord, StoreError> {
    let note_metadata: NoteMetadata = decode_unchecked(&note_idxdb.metadata)?;
    let note_assets: NoteAssets = decode_unchecked(&note_idxdb.assets)?;
    let recipient = Word::try_from(note_idxdb.recipient_digest)?;
    let script = note_idxdb
        .serialized_note_script
        .map(|script| decode_unchecked::<NoteScript>(&script))
        .transpose()?;
    let state = decode_output_note_state_without_script(&note_idxdb.state, script)?;
    let attachments = decode_attachments(&note_idxdb.attachments)?;

    Ok(OutputNoteRecord::new(
        recipient,
        note_assets,
        note_metadata,
        state,
        note_idxdb.expected_height.into(),
        attachments,
    ))
}

pub fn parse_note_script_idxdb_object(
    note_script_idxdb: NoteScriptIdxdbObject,
) -> Result<NoteScript, StoreError> {
    let NoteScriptIdxdbObject {
        note_script_root: _,
        serialized_note_script,
    } = note_script_idxdb;

    Ok(decode_unchecked(&serialized_note_script)?)
}

pub(crate) async fn apply_note_updates_tx(
    db_id: &str,
    note_updates: &NoteUpdateTracker,
) -> Result<(), StoreError> {
    for input_note in note_updates.updated_input_notes() {
        upsert_input_note_tx(db_id, input_note.inner()).await?;
    }

    for output_note in note_updates.updated_output_notes() {
        upsert_output_note_tx(db_id, output_note.inner()).await?;
    }

    Ok(())
}
