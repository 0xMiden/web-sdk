use js_export_macro::js_export;
use miden_client::note::NoteId as NativeNoteId;

use super::word::Word;
use crate::js_error_with_context;
use crate::platform::JsErr;

/// Returns a unique identifier of a note, which is simultaneously a commitment to the note.
///
/// Note ID is computed as:
///
/// > `hash(details_commitment, metadata_commitment)`
///
/// On the 0.15 protocol surface the upstream `NoteId::new` signature
/// changed from `(recipient_digest, asset_commitment)` to
/// `(NoteDetailsCommitment, &NoteMetadata)`. The JS API exposes
/// `NoteId.fromRaw(word)` for constructing an ID from a pre-computed
/// 32-byte commitment word (the previous two-Word constructor has no
/// 0.15 equivalent).
#[derive(Clone, Copy)]
#[js_export]
pub struct NoteId(NativeNoteId);

#[js_export]
impl NoteId {
    /// Builds a note ID from its raw commitment word.
    ///
    /// `word` must already encode the final note-ID commitment — the
    /// metadata-mixing that the previous 2-Word constructor did is no
    /// longer part of the protocol surface.
    #[js_export(js_name = "fromRaw")]
    pub fn from_raw(word: &Word) -> NoteId {
        let native_word: miden_client::Word = word.into();
        NoteId(NativeNoteId::from_raw(native_word))
    }

    /// Parses a note ID from its hex encoding.
    #[js_export(js_name = "fromHex")]
    pub fn from_hex(hex: String) -> Result<NoteId, JsErr> {
        let native_note_id = NativeNoteId::try_from_hex(&hex)
            .map_err(|err| js_error_with_context(err, "error instantiating NoteId from hex"))?;
        Ok(NoteId(native_note_id))
    }

    /// Returns the canonical hex representation of the note ID.
    #[js_export(js_name = "toString")]
    #[allow(clippy::inherent_to_string)]
    pub fn to_string(&self) -> String {
        self.0.to_string()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNoteId> for NoteId {
    fn from(native_note_id: NativeNoteId) -> Self {
        NoteId(native_note_id)
    }
}

impl From<&NativeNoteId> for NoteId {
    fn from(native_note_id: &NativeNoteId) -> Self {
        NoteId(*native_note_id)
    }
}

impl From<NoteId> for NativeNoteId {
    fn from(note_id: NoteId) -> Self {
        note_id.0
    }
}

impl From<&NoteId> for NativeNoteId {
    fn from(note_id: &NoteId) -> Self {
        note_id.0
    }
}

impl_napi_from_value!(NoteId);
