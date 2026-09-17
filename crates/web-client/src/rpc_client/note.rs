use js_export_macro::js_export;

use crate::models::NoteType;
use crate::models::input_note::InputNote;
use crate::models::note::Note;
use crate::models::note_attachment::NoteAttachment;
use crate::models::note_id::NoteId;
use crate::models::note_inclusion_proof::NoteInclusionProof;
use crate::models::note_metadata::NoteMetadata;

/// Wrapper for a note fetched over RPC.
///
/// It carries the note ID, public metadata, and inclusion proof. The full note body is only
/// present for public notes; for private notes only the header-shaped fields and inclusion
/// proof are available — the body lives off-chain.
///
/// 0.15 protocol surface: the on-chain `NoteHeader` now commits to a
/// `NoteDetailsCommitment` rather than the `NoteId`, so a `NoteHeader` can no longer be
/// reconstructed from header-shaped fields alone for private notes. We therefore expose
/// the constituent fields (`noteId`, `metadata`) directly on `FetchedNote` instead of a
/// `header` getter.
#[derive(Clone)]
#[js_export]
pub struct FetchedNote {
    note_id: NoteId,
    metadata: NoteMetadata,
    inclusion_proof: NoteInclusionProof,
    note: Option<Note>,
    attachments: Vec<NoteAttachment>,
}

// Internal methods accessible from Rust code (not processed by napi/wasm_bindgen).
impl FetchedNote {
    /// The full note data (internal Rust access).
    pub(crate) fn note(&self) -> Option<Note> {
        self.note.clone()
    }

    /// Builds a `FetchedNote` including its attachments (internal Rust access).
    ///
    /// 0.15 returns the note's attachment content over RPC for both public notes (carried on
    /// the `Note` body) and private notes (alongside the metadata / inclusion proof), so the
    /// fetch path can surface them here even when the note body itself is private.
    pub(crate) fn with_attachments(
        note_id: NoteId,
        metadata: NoteMetadata,
        inclusion_proof: NoteInclusionProof,
        note: Option<Note>,
        attachments: Vec<NoteAttachment>,
    ) -> FetchedNote {
        FetchedNote {
            note_id,
            metadata,
            inclusion_proof,
            note,
            attachments,
        }
    }
}

#[js_export]
impl FetchedNote {
    /// Create a `FetchedNote` with an optional [`Note`].
    #[js_export(constructor)]
    pub fn new(
        note_id: NoteId,
        metadata: NoteMetadata,
        inclusion_proof: NoteInclusionProof,
        note: Option<Note>,
    ) -> FetchedNote {
        // The JS constructor doesn't take attachments; the RPC fetch path uses
        // `with_attachments` to populate them. A directly JS-constructed note starts with none.
        FetchedNote {
            note_id,
            metadata,
            inclusion_proof,
            note,
            attachments: Vec::new(),
        }
    }

    // GETTERS
    // --------------------------------------------------------------------------------------------

    /// The unique identifier of the note.
    #[js_export(getter, js_name = "noteId")]
    pub fn get_note_id(&self) -> NoteId {
        self.note_id
    }

    /// The note's metadata, including sender, tag, and other properties.
    /// Available for both private and public notes.
    #[js_export(getter)]
    pub fn metadata(&self) -> NoteMetadata {
        self.metadata.clone()
    }

    /// The note's attachments.
    ///
    /// 0.15 returns attachment content over RPC for both public and private notes, so this is
    /// populated even when the note body itself is private. An empty array means the note
    /// carries no attachments.
    #[js_export(getter)]
    pub fn attachments(&self) -> Vec<NoteAttachment> {
        self.attachments.clone()
    }

    /// The full [`Note`] data.
    ///
    /// For public notes, it contains the complete note data.
    /// For private notes, it will be undefined.
    #[js_export(getter, js_name = "note")]
    pub fn get_note(&self) -> Option<Note> {
        self.note.clone()
    }

    /// The note's inclusion proof.
    ///
    /// Contains the data required to prove inclusion of the note in the canonical chain.
    #[js_export(getter, js_name = "inclusionProof")]
    pub fn get_inclusion_proof(&self) -> NoteInclusionProof {
        self.inclusion_proof.clone()
    }

    /// Returns whether the note is private, encrypted, or public.
    #[js_export(getter, js_name = "noteType")]
    pub fn get_note_type(&self) -> NoteType {
        self.metadata.note_type()
    }

    // CONVERSIONS
    // --------------------------------------------------------------------------------------------

    /// Returns an [`InputNote`] when the fetched note is public.
    ///
    /// Returns `undefined` when the note body is missing (e.g. private notes); in that case build
    /// an `InputNote` manually using the inclusion proof and note data obtained elsewhere.
    #[js_export(js_name = "asInputNote")]
    pub fn as_input_note(&self) -> Option<InputNote> {
        self.note().map(|note| InputNote::authenticated(&note, &self.inclusion_proof))
    }
}
