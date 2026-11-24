use js_export_macro::js_export;
use miden_client::asset::Asset as NativeAsset;
use miden_client::note::Note as NativeNote;
use miden_client::note::standards::BurnNote as NativeBurnNote;

use super::account_id::AccountId;
use super::asset::VaultAsset;
use super::note::Note;
use super::note_type::NoteType;
use super::word::Word;
use crate::platform::{JsErr, from_str_err};

/// Decoded view of a standard BURN note.
///
/// Recovered from an existing [`Note`] via [`BurnNote::try_from_note`].
#[js_export]
#[derive(Clone)]
pub struct BurnNote {
    note: NativeNote,
    asset: NativeAsset,
}

#[js_export]
impl BurnNote {
    /// Decodes a BURN note from a generic [`Note`].
    ///
    /// Errors when the script is not the standard BURN script or the note does not carry exactly
    /// one asset (the asset to burn).
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<BurnNote, JsErr> {
        if note.0.script().root() != NativeBurnNote::script_root() {
            return Err(from_str_err("decode BURN note: not a BURN note"));
        }
        let mut assets = note.0.assets().iter();
        let asset = match (assets.next(), assets.next()) {
            (Some(asset), None) => *asset,
            _ => {
                return Err(from_str_err("decode BURN note: expected exactly one asset to burn"));
            },
        };
        Ok(BurnNote { note: note.0.clone(), asset })
    }

    /// Account that created the note.
    pub fn sender(&self) -> AccountId {
        self.note.metadata().sender().into()
    }

    /// Faucet that will burn the asset (the asset's issuing faucet).
    #[js_export(js_name = "faucetId")]
    pub fn faucet_id(&self) -> AccountId {
        self.asset.faucet_id().into()
    }

    /// Asset carried by the note (the asset to burn).
    pub fn asset(&self) -> VaultAsset {
        self.asset.into()
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

impl_napi_from_value!(BurnNote);
