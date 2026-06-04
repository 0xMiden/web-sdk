use js_export_macro::js_export;
use miden_client::note::NoteDetails as NativeNoteDetails;

use super::note_assets::NoteAssets;
use super::note_recipient::NoteRecipient;
use super::word::Word;

/// Details of a note consisting of assets, script, inputs, and a serial number.
///
/// See the {@link Note} type for more details.
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

    /// Returns the commitment to these note details (recipient + assets), independent of
    /// metadata.
    #[js_export(js_name = "detailsCommitment")]
    pub fn details_commitment(&self) -> Word {
        self.0.commitment().as_word().into()
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
