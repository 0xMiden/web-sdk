use js_export_macro::js_export;
use miden_client::note::{
    NoteAttachments as NativeNoteAttachments,
    NoteMetadata as NativeNoteMetadata,
    PartialNoteMetadata as NativePartialNoteMetadata,
};

use super::account_id::AccountId;
use super::{NoteTag, NoteType};

/// Metadata associated with a note.
///
/// This metadata includes the sender, note type, tag, and an optional attachment.
/// Attachments provide additional context about how notes should be processed.
#[derive(Clone)]
#[js_export]
pub struct NoteMetadata(NativeNoteMetadata);

#[js_export]
impl NoteMetadata {
    /// Creates metadata for a note.
    #[js_export(constructor)]
    pub fn new(sender: &AccountId, note_type: NoteType, note_tag: &NoteTag) -> NoteMetadata {
        let partial = NativePartialNoteMetadata::new(sender.into(), note_type.into())
            .with_tag(note_tag.into());
        NoteMetadata(NativeNoteMetadata::new(partial, &NativeNoteAttachments::default()))
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

    /// Sets the tag for this metadata and returns the updated metadata.
    #[js_export(js_name = "withTag")]
    pub fn with_tag(&self, tag: &NoteTag) -> NoteMetadata {
        let partial = (*self.0.partial_metadata()).with_tag(tag.into());
        NoteMetadata(NativeNoteMetadata::new(partial, &NativeNoteAttachments::default()))
    }
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
