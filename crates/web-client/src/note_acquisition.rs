use alloc::boxed::Box;
use alloc::sync::Arc;

use async_trait::async_trait;
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use miden_client::note::NoteFile;
use miden_client::{NoteAcquisitionError, NoteAcquisitionGate, NoteAcquisitionSource};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

const MAX_BATCH_BYTES: usize = 2 * 1024 * 1024;

struct BrowserNoteAcquisition(Function);

// The callback belongs to the browser realm that polls the non-Send retention future.
unsafe impl Send for BrowserNoteAcquisition {}
unsafe impl Sync for BrowserNoteAcquisition {}

impl BrowserNoteAcquisition {
    async fn retain_batch(&self, source: &str, files: &Array) -> Result<(), NoteAcquisitionError> {
        let batch = Object::new();
        Reflect::set(&batch, &JsValue::from_str("source"), &JsValue::from_str(source))
            .map_err(|_| NoteAcquisitionError)?;
        Reflect::set(&batch, &JsValue::from_str("notes"), files)
            .map_err(|_| NoteAcquisitionError)?;
        let result = self.0.call1(&JsValue::UNDEFINED, &batch).map_err(|_| NoteAcquisitionError)?;
        JsFuture::from(Promise::resolve(&result))
            .await
            .map_err(|_| NoteAcquisitionError)?;
        Ok(())
    }
}

#[async_trait(?Send)]
impl NoteAcquisitionGate for BrowserNoteAcquisition {
    async fn retain(
        &self,
        source: NoteAcquisitionSource,
        notes: &[NoteFile],
    ) -> Result<(), NoteAcquisitionError> {
        let source = match source {
            NoteAcquisitionSource::Import => "import",
            NoteAcquisitionSource::NoteTransport => "note-transport",
        };
        let mut files = Array::new();
        let mut length = 0usize;
        for note in notes {
            let bytes = note.to_bytes();
            if bytes.len() > MAX_BATCH_BYTES {
                return Err(NoteAcquisitionError);
            }
            if length + bytes.len() > MAX_BATCH_BYTES {
                self.retain_batch(source, &files).await?;
                files = Array::new();
                length = 0;
            }
            files.push(&Uint8Array::from(bytes.as_slice()));
            length += bytes.len();
        }
        if files.length() != 0 {
            self.retain_batch(source, &files).await?;
        }
        Ok(())
    }
}

pub(crate) fn options(
    options: &JsValue,
) -> Result<(Option<Arc<dyn NoteAcquisitionGate>>, JsValue), JsValue> {
    if options.is_undefined() {
        return Ok((None, JsValue::UNDEFINED));
    }
    let callback = Reflect::get(options, &JsValue::from_str("beforeNoteAcquisition"))?;
    let gate = if callback.is_undefined() {
        None
    } else {
        let callback = callback
            .dyn_into::<Function>()
            .map_err(|_| js_sys::TypeError::new("beforeNoteAcquisition must be a function"))?;
        Some(Arc::new(BrowserNoteAcquisition(callback)) as Arc<dyn NoteAcquisitionGate>)
    };
    Ok((gate, Reflect::get(options, &JsValue::from_str("indexedDb"))?))
}
