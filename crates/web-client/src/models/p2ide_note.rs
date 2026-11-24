use js_export_macro::js_export;
use miden_client::note::{
    Note as NativeNote,
    P2ideNote as NativeP2ideNote,
    P2ideNoteStorage as NativeP2ideNoteStorage,
};

use super::account_id::AccountId;
use super::note::Note;
use super::note_assets::NoteAssets;
use super::note_type::NoteType;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::{JsErr, from_str_err};

/// Decoded view of a standard P2IDE (pay-to-id extended) note: a P2ID payment with an optional
/// reclaim height and an optional timelock.
///
/// Recovered from an existing [`Note`] via [`P2ideNote::try_from_note`].
#[js_export]
#[derive(Clone)]
pub struct P2ideNote {
    note: NativeNote,
    storage: NativeP2ideNoteStorage,
}

#[js_export]
impl P2ideNote {
    /// Decodes a P2IDE note from a generic [`Note`].
    ///
    /// Errors when the note's script is not the standard P2IDE script or its storage does not
    /// decode as P2IDE storage.
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<P2ideNote, JsErr> {
        if note.0.script().root() != NativeP2ideNote::script_root() {
            return Err(from_str_err("decode P2IDE note: not a P2IDE note"));
        }
        let storage = NativeP2ideNoteStorage::try_from(note.0.storage().items())
            .map_err(|err| js_error_with_context(err, "decode P2IDE note"))?;
        Ok(P2ideNote { note: note.0.clone(), storage })
    }

    /// Account the note pays.
    pub fn target(&self) -> AccountId {
        self.storage.target().into()
    }

    /// Account allowed to reclaim the note from [`reclaim_height`](Self::reclaim_height) on.
    pub fn reclaimer(&self) -> AccountId {
        self.storage.reclaimer().into()
    }

    /// Block height from which the reclaimer may reclaim the note, if reclaim is enabled.
    #[js_export(js_name = "reclaimHeight")]
    pub fn reclaim_height(&self) -> Option<u32> {
        self.storage.reclaim_height().map(|height| height.as_u32())
    }

    /// Block height before which the target cannot consume the note, if it is timelocked.
    #[js_export(js_name = "timelockHeight")]
    pub fn timelock_height(&self) -> Option<u32> {
        self.storage.timelock_height().map(|height| height.as_u32())
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
