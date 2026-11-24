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

/// Decoded view of a standard BURN note: asks the faucet that issued its single asset to destroy
/// it.
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
    /// Errors when the note's script is not the standard BURN script, its storage is not the
    /// eight items of one asset, or it does not carry exactly that asset. These are the checks the
    /// BURN script makes at consume time.
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<BurnNote, JsErr> {
        if note.0.script().root() != NativeBurnNote::script_root() {
            return Err(from_str_err("decode BURN note: not a BURN note"));
        }
        let storage = note.0.storage().items();
        if storage.len() != NativeBurnNote::NUM_STORAGE_ITEMS {
            return Err(from_str_err(&format!(
                "decode BURN note: expected {} storage items, found {}",
                NativeBurnNote::NUM_STORAGE_ITEMS,
                storage.len()
            )));
        }
        let mut assets = note.0.assets().iter();
        let asset = match (assets.next(), assets.next()) {
            (Some(asset), None) => *asset,
            _ => return Err(from_str_err("decode BURN note: expected exactly one asset")),
        };
        if asset.as_elements().as_slice() != storage {
            return Err(from_str_err(
                "decode BURN note: stored asset does not match the carried asset",
            ));
        }
        Ok(BurnNote { note: note.0.clone(), asset })
    }

    /// Account that created the note.
    pub fn sender(&self) -> AccountId {
        self.note.metadata().sender().into()
    }

    /// Asset the note burns.
    pub fn asset(&self) -> VaultAsset {
        self.asset.into()
    }

    /// Faucet that issued the asset and consumes the note to burn it.
    #[js_export(js_name = "faucetId")]
    pub fn faucet_id(&self) -> AccountId {
        self.asset.faucet_id().into()
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
