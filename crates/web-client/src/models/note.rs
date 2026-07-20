use js_export_macro::js_export;
use miden_client::asset::Asset as NativeAsset;
use miden_client::block::BlockNumber as NativeBlockNumber;
use miden_client::crypto::RandomCoin;
use miden_client::note::{Note as NativeNote, NoteAssets as NativeNoteAssets, P2idNote, P2ideNote};
use miden_client::{Felt as NativeFelt, Word as NativeWord};

use super::NoteType;
use super::account_id::AccountId;
use super::note_assets::NoteAssets;
use super::note_attachment::NoteAttachment;
use super::note_id::NoteId;
use super::note_metadata::NoteMetadata;
use super::note_recipient::NoteRecipient;
use super::note_script::NoteScript;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_from_bytes, serialize_to_bytes};

/// A note bundles public metadata with private details: assets, script, inputs, and a serial number
/// grouped into a recipient. The public identifier (`NoteId`) commits to those
/// details, while the nullifier stays hidden until the note is consumed. Assets move by
/// transferring them into the note; the script and inputs define how and when consumption can
/// happen. See `NoteRecipient` for the shape of the recipient data.
#[js_export]
#[derive(Clone)]
pub struct Note(pub(crate) NativeNote);

#[js_export]
impl Note {
    /// Creates a new note from the provided assets, metadata, and recipient.
    ///
    /// Migration note (miden-client PR #2214): `Note::new` now takes a
    /// `PartialNoteMetadata` (not `NoteMetadata`). Extract the partial
    /// fields from the JS-side `NoteMetadata` and reconstruct.
    #[js_export(constructor)]
    pub fn new(
        note_assets: &NoteAssets,
        note_metadata: &NoteMetadata,
        note_recipient: &NoteRecipient,
    ) -> Note {
        let native_metadata: miden_client::note::NoteMetadata = note_metadata.into();
        let partial = miden_client::note::PartialNoteMetadata::new(
            native_metadata.sender(),
            native_metadata.note_type(),
        )
        .with_tag(native_metadata.tag());
        Note(NativeNote::new(note_assets.into(), partial, note_recipient.into()))
    }

    /// Serializes the note into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes a note from its byte representation.
    pub fn deserialize(bytes: JsBytes) -> Result<Note, JsErr> {
        deserialize_from_bytes::<NativeNote>(&bytes).map(Note)
    }

    /// Returns the unique identifier of the note.
    pub fn id(&self) -> NoteId {
        self.0.id().into()
    }

    /// Returns the commitment to the note (its ID).
    ///
    /// Migration note (miden-client PR #2214): `Note::commitment()` was
    /// removed on the 0.15 surface — the note ID is the commitment. Return
    /// the underlying `NoteId` as a `Word` so the JS API contract is
    /// unchanged.
    pub fn commitment(&self) -> Word {
        self.0.id().as_word().into()
    }

    /// Returns the public metadata associated with the note.
    pub fn metadata(&self) -> NoteMetadata {
        (*self.0.metadata()).into()
    }

    /// Returns the recipient who can consume this note.
    pub fn recipient(&self) -> NoteRecipient {
        self.0.recipient().clone().into()
    }

    /// Returns the assets locked inside the note.
    pub fn assets(&self) -> NoteAssets {
        self.0.assets().clone().into()
    }

    /// Returns the script that guards the note.
    pub fn script(&self) -> NoteScript {
        self.0.script().clone().into()
    }

    /// Returns the note nullifier as a word.
    pub fn nullifier(&self) -> Word {
        let nullifier = self.0.nullifier();
        let elements: [miden_client::Felt; 4] =
            nullifier.as_elements().try_into().expect("nullifier has 4 elements");
        let native_word: NativeWord = NativeWord::from(&elements);
        native_word.into()
    }

    /// Builds a standard P2ID note that targets the specified account.
    #[js_export(js_name = "createP2IDNote")]
    pub fn create_p2id_note(
        sender: &AccountId,
        target: &AccountId,
        assets: &NoteAssets,
        note_type: NoteType,
        attachment: &NoteAttachment,
    ) -> Result<Self, JsErr> {
        let coin_seed: [u64; 4] = rand::random();
        // `coin_seed` is freshly random `u64`s; values at or beyond the modulus would only
        // happen with vanishing probability and `new_unchecked` is what the upstream Rust
        // client uses in the same spot.
        let mut rng = RandomCoin::new(coin_seed.map(NativeFelt::new_unchecked).into());

        let native_note_assets: NativeNoteAssets = assets.into();
        let native_assets: Vec<NativeAsset> = native_note_assets.iter().copied().collect();

        let native_attachment: miden_client::note::NoteAttachment = attachment.into();

        let native_note: NativeNote = P2idNote::builder()
            .sender(sender.into())
            .target(target.into())
            .assets(native_assets)
            .note_type(note_type.into())
            .attachment(native_attachment)
            .generate_serial_number(&mut rng)
            .build()
            .map_err(|err| js_error_with_context(err, "create p2id note"))?
            .into();

        Ok(native_note.into())
    }

    /// Builds a P2IDE note that can be reclaimed or timelocked based on block heights.
    #[js_export(js_name = "createP2IDENote")]
    pub fn create_p2ide_note(
        sender: &AccountId,
        target: &AccountId,
        assets: &NoteAssets,
        reclaim_height: Option<u32>,
        timelock_height: Option<u32>,
        note_type: NoteType,
        attachment: &NoteAttachment,
    ) -> Result<Self, JsErr> {
        let coin_seed: [u64; 4] = rand::random();
        // See `create_p2id_note` for why `new_unchecked` is fine here.
        let mut rng = RandomCoin::new(coin_seed.map(NativeFelt::new_unchecked).into());

        let native_note_assets: NativeNoteAssets = assets.into();
        let native_assets: Vec<NativeAsset> = native_note_assets.iter().copied().collect();

        let native_attachment: miden_client::note::NoteAttachment = attachment.into();

        let native_note: NativeNote = P2ideNote::builder()
            .sender(sender.into())
            .target(target.into())
            .assets(native_assets)
            .note_type(note_type.into())
            .attachment(native_attachment)
            .maybe_reclaim_height(reclaim_height.map(NativeBlockNumber::from))
            .maybe_timelock_height(timelock_height.map(NativeBlockNumber::from))
            .generate_serial_number(&mut rng)
            .build()
            .map_err(|err| js_error_with_context(err, "create p2ide note"))?
            .into();

        Ok(native_note.into())
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNote> for Note {
    fn from(note: NativeNote) -> Self {
        Note(note)
    }
}

impl From<&NativeNote> for Note {
    fn from(note: &NativeNote) -> Self {
        Note(note.clone())
    }
}

impl From<Note> for NativeNote {
    fn from(note: Note) -> Self {
        note.0
    }
}

impl From<&Note> for NativeNote {
    fn from(note: &Note) -> Self {
        note.0.clone()
    }
}

impl From<crate::models::miden_arrays::NoteArray> for Vec<NativeNote> {
    fn from(note_array: crate::models::miden_arrays::NoteArray) -> Self {
        note_array.into_iter().map(Into::into).collect()
    }
}

impl From<&crate::models::miden_arrays::NoteArray> for Vec<NativeNote> {
    fn from(note_array: &crate::models::miden_arrays::NoteArray) -> Self {
        note_array.iter().cloned().map(Into::into).collect()
    }
}

impl_napi_from_value!(Note);
