use js_export_macro::js_export;
use miden_client::asset::Asset as NativeAsset;
use miden_client::note::standards::{SwapNoteStorage as NativeSwapNoteStorage, SwapPayback};
use miden_client::note::{Note as NativeNote, SwapNote as NativeSwapNote};

use super::account_id::AccountId;
use super::asset::VaultAsset;
use super::note::Note;
use super::note_tag::NoteTag;
use super::note_type::NoteType;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::{JsErr, from_str_err};

/// Decoded view of a standard SWAP note: offers its single asset in exchange for the requested
/// asset, which the consumer pays back to the creator in a P2ID payback note.
///
/// Recovered from an existing [`Note`] via [`SwapNote::try_from_note`].
#[js_export]
#[derive(Clone)]
pub struct SwapNote {
    note: NativeNote,
    offered_asset: NativeAsset,
    storage: NativeSwapNoteStorage,
}

#[js_export]
impl SwapNote {
    /// Decodes a SWAP note from a generic [`Note`].
    ///
    /// Errors when the note's script is not the standard SWAP script, its storage does not decode
    /// as SWAP storage, or it does not carry exactly one asset (the SWAP script rejects any other
    /// count at consume time).
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<SwapNote, JsErr> {
        if note.0.script().root() != NativeSwapNote::script_root() {
            return Err(from_str_err("decode SWAP note: not a SWAP note"));
        }
        let storage = NativeSwapNoteStorage::try_from(note.0.storage().items())
            .map_err(|err| js_error_with_context(err, "decode SWAP note"))?;
        let mut assets = note.0.assets().iter();
        let offered_asset = match (assets.next(), assets.next()) {
            (Some(asset), None) => *asset,
            _ => return Err(from_str_err("decode SWAP note: expected exactly one offered asset")),
        };
        Ok(SwapNote {
            note: note.0.clone(),
            offered_asset,
            storage,
        })
    }

    /// Account that created the note and receives the payback.
    pub fn sender(&self) -> AccountId {
        self.note.metadata().sender().into()
    }

    /// Asset the note offers to whoever consumes it.
    #[js_export(js_name = "offeredAsset")]
    pub fn offered_asset(&self) -> VaultAsset {
        self.offered_asset.into()
    }

    /// Asset the consumer must pay back to receive the offered asset.
    #[js_export(js_name = "requestedAsset")]
    pub fn requested_asset(&self) -> VaultAsset {
        self.storage.requested_asset().into()
    }

    /// Tag of the payback note.
    #[js_export(js_name = "paybackTag")]
    pub fn payback_tag(&self) -> NoteTag {
        self.storage.payback_tag().into()
    }

    /// Whether the payback note is public or private.
    #[js_export(js_name = "paybackNoteType")]
    pub fn payback_note_type(&self) -> NoteType {
        self.storage.payback_note_type().into()
    }

    /// Account the payback note pays. Set only for a public payback; a private payback keeps its
    /// target behind [`payback_recipient`](Self::payback_recipient).
    #[js_export(js_name = "paybackTarget")]
    pub fn payback_target(&self) -> Option<AccountId> {
        match self.storage.payback() {
            SwapPayback::Public { payback_target_id } => Some((*payback_target_id).into()),
            SwapPayback::Private { .. } => None,
        }
    }

    /// Recipient digest of the payback note. Set only for a private payback.
    #[js_export(js_name = "paybackRecipient")]
    pub fn payback_recipient(&self) -> Option<Word> {
        match self.storage.payback() {
            SwapPayback::Private { recipient } => Some((*recipient).into()),
            SwapPayback::Public { .. } => None,
        }
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
