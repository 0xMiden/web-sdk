use js_export_macro::js_export;
use miden_client::note::NoteHeader as NativeNoteHeader;

use super::note_id::NoteId;
use super::note_metadata::NoteMetadata;

/// Holds the strictly required, public information of a note.
///
/// See `NoteId` and `NoteMetadata` for additional details.
#[derive(Clone)]
#[js_export]
pub struct NoteHeader(NativeNoteHeader);

#[js_export]
impl NoteHeader {
    // TODO: new()

    /// Returns the unique identifier for the note.
    pub fn id(&self) -> NoteId {
        self.0.id().into()
    }

    /// Returns the public metadata attached to the note.
    pub fn metadata(&self) -> NoteMetadata {
        self.0.metadata().into()
    }

    // `toCommitment` was removed in the migration to miden-client PR #2214 —
    // `NoteHeader::to_commitment` is no longer part of the 0.15 protocol
    // surface. Compute a commitment from `id().toString()` or related
    // commitment-bearing accessors on the underlying note types if needed.
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNoteHeader> for NoteHeader {
    fn from(native_note_header: NativeNoteHeader) -> Self {
        NoteHeader(native_note_header)
    }
}

impl From<&NativeNoteHeader> for NoteHeader {
    fn from(native_note_header: &NativeNoteHeader) -> Self {
        NoteHeader(native_note_header.clone())
    }
}

impl From<NoteHeader> for NativeNoteHeader {
    fn from(note_header: NoteHeader) -> Self {
        note_header.0
    }
}

impl From<&NoteHeader> for NativeNoteHeader {
    fn from(note_header: &NoteHeader) -> Self {
        note_header.0.clone()
    }
}
