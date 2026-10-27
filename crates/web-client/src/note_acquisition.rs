use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use js_sys::{Function, Object, Promise, Reflect, Uint8Array};
use miden_client::note::{
    NoteAcquisition,
    NoteAcquisitionError,
    NoteAcquisitionGate,
    NoteAcquisitionLimits,
    NoteAcquisitionSource,
    NoteAcquisitionVariant,
};
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::WebClient;

thread_local! {
    static CALLBACKS: RefCell<BTreeMap<usize, Function>> = const { RefCell::new(BTreeMap::new()) };
}
static NEXT_CALLBACK: AtomicUsize = AtomicUsize::new(1);

// Only the numeric registration crosses native trait boundaries. A different realm has no entry
// for it and refuses; no JavaScript handle receives an unsafe Send or Sync implementation.
struct BrowserGate(usize);

impl Drop for BrowserGate {
    fn drop(&mut self) {
        CALLBACKS.with(|callbacks| callbacks.borrow_mut().remove(&self.0));
    }
}

#[async_trait::async_trait(?Send)]
impl NoteAcquisitionGate for BrowserGate {
    async fn before_import(&self, item: &NoteAcquisition) -> Result<(), NoteAcquisitionError> {
        let rejected = || NoteAcquisitionError::Rejected;
        let callback = CALLBACKS
            .with(|callbacks| callbacks.borrow().get(&self.0).cloned())
            .ok_or_else(rejected)?;
        let payload = candidate(item).map_err(|_| rejected())?;
        let value = callback.call1(&JsValue::UNDEFINED, &payload).map_err(|_| rejected())?;
        let promise = value.dyn_into::<Promise>().map_err(|_| rejected())?;
        let decision = JsFuture::from(promise).await.map_err(|_| rejected())?;
        match decision.as_string().as_deref() {
            Some("accepted") => Ok(()),
            Some("retentionFailed") => Err(NoteAcquisitionError::RetentionFailed),
            _ => Err(rejected()),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Limits {
    #[serde(rename = "maxNotes")]
    notes: u32,
    #[serde(rename = "maxNoteFileBytes")]
    note_file_bytes: u32,
    #[serde(rename = "maxTotalNoteFileBytes")]
    total_note_file_bytes: u32,
}

#[wasm_bindgen]
impl WebClient {
    /// Installs an awaited, realm-confined acquisition decision callback before exposing a client.
    /// The callback receives copied candidate data and must resolve a sanitized decision string.
    /// It must use independent storage without re-entering this client. Delivered byte limits do
    /// not bound the native encoder's initial allocation.
    #[wasm_bindgen(js_name = "installNoteAcquisitionGate")]
    pub async fn install_note_acquisition_gate(
        &self,
        callback: Function,
        limits: JsValue,
    ) -> Result<(), JsValue> {
        let limits: Limits = serde_wasm_bindgen::from_value(limits)
            .map_err(|_| JsValue::from_str("Invalid note acquisition limits"))?;
        let mut id = NEXT_CALLBACK.load(Ordering::Relaxed);
        let id = loop {
            let next = id
                .checked_add(1)
                .ok_or_else(|| JsValue::from_str("Note acquisition registration exhausted"))?;
            match NEXT_CALLBACK.compare_exchange_weak(
                id,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break id,
                Err(current) => id = current,
            }
        };
        let mut guard = self.inner.lock().await;
        let client = guard.take().ok_or_else(|| JsValue::from_str("Client not initialized"))?;
        CALLBACKS.with(|callbacks| callbacks.borrow_mut().insert(id, callback));
        *guard = Some(client.with_note_acquisition_gate(
            Arc::new(BrowserGate(id)),
            NoteAcquisitionLimits {
                max_notes: limits.notes as usize,
                max_note_file_bytes: limits.note_file_bytes as usize,
                max_total_note_file_bytes: limits.total_note_file_bytes as usize,
            },
        ));
        Ok(())
    }
}

fn set(object: &Object, key: &str, value: impl Into<JsValue>) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value.into()).map(|_| ())
}

fn candidate(item: &NoteAcquisition) -> Result<JsValue, JsValue> {
    let object = Object::new();
    set(&object, "noteFileBytes", Uint8Array::from(item.note_file_bytes()))?;
    set(
        &object,
        "variant",
        match item.variant() {
            NoteAcquisitionVariant::NoteId => "noteId",
            NoteAcquisitionVariant::ExpectedNote => "expectedNote",
            NoteAcquisitionVariant::Committed => "committed",
        },
    )?;
    set(
        &object,
        "source",
        match item.source() {
            NoteAcquisitionSource::Import => "import",
            NoteAcquisitionSource::NoteTransport => "noteTransport",
        },
    )?;
    set(
        &object,
        "batchIndex",
        u32::try_from(item.batch_index()).map_err(|_| JsValue::from_str("Invalid batch index"))?,
    )?;
    set(
        &object,
        "batchCount",
        u32::try_from(item.batch_count()).map_err(|_| JsValue::from_str("Invalid batch count"))?,
    )?;
    if let Some(value) = item.details_commitment() {
        set(&object, "detailsCommitment", value.to_hex())?;
    }
    if let Some(value) = item.note_id() {
        set(&object, "noteId", value.to_hex())?;
    }
    if let Some(value) = item.nullifier() {
        set(&object, "nullifier", value.to_hex())?;
    }
    if let Some(value) = item.tag() {
        set(&object, "tag", u32::from(value))?;
    }
    if let Some(value) = item.after_block_num() {
        set(&object, "afterBlockNum", value.as_u32())?;
    }
    if let Some(value) = item.metadata() {
        let metadata = Object::new();
        set(&metadata, "sender", value.sender().to_hex())?;
        set(&metadata, "noteType", value.note_type() as u8)?;
        set(&metadata, "tag", u32::from(value.tag()))?;
        set(&metadata, "attachmentsCommitment", value.attachments_commitment().to_hex())?;
        set(&object, "metadata", metadata)?;
    }
    Ok(object.into())
}
