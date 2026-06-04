use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::account::AccountId as NativeAccountId;
use miden_client::note::{
    NetworkAccountTarget as NativeNetworkAccountTarget,
    NoteAttachment as NativeNoteAttachment,
    NoteAttachmentScheme as NativeNoteAttachmentScheme,
};

use super::account_id::AccountId;
use super::note_execution_hint::NoteExecutionHint;
use super::word::Word;
use crate::platform::{JsErr, from_str_err};

// NOTE ATTACHMENT SCHEME
// ================================================================================================

/// Describes the type of a note attachment.
///
/// Value `0` is reserved to signal that the scheme is none or absent. Whenever the kind of
/// attachment is not standardized or interoperability is unimportant, this none value can be used.
#[derive(Clone, Copy)]
#[js_export]
pub struct NoteAttachmentScheme(NativeNoteAttachmentScheme);

#[js_export]
impl NoteAttachmentScheme {
    /// Creates a new `NoteAttachmentScheme` from a u16.
    #[js_export(constructor)]
    pub fn new(scheme: u16) -> Result<NoteAttachmentScheme, JsErr> {
        NativeNoteAttachmentScheme::new(scheme)
            .map(NoteAttachmentScheme)
            .map_err(|e| from_str_err(&e.to_string()))
    }

    /// Returns the `NoteAttachmentScheme` that signals the absence of an attachment scheme.
    pub fn none() -> NoteAttachmentScheme {
        NoteAttachmentScheme(NativeNoteAttachmentScheme::none())
    }

    /// Returns true if the attachment scheme is the reserved value that signals an absent scheme.
    #[js_export(js_name = "isNone")]
    pub fn is_none(&self) -> bool {
        self.0.is_none()
    }

    /// Returns the note attachment scheme as a u16.
    #[js_export(js_name = "asU16")]
    pub fn as_u16(&self) -> u16 {
        self.0.as_u16()
    }
}

impl From<NativeNoteAttachmentScheme> for NoteAttachmentScheme {
    fn from(native: NativeNoteAttachmentScheme) -> Self {
        NoteAttachmentScheme(native)
    }
}

impl From<&NoteAttachmentScheme> for NativeNoteAttachmentScheme {
    fn from(scheme: &NoteAttachmentScheme) -> Self {
        scheme.0
    }
}

// NOTE ATTACHMENT
// ================================================================================================

/// An attachment to a note.
///
/// Note attachments provide additional context about how notes should be processed.
/// For example, a network account target attachment indicates that the note should
/// be consumed by a specific network account.
#[derive(Clone)]
#[js_export]
pub struct NoteAttachment(NativeNoteAttachment);

#[js_export]
impl NoteAttachment {
    /// Creates a new note attachment with a single word of content.
    #[js_export(js_name = "withWord")]
    pub fn with_word(scheme: &NoteAttachmentScheme, word: &Word) -> NoteAttachment {
        let native_word: NativeWord = word.into();
        NoteAttachment(NativeNoteAttachment::with_word(scheme.into(), native_word))
    }

    /// Creates a new note attachment with the provided words of content.
    #[js_export(js_name = "withWords")]
    pub fn with_words(
        scheme: &NoteAttachmentScheme,
        words: Vec<Word>,
    ) -> Result<NoteAttachment, JsErr> {
        let native_words: Vec<NativeWord> = words.iter().map(Into::into).collect();
        NativeNoteAttachment::with_words(scheme.into(), native_words)
            .map(NoteAttachment)
            .map_err(|e| from_str_err(&e.to_string()))
    }

    /// Returns the attachment scheme.
    #[js_export(js_name = "attachmentScheme")]
    pub fn attachment_scheme(&self) -> NoteAttachmentScheme {
        NoteAttachmentScheme(self.0.attachment_scheme())
    }

    /// Returns the attachment content as a list of words.
    #[js_export(js_name = "asWords")]
    pub fn as_words(&self) -> Vec<Word> {
        self.0.content().as_words().iter().map(Into::into).collect()
    }

    /// Creates a new note attachment for a network account target.
    ///
    /// This attachment indicates that the note should be consumed by a specific network account.
    ///
    /// # Arguments
    /// * `target_id` - The ID of the network account that should consume the note
    /// * `exec_hint` - A hint about when the note can be executed
    ///
    /// # Errors
    /// Returns an error if the target account is not a network account.
    #[js_export(js_name = "newNetworkAccountTarget")]
    pub fn new_network_account_target(
        target_id: &AccountId,
        exec_hint: &NoteExecutionHint,
    ) -> Result<NoteAttachment, JsErr> {
        let native_account_id: NativeAccountId = target_id.into();
        let native_target = NativeNetworkAccountTarget::new(native_account_id, exec_hint.into())
            .map_err(|e| from_str_err(&e.to_string()))?;
        let native_attachment: NativeNoteAttachment = native_target.into();
        Ok(NoteAttachment(native_attachment))
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNoteAttachment> for NoteAttachment {
    fn from(native_note_attachment: NativeNoteAttachment) -> Self {
        NoteAttachment(native_note_attachment)
    }
}

impl From<&NativeNoteAttachment> for NoteAttachment {
    fn from(native_note_attachment: &NativeNoteAttachment) -> Self {
        NoteAttachment(native_note_attachment.clone())
    }
}

impl From<NoteAttachment> for NativeNoteAttachment {
    fn from(note_attachment: NoteAttachment) -> Self {
        note_attachment.0
    }
}

impl From<&NoteAttachment> for NativeNoteAttachment {
    fn from(note_attachment: &NoteAttachment) -> Self {
        note_attachment.0.clone()
    }
}

impl_napi_from_value!(NoteAttachment);
