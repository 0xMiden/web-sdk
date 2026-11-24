use js_export_macro::js_export;
use miden_client::asset::Asset as NativeAsset;
use miden_client::note::standards::MintNote as NativeMintNote;
use miden_client::note::{
    Note as NativeNote,
    NoteStorage as NativeNoteStorage,
    NoteTag as NativeNoteTag,
};
use miden_client::{Felt as NativeFelt, Word as NativeWord};

use super::account_id::AccountId;
use super::asset::VaultAsset;
use super::note::Note;
use super::note_storage::NoteStorage;
use super::note_tag::NoteTag;
use super::note_type::NoteType;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::{JsErr, from_str_err};

#[derive(Clone)]
enum MintRecipient {
    Private {
        digest: NativeWord,
    },
    Public {
        script_root: NativeWord,
        serial_num: NativeWord,
        storage: NativeNoteStorage,
    },
}

/// Decoded view of a standard MINT note: asks a network faucet to mint the asset in its storage
/// into a new note for the recipient it describes.
///
/// Recovered from an existing [`Note`] via [`MintNote::try_from_note`].
#[js_export]
#[derive(Clone)]
pub struct MintNote {
    note: NativeNote,
    asset: NativeAsset,
    tag: NativeNoteTag,
    recipient: MintRecipient,
}

fn word(items: &[NativeFelt]) -> NativeWord {
    NativeWord::new([items[0], items[1], items[2], items[3]])
}

#[js_export]
impl MintNote {
    /// Decodes a MINT note from a generic [`Note`].
    ///
    /// Errors when the note's script is not the standard MINT script, its storage is neither the
    /// 13 items of a private output note nor at least the 20 items of a public one, its asset does
    /// not decode, or its tag does not fit in a `u32`. The storage layouts are the ones the MINT
    /// script reads at consume time.
    #[js_export(js_name = "tryFromNote")]
    pub fn try_from_note(note: &Note) -> Result<MintNote, JsErr> {
        if note.0.script().root() != NativeMintNote::script_root() {
            return Err(from_str_err("decode MINT note: not a MINT note"));
        }
        let items = note.0.storage().items();
        let (asset_at, recipient) = match items.len() {
            NativeMintNote::NUM_STORAGE_ITEMS_PRIVATE => {
                (4, MintRecipient::Private { digest: word(&items[0..4]) })
            },
            n if n >= NativeMintNote::MIN_NUM_STORAGE_ITEMS_PUBLIC => {
                let storage = NativeNoteStorage::new(
                    items[NativeMintNote::MIN_NUM_STORAGE_ITEMS_PUBLIC..].to_vec(),
                )
                .map_err(|err| js_error_with_context(err, "decode MINT note"))?;
                (
                    8,
                    MintRecipient::Public {
                        script_root: word(&items[0..4]),
                        serial_num: word(&items[4..8]),
                        storage,
                    },
                )
            },
            n => {
                return Err(from_str_err(&format!(
                    "decode MINT note: expected {} or at least {} storage items, found {n}",
                    NativeMintNote::NUM_STORAGE_ITEMS_PRIVATE,
                    NativeMintNote::MIN_NUM_STORAGE_ITEMS_PUBLIC,
                )));
            },
        };
        let asset = NativeAsset::from_id_and_value_words(
            word(&items[asset_at..asset_at + 4]),
            word(&items[asset_at + 4..asset_at + 8]),
        )
        .map_err(|err| js_error_with_context(err, "decode MINT note"))?;
        let tag = u32::try_from(items[asset_at + 8].as_canonical_u64())
            .map_err(|_| from_str_err("decode MINT note: tag exceeds u32"))?;
        Ok(MintNote {
            note: note.0.clone(),
            asset,
            tag: NativeNoteTag::new(tag),
            recipient,
        })
    }

    /// Account that created the note.
    pub fn sender(&self) -> AccountId {
        self.note.metadata().sender().into()
    }

    /// Asset the faucet mints.
    pub fn asset(&self) -> VaultAsset {
        self.asset.into()
    }

    /// Faucet that issues the asset and consumes the note to mint it.
    #[js_export(js_name = "faucetId")]
    pub fn faucet_id(&self) -> AccountId {
        self.asset.faucet_id().into()
    }

    /// Tag of the note the faucet creates.
    pub fn tag(&self) -> NoteTag {
        self.tag.into()
    }

    /// Recipient digest of the private note the faucet creates; `undefined` when it creates a
    /// public note.
    #[js_export(js_name = "recipientDigest")]
    pub fn recipient_digest(&self) -> Option<Word> {
        match &self.recipient {
            MintRecipient::Private { digest } => Some((*digest).into()),
            MintRecipient::Public { .. } => None,
        }
    }

    /// Script root of the public note the faucet creates; `undefined` for a private one.
    #[js_export(js_name = "recipientScriptRoot")]
    pub fn recipient_script_root(&self) -> Option<Word> {
        match &self.recipient {
            MintRecipient::Public { script_root, .. } => Some((*script_root).into()),
            MintRecipient::Private { .. } => None,
        }
    }

    /// Serial number of the public note the faucet creates; `undefined` for a private one.
    #[js_export(js_name = "recipientSerialNumber")]
    pub fn recipient_serial_number(&self) -> Option<Word> {
        match &self.recipient {
            MintRecipient::Public { serial_num, .. } => Some((*serial_num).into()),
            MintRecipient::Private { .. } => None,
        }
    }

    /// Storage of the public note the faucet creates; `undefined` for a private one.
    #[js_export(js_name = "recipientStorage")]
    pub fn recipient_storage(&self) -> Option<NoteStorage> {
        match &self.recipient {
            MintRecipient::Public { storage, .. } => Some(storage.into()),
            MintRecipient::Private { .. } => None,
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
