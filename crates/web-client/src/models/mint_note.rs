use js_export_macro::js_export;
use miden_client::asset::Asset as NativeAsset;
use miden_client::note::{MintNote as NativeMintNote, Note as NativeNote};
use miden_client::{Felt, Word as NativeWord};

use super::account_id::AccountId;
use super::asset::VaultAsset;
use super::note::Note;
use super::note_type::NoteType;
use super::word::Word;
use crate::platform::{JsErr, from_str_err};

/// Decoded view of a standard MINT note.
///
/// Recovered from an existing [`Note`] via [`MintNote::try_from_note`]. MINT notes carry no
/// assets; the asset to mint lives in note storage.
#[js_export]
#[derive(Clone)]
pub struct MintNote {
    note: NativeNote,
    asset: NativeAsset,
}

#[js_export]
impl MintNote {
    /// Decodes a MINT note from a generic [`Note`].
    ///
    /// Errors when the script is not the standard MINT script, the note carries assets, or the
    /// storage layout does not yield a mintable asset.
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<MintNote, JsErr> {
        if note.0.script().root() != NativeMintNote::script_root() {
            return Err(from_str_err("decode MINT note: not a MINT note"));
        }
        if note.0.assets().num_assets() != 0 {
            return Err(from_str_err("decode MINT note: MINT notes must not carry assets"));
        }
        let asset = mint_asset_from_storage(note.0.storage().items())?;
        Ok(MintNote { note: note.0.clone(), asset })
    }

    /// Account that created the note (the faucet owner).
    pub fn sender(&self) -> AccountId {
        self.note.metadata().sender().into()
    }

    /// Faucet that will mint the asset.
    #[js_export(js_name = "faucetId")]
    pub fn faucet_id(&self) -> AccountId {
        self.asset.faucet_id().into()
    }

    /// Asset that will be minted (embedded in storage, not carried as a note asset).
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

/// Pulls the embedded asset out of MINT storage.
///
/// Private layout (13 items): `RECIPIENT(4) + ASSET(8) + tag(1)`.
/// Public layout (≥20 items): `SCRIPT_ROOT(4) + SERIAL_NUM(4) + ASSET(8) + …`.
fn mint_asset_from_storage(items: &[Felt]) -> Result<NativeAsset, JsErr> {
    let offset = if items.len() == NativeMintNote::NUM_STORAGE_ITEMS_PRIVATE {
        4usize
    } else if items.len() >= NativeMintNote::MIN_NUM_STORAGE_ITEMS_PUBLIC {
        8usize
    } else {
        return Err(from_str_err(
            "decode MINT note: storage length does not match a private or public MINT layout",
        ));
    };
    if items.len() < offset + 8 {
        return Err(from_str_err("decode MINT note: storage is too short to hold an asset"));
    }
    let id =
        NativeWord::new([items[offset], items[offset + 1], items[offset + 2], items[offset + 3]]);
    let value = NativeWord::new([
        items[offset + 4],
        items[offset + 5],
        items[offset + 6],
        items[offset + 7],
    ]);
    NativeAsset::from_id_and_value_words(id, value)
        .map_err(|err| from_str_err(&format!("decode MINT note: storage asset invalid: {err}")))
}

impl_napi_from_value!(MintNote);
