use js_export_macro::js_export;
use miden_client::note::{Note as NativeNote, PswapNote as NativePswapNote};

use super::account_id::AccountId;
use super::fungible_asset::FungibleAsset;
use super::note::Note;
use super::note_tag::NoteTag;
use super::note_type::NoteType;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::{JsErr, from_str_err, u64_to_js_u64};

/// Decoded view of a standard PSWAP (partial-fill swap) note: offers its single fungible asset
/// for at least the requested asset, fillable in parts, with each fill paid back to the creator.
///
/// Recovered from an existing [`Note`] via [`PswapNote::try_from_note`].
#[js_export]
#[derive(Clone)]
pub struct PswapNote {
    note: NativeNote,
    pswap: NativePswapNote,
}

#[js_export]
impl PswapNote {
    /// Decodes a PSWAP note from a generic [`Note`].
    ///
    /// Errors when the note's script is not the standard PSWAP script, its storage does not decode
    /// as PSWAP storage, it does not carry exactly one fungible asset, or its attachment is
    /// malformed. A note with more than one attachment is rejected too, though a generic [`Note`]
    /// may carry several.
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<PswapNote, JsErr> {
        if note.0.script().root() != NativePswapNote::script_root() {
            return Err(from_str_err("decode PSWAP note: not a PSWAP note"));
        }
        let pswap = NativePswapNote::try_from(&note.0)
            .map_err(|err| js_error_with_context(err, "decode PSWAP note"))?;
        Ok(PswapNote { note: note.0.clone(), pswap })
    }

    /// Account that created this note; for a remainder note, the account that filled its parent.
    pub fn sender(&self) -> AccountId {
        self.pswap.sender().into()
    }

    /// Account that created the order and receives every payback.
    #[js_export(js_name = "creatorAccountId")]
    pub fn creator_account_id(&self) -> AccountId {
        self.pswap.storage().creator_account_id().into()
    }

    /// Asset the note offers.
    #[js_export(js_name = "offeredAsset")]
    pub fn offered_asset(&self) -> FungibleAsset {
        (*self.pswap.offered_asset()).into()
    }

    /// Asset the creator asks for in exchange for the whole offered asset.
    #[js_export(js_name = "requestedAsset")]
    pub fn requested_asset(&self) -> FungibleAsset {
        (*self.pswap.storage().min_requested_asset()).into()
    }

    /// Smallest amount of the requested asset a single fill may deliver; 0 when unbounded.
    #[js_export(js_name = "minFillStep")]
    pub fn min_fill_step(&self) -> JsU64 {
        u64_to_js_u64(self.pswap.storage().min_fill_step().as_u64())
    }

    /// Whether the payback notes are public or private.
    #[js_export(js_name = "paybackNoteType")]
    pub fn payback_note_type(&self) -> NoteType {
        self.pswap.storage().payback_note_type().into()
    }

    /// Tag of the payback notes, derived from the creator.
    #[js_export(js_name = "paybackTag")]
    pub fn payback_tag(&self) -> NoteTag {
        self.pswap.storage().payback_note_tag().into()
    }

    /// Identifier shared by every note of the order, as a decimal string.
    #[js_export(js_name = "orderId")]
    pub fn order_id(&self) -> String {
        self.pswap.order_id().as_canonical_u64().to_string()
    }

    /// Fill rounds before this note: 0 for the original order, +1 per remainder.
    #[js_export(js_name = "parentDepth")]
    pub fn parent_depth(&self) -> u32 {
        self.pswap.parent_depth()
    }

    /// Serial number of the note.
    #[js_export(js_name = "serialNumber")]
    pub fn serial_number(&self) -> Word {
        self.pswap.serial_number().into()
    }

    /// Whether the note is public, private or encrypted.
    #[js_export(js_name = "noteType")]
    pub fn note_type(&self) -> NoteType {
        self.pswap.note_type().into()
    }

    /// Returns the decoded note as a generic [`Note`].
    #[js_export(js_name = "intoNote")]
    pub fn into_note(&self) -> Note {
        self.note.clone().into()
    }
}
