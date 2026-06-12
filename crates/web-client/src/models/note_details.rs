use js_export_macro::js_export;
use miden_client::note::NoteDetails as NativeNoteDetails;

use super::note_assets::NoteAssets;
use super::note_recipient::NoteRecipient;

/// Details of a note consisting of assets, script, inputs, and a serial number.
///
/// See the {@link Note} type for more details.
///
/// Migration note (miden-client PR #2214): `NoteDetails::id()` and
/// `NoteDetails::nullifier()` were removed on the 0.15 protocol surface —
/// the ID now requires a `NoteMetadata` to compute (see `NoteId::new`),
/// and the nullifier moved onto `InputNoteRecord` where it is optional.
/// Use `details_commitment()` on a containing record (e.g.
/// `InputNoteRecord::details_commitment`) for the metadata-independent
/// identifier.
#[derive(Clone)]
#[js_export]
pub struct NoteDetails(NativeNoteDetails);

#[js_export]
impl NoteDetails {
    /// Creates a new set of note details from the given assets and recipient.
    #[js_export(constructor)]
    pub fn new(note_assets: &NoteAssets, note_recipient: &NoteRecipient) -> NoteDetails {
        NoteDetails(NativeNoteDetails::new(note_assets.into(), note_recipient.into()))
    }

    /// Returns the assets locked by the note.
    pub fn assets(&self) -> NoteAssets {
        self.0.assets().into()
    }

    /// Returns the recipient which controls when the note can be consumed.
    pub fn recipient(&self) -> NoteRecipient {
        self.0.recipient().into()
    }
}

impl From<NoteDetails> for NativeNoteDetails {
    fn from(note_details: NoteDetails) -> Self {
        note_details.0
    }
}

impl From<&NoteDetails> for NativeNoteDetails {
    fn from(note_details: &NoteDetails) -> Self {
        note_details.0.clone()
    }
}

impl From<NativeNoteDetails> for NoteDetails {
    fn from(note_details: NativeNoteDetails) -> NoteDetails {
        NoteDetails(note_details)
    }
}

impl From<&NativeNoteDetails> for NoteDetails {
    fn from(note_details: &NativeNoteDetails) -> NoteDetails {
        NoteDetails(note_details.clone())
    }
}

impl_napi_from_value!(NoteDetails);
