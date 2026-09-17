use js_export_macro::js_export;
use miden_client::block::BlockNumber as NativeBlockNumber;
use miden_client::note::{
    NoteDetails as NativeNoteDetails,
    NoteId as NativeNoteId,
    NoteSyncHint as NativeNoteSyncHint,
    NoteTag as NativeNoteTag,
};
use miden_client::notes::NoteFile as NativeNoteFile;
use miden_client::{Deserializable, Serializable};
#[cfg(feature = "nodejs")]
use napi_derive::napi;
#[cfg(feature = "browser")]
use wasm_bindgen::prelude::*;

use super::input_note::InputNote;
use super::note::Note;
use super::output_note::OutputNote;
use crate::js_error_with_context;
use crate::models::note_details::NoteDetails;
use crate::models::note_id::NoteId;
use crate::models::note_inclusion_proof::NoteInclusionProof;
use crate::models::note_tag::NoteTag;
use crate::platform::JsErr;

/// A serialized representation of a note.
#[derive(Clone)]
#[cfg_attr(feature = "browser", wasm_bindgen(inspectable))]
#[cfg_attr(feature = "nodejs", napi)]
pub struct NoteFile {
    pub(crate) inner: NativeNoteFile,
}

#[js_export]
impl NoteFile {
    /// Returns this `NoteFile`'s types.
    #[js_export(js_name = noteType)]
    pub fn note_type(&self) -> String {
        match &self.inner {
            NativeNoteFile::NoteId(_) => "NoteId".to_owned(),
            // Preserve the existing JS-facing names even though the native variants were renamed
            // to `ExpectedNote` and `Committed` in miden-client 0.16.
            NativeNoteFile::ExpectedNote { .. } => "NoteDetails".to_owned(),
            NativeNoteFile::Committed { .. } => "NoteWithProof".to_owned(),
        }
    }

    /// Returns the note ID when the file carries one.
    ///
    /// Migration note (miden-client PR #2214): `NoteDetails::id()` was
    /// removed (computing the ID now requires `NoteMetadata`), so the
    /// `NoteDetails`-only variant cannot synthesize one without extra
    /// information. Returns `None` in that case.
    #[js_export(js_name = "noteId")]
    pub fn note_id(&self) -> Option<NoteId> {
        match &self.inner {
            NativeNoteFile::NoteId(note_id) => Some((*note_id).into()),
            NativeNoteFile::Committed { note, .. } => Some(note.id().into()),
            NativeNoteFile::ExpectedNote { .. } => None,
        }
    }

    /// Returns the note details if present.
    #[js_export(js_name = "noteDetails")]
    pub fn note_details(&self) -> Option<NoteDetails> {
        match &self.inner {
            NativeNoteFile::ExpectedNote { details, .. } => Some(details.into()),
            _ => None,
        }
    }

    /// Returns the full note when the file includes it.
    pub fn note(&self) -> Option<Note> {
        match &self.inner {
            NativeNoteFile::Committed { note, .. } => Some(note.into()),
            _ => None,
        }
    }

    /// Returns the inclusion proof if present.
    #[js_export(js_name = "inclusionProof")]
    pub fn inclusion_proof(&self) -> Option<NoteInclusionProof> {
        match &self.inner {
            NativeNoteFile::Committed { proof, .. } => Some(proof.into()),
            _ => None,
        }
    }

    /// Returns the after-block hint when present.
    #[js_export(js_name = "afterBlockNum")]
    pub fn after_block_num(&self) -> Option<u32> {
        match &self.inner {
            NativeNoteFile::ExpectedNote { sync_hint, .. } => {
                Some(sync_hint.after_block_num().as_u32())
            },
            _ => None,
        }
    }

    /// Returns the note tag hint when present.
    #[js_export(js_name = "noteTag")]
    pub fn note_tag(&self) -> Option<NoteTag> {
        match &self.inner {
            NativeNoteFile::ExpectedNote { sync_hint, .. } => Some(sync_hint.tag().into()),
            _ => None,
        }
    }

    /// Returns the note nullifier when present.
    ///
    /// Migration note (miden-client PR #2214): `NoteDetails::nullifier()`
    /// was removed (the nullifier moved onto `InputNoteRecord` and is
    /// optional there), so the `NoteDetails`-only variant returns `None`.
    pub fn nullifier(&self) -> Option<String> {
        match &self.inner {
            NativeNoteFile::Committed { note, .. } => Some(note.nullifier().to_hex()),
            NativeNoteFile::ExpectedNote { .. } | NativeNoteFile::NoteId(_) => None,
        }
    }

    /// Turn a notefile into its byte representation.
    #[js_export(js_name = serialize)]
    pub fn serialize(&self) -> Vec<u8> {
        let mut buffer = vec![];
        self.inner.write_into(&mut buffer);
        buffer
    }

    /// Given a valid byte representation of a `NoteFile`,
    /// return it as a struct.
    #[js_export(js_name = deserialize)]
    pub fn deserialize(bytes: &[u8]) -> Result<Self, JsErr> {
        let deserialized = NativeNoteFile::read_from_bytes(bytes)
            .map_err(|err| js_error_with_context(err, "notefile deserialization failed"))?;
        Ok(Self { inner: deserialized })
    }

    /// Creates a `NoteFile` from an input note, preserving proof when available.
    #[js_export(js_name = fromInputNote)]
    pub fn from_input_note(note: &InputNote) -> Self {
        if let Some(inclusion_proof) = note.proof() {
            Self {
                inner: NativeNoteFile::Committed {
                    note: note.note().into(),
                    proof: inclusion_proof.into(),
                },
            }
        } else {
            let native_note = note.note();
            let assets = native_note.assets();
            let recipient = native_note.recipient();
            let tag: NativeNoteTag = native_note.metadata().tag().into();
            let details = NativeNoteDetails::new(assets.into(), recipient.into());
            Self { inner: expected_note(details, tag, 0) }
        }
    }

    /// Creates a `NoteFile` from an output note, choosing details when present.
    #[js_export(js_name = fromOutputNote)]
    pub fn from_output_note(note: &OutputNote) -> Self {
        let native_note = note.note();
        match native_note.recipient() {
            Some(recipient) => {
                let assets = native_note.assets();
                let details = NativeNoteDetails::new(assets.clone(), recipient.clone());
                Self {
                    inner: expected_note(details, native_note.metadata().tag(), 0),
                }
            },
            None => Self { inner: native_note.id().into() },
        }
    }

    /// Creates a `NoteFile` from note details using a zero-valued sync hint.
    ///
    /// miden-client 0.16 requires every expected note to include a tag and an after-block hint.
    /// This retains the old one-argument JS API by using block zero and the default tag. Prefer
    /// [`from_expected_note`](Self::from_expected_note) when the real sync hint is available.
    #[js_export(js_name = fromNoteDetails)]
    pub fn from_note_details(note_details: &NoteDetails) -> Self {
        note_details.into()
    }

    /// Creates an expected-note file with the sync hint required by miden-client 0.16.
    #[js_export(js_name = fromExpectedNote)]
    pub fn from_expected_note(
        note_details: &NoteDetails,
        note_tag: &NoteTag,
        after_block_num: u32,
    ) -> Self {
        let details: NativeNoteDetails = note_details.into();
        Self {
            inner: expected_note(details, note_tag.into(), after_block_num),
        }
    }

    /// Creates a `NoteFile` from a note ID.
    #[js_export(js_name = fromNoteId)]
    pub fn from_note_id(note_details: &NoteId) -> Self {
        note_details.into()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNoteFile> for NoteFile {
    fn from(note_file: NativeNoteFile) -> Self {
        NoteFile { inner: note_file }
    }
}

impl From<NoteFile> for NativeNoteFile {
    fn from(note_file: NoteFile) -> Self {
        note_file.inner
    }
}

impl From<&NoteDetails> for NoteFile {
    fn from(details: &NoteDetails) -> Self {
        let note_details: NativeNoteDetails = details.into();
        Self {
            inner: expected_note(note_details, NativeNoteTag::default(), 0),
        }
    }
}

impl From<&NoteId> for NoteFile {
    fn from(note_id: &NoteId) -> Self {
        let note_id: NativeNoteId = note_id.into();
        NoteFile { inner: note_id.into() }
    }
}

impl_napi_from_value!(NoteFile);

fn expected_note(
    details: NativeNoteDetails,
    tag: NativeNoteTag,
    after_block_num: u32,
) -> NativeNoteFile {
    NativeNoteFile::ExpectedNote {
        details,
        sync_hint: NativeNoteSyncHint::new(NativeBlockNumber::from(after_block_num), tag),
    }
}
