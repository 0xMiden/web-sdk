use js_export_macro::js_export;
use miden_client::note::FeeSponsorshipNote as NativeFeeSponsorshipNote;

use super::account_id::AccountId;
use super::fungible_asset::FungibleAsset;
use super::note::Note;
use super::note_id::NoteId;
use super::note_tag::NoteTag;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::JsErr;

/// Decoded view of a standard fee-sponsorship note.
///
/// Built with [`Note::create_fee_sponsorship_note`] or recovered from an existing
/// [`Note`] via [`FeeSponsorshipNote::try_from_note`].
#[js_export]
#[derive(Clone)]
pub struct FeeSponsorshipNote(NativeFeeSponsorshipNote);

#[js_export]
impl FeeSponsorshipNote {
    /// Decodes a fee-sponsorship note from a generic [`Note`].
    ///
    /// Errors when the script root, storage layout, or asset count do not match the
    /// upstream `FeeSponsorshipNote` shape.
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<FeeSponsorshipNote, JsErr> {
        let native = NativeFeeSponsorshipNote::try_from(&note.0)
            .map_err(|err| js_error_with_context(err, "decode fee sponsorship note"))?;
        Ok(FeeSponsorshipNote(native))
    }

    /// Account that created the sponsorship note.
    pub fn sender(&self) -> AccountId {
        self.0.sender().into()
    }

    /// Serial number of the note.
    #[js_export(js_name = "serialNumber")]
    pub fn serial_number(&self) -> Word {
        self.0.serial_number().into()
    }

    /// Tag routing the note to the network account the feature note targets.
    pub fn tag(&self) -> NoteTag {
        self.0.tag().into()
    }

    /// Single fungible fee asset carried by the note.
    pub fn asset(&self) -> FungibleAsset {
        self.0.asset().into()
    }

    /// ID of the feature note this sponsorship is bound to.
    #[js_export(js_name = "featureNoteId")]
    pub fn feature_note_id(&self) -> NoteId {
        self.0.feature_note_id().into()
    }

    /// Account allowed to reclaim the note after [`reclaim_height`](Self::reclaim_height).
    pub fn reclaimer(&self) -> AccountId {
        self.0.reclaimer().into()
    }

    /// Block height at or after which the reclaimer may reclaim, if reclaim is enabled.
    #[js_export(js_name = "reclaimHeight")]
    pub fn reclaim_height(&self) -> Option<u32> {
        self.0.reclaim_height().map(|height| height.as_u32())
    }

    /// Converts this decoded sponsorship back into a generic [`Note`].
    #[js_export(js_name = "intoNote")]
    pub fn into_note(&self) -> Note {
        Note::from(miden_client::note::Note::from(self.0.clone()))
    }
}

impl_napi_from_value!(FeeSponsorshipNote);
