use js_export_macro::js_export;
use miden_client::note::PswapNote as NativePswapNote;

use super::account_id::AccountId;
use super::fungible_asset::FungibleAsset;
use super::note::Note;
use super::note_type::NoteType;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::JsErr;

/// Decoded view of a standard PSWAP (partial swap) note.
///
/// Recovered from an existing [`Note`] via [`PswapNote::try_from_note`].
#[js_export]
#[derive(Clone)]
pub struct PswapNote(NativePswapNote);

#[js_export]
impl PswapNote {
    /// Decodes a PSWAP note from a generic [`Note`].
    ///
    /// Errors when the script, storage, or offered asset do not match the upstream
    /// `PswapNote` shape.
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<PswapNote, JsErr> {
        let native = NativePswapNote::try_from(&note.0)
            .map_err(|err| js_error_with_context(err, "decode PSWAP note"))?;
        Ok(PswapNote(native))
    }

    /// Account that created the note.
    pub fn sender(&self) -> AccountId {
        self.0.sender().into()
    }

    /// Fungible asset the note offers.
    #[js_export(js_name = "offeredAsset")]
    pub fn offered_asset(&self) -> FungibleAsset {
        (*self.0.offered_asset()).into()
    }

    /// Faucet of the asset the consumer must pay to fill the order.
    #[js_export(js_name = "requestedFaucetId")]
    pub fn requested_faucet_id(&self) -> AccountId {
        self.0.storage().requested_faucet_id().into()
    }

    /// Serial number of the note.
    #[js_export(js_name = "serialNumber")]
    pub fn serial_number(&self) -> Word {
        self.0.serial_number().into()
    }

    /// Whether the note is public or private.
    #[js_export(js_name = "noteType")]
    pub fn note_type(&self) -> NoteType {
        self.0.note_type().into()
    }

    /// Returns the decoded note as a generic [`Note`].
    #[js_export(js_name = "intoNote")]
    pub fn into_note(&self) -> Note {
        Note::from(miden_client::note::Note::from(self.0.clone()))
    }
}

impl_napi_from_value!(PswapNote);
