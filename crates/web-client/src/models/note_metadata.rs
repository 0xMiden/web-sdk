use js_export_macro::js_export;
use miden_client::note::{
    NoteAttachments,
    NoteMetadata as NativeNoteMetadata,
    PartialNoteMetadata,
};

use super::account_id::AccountId;
use super::{NoteTag, NoteType};

/// Metadata associated with a note.
///
/// 0.15 protocol surface: `NoteMetadata` is now constructed from a
/// [`PartialNoteMetadata`] (sender / `note_type` / tag) plus a `NoteAttachments`
/// collection — the previous `with_tag` / `with_attachment` / `attachment`
/// methods on `NoteMetadata` were moved (`with_tag` lives on
/// `PartialNoteMetadata`) or removed (`with_attachment` / `attachment`).
/// The JS constructor narrows back to the common case of an
/// attachment-less metadata.
#[derive(Clone)]
#[js_export]
pub struct NoteMetadata(NativeNoteMetadata);

#[js_export]
impl NoteMetadata {
    /// Creates metadata for a note with no attachments.
    #[js_export(constructor)]
    pub fn new(sender: &AccountId, note_type: NoteType, note_tag: &NoteTag) -> NoteMetadata {
        let partial =
            PartialNoteMetadata::new(sender.into(), note_type.into()).with_tag(note_tag.into());
        let native = NativeNoteMetadata::new(partial, &NoteAttachments::default());
        NoteMetadata(native)
    }

    /// Returns the account that created the note.
    pub fn sender(&self) -> AccountId {
        self.0.sender().into()
    }

    /// Returns the tag associated with the note.
    pub fn tag(&self) -> NoteTag {
        self.0.tag().into()
    }

    /// Returns whether the note is private, encrypted, or public.
    #[js_export(js_name = "noteType")]
    pub fn note_type(&self) -> NoteType {
        self.0.note_type().into()
    }

    // NOTE: `attachment()`, `withTag()`, `withAttachment()` were removed in
    // the migration to miden-client PR #2214 — see this module's struct doc
    // for the rationale. Construct a fresh `NoteMetadata` instead.
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNoteMetadata> for NoteMetadata {
    fn from(native_note_metadata: NativeNoteMetadata) -> Self {
        NoteMetadata(native_note_metadata)
    }
}

impl From<&NativeNoteMetadata> for NoteMetadata {
    fn from(native_note_metadata: &NativeNoteMetadata) -> Self {
        NoteMetadata(*native_note_metadata)
    }
}

impl From<NoteMetadata> for NativeNoteMetadata {
    fn from(note_metadata: NoteMetadata) -> Self {
        note_metadata.0
    }
}

impl From<&NoteMetadata> for NativeNoteMetadata {
    fn from(note_metadata: &NoteMetadata) -> Self {
        note_metadata.0
    }
}

impl_napi_from_value!(NoteMetadata);
