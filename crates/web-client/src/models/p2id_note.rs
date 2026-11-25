use js_export_macro::js_export;
use miden_client::note::{
    Note as NativeNote,
    P2idNote as NativeP2idNote,
    P2idNoteStorage as NativeP2idNoteStorage,
};

use super::account_id::AccountId;
use super::note::Note;
use super::note_assets::NoteAssets;
use super::note_type::NoteType;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::{JsErr, from_str_err};

/// Decoded view of a standard P2ID (pay-to-id) note.
///
/// Recovered from an existing [`Note`] via [`P2idNote::try_from_note`].
// Named explicitly: napi would otherwise export `P2IdNote`.
#[js_export(js_name = "P2idNote")]
#[derive(Clone)]
pub struct P2idNote {
    note: NativeNote,
    storage: NativeP2idNoteStorage,
}

#[js_export]
impl P2idNote {
    /// Decodes a P2ID note from a generic [`Note`].
    ///
    /// Errors when the note's script is not the standard P2ID script or its storage does not
    /// decode as P2ID storage.
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<P2idNote, JsErr> {
        if note.0.script().root() != NativeP2idNote::script_root() {
            return Err(from_str_err("decode P2ID note: not a P2ID note"));
        }
        let storage = NativeP2idNoteStorage::try_from(note.0.storage().items())
            .map_err(|err| js_error_with_context(err, "decode P2ID note"))?;
        Ok(P2idNote { note: note.0.clone(), storage })
    }

    /// Account the note pays; only this account can consume it.
    pub fn target(&self) -> AccountId {
        self.storage.target().into()
    }

    /// Account that created the note.
    pub fn sender(&self) -> AccountId {
        self.note.metadata().sender().into()
    }

    /// Assets carried by the note.
    pub fn assets(&self) -> NoteAssets {
        self.note.assets().into()
    }

    /// Serial number of the note.
    #[js_export(js_name = "serialNumber")]
    pub fn serial_number(&self) -> Word {
        self.note.serial_num().into()
    }

    /// Whether the note is public, private or encrypted.
    #[js_export(js_name = "noteType")]
    pub fn note_type(&self) -> NoteType {
        self.note.metadata().note_type().into()
    }

    /// Returns the decoded note as a generic [`Note`].
    #[js_export(js_name = "intoNote")]
    pub fn into_note(&self) -> Note {
        self.note.clone().into()
    }
}
