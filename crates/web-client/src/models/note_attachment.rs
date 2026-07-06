use js_export_macro::js_export;
use miden_client::note::{
    NoteAttachment as NativeNoteAttachment,
    NoteAttachmentScheme as NativeNoteAttachmentScheme,
};
use miden_client::{Felt as NativeFelt, Word as NativeWord};

use super::word::Word;
use crate::platform::{JsErr, from_str_err, js_u64_to_u64};

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
    /// Creates a new `NoteAttachmentScheme` from a u32 value.
    ///
    /// Errors if `scheme` is out of range (the 0.15 surface narrowed the
    /// underlying type from u32 → u16, so values outside `0..=u16::MAX`
    /// are rejected).
    #[js_export(constructor)]
    pub fn new(scheme: u32) -> Result<NoteAttachmentScheme, JsErr> {
        let scheme_u16: u16 = scheme
            .try_into()
            .map_err(|_| from_str_err("attachment scheme value exceeds u16 range"))?;
        NativeNoteAttachmentScheme::new(scheme_u16)
            .map(NoteAttachmentScheme)
            .map_err(|err| from_str_err(&format!("invalid attachment scheme: {err}")))
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
/// 0.15 protocol surface: an attachment is a `(scheme, content)` pair where
/// `content` is a flat `Vec<Word>` of 1..=256 words. The previous
/// `NoteAttachmentKind { Word, Array }` dispatch and the per-variant
/// `asWord` / `asArray` / `newWord` / `newArray` getters/constructors no
/// longer exist — content is always word-vector-shaped now. Use
/// `fromWord(scheme, word)` for the common single-word case or
/// `fromWords(scheme, words)` for multi-word content.
#[derive(Clone)]
#[js_export]
pub struct NoteAttachment(NativeNoteAttachment);

#[js_export]
impl NoteAttachment {
    /// Creates a note attachment from an optional list of packed values.
    ///
    /// Mirrors the encoding the JS-side `createNoteAttachment` helper performs
    /// and preserves the `new NoteAttachment()` / `new NoteAttachment([...])`
    /// ergonomics the package's own JS wrappers (`js/standalone.js`,
    /// `js/resources/transactions.js`) rely on. The 0.15 surface has no truly
    /// empty attachment (content is 1..=256 words), so the empty case is
    /// represented as a single zero [`Word`] with the `none` scheme:
    /// - no args / empty list → single zero-`Word`, `none` scheme.
    /// - any number of values → padded to a whole number of `Word`s, `none` scheme.
    ///
    /// # Errors
    /// Returns an error if a value is not a canonical field element, or if the
    /// packed word count exceeds `NoteAttachment::MAX_NUM_WORDS`.
    #[js_export(constructor)]
    pub fn new(values: Option<Vec<JsU64>>) -> Result<NoteAttachment, JsErr> {
        let scheme = NativeNoteAttachmentScheme::none();
        let values: Vec<u64> = values.unwrap_or_default().into_iter().map(js_u64_to_u64).collect();

        if values.is_empty() {
            let zero = NativeFelt::new(0).expect("0 is a valid field element");
            let zero_word = NativeWord::from([zero; 4]);
            return Ok(NoteAttachment(NativeNoteAttachment::with_word(scheme, zero_word)));
        }

        // Pad up to a whole number of 4-element words.
        let mut padded = values;
        while !padded.len().is_multiple_of(4) {
            padded.push(0);
        }

        let words: Vec<NativeWord> = padded
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| {
                let felts: [NativeFelt; 4] = chunk
                    .iter()
                    .map(|&v| NativeFelt::new(v))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|err| from_str_err(&format!("invalid field element: {err}")))?
                    .try_into()
                    .expect("chunk is exactly 4 elements");
                Ok::<NativeWord, JsErr>(NativeWord::from(felts))
            })
            .collect::<Result<Vec<_>, _>>()?;

        NativeNoteAttachment::with_words(scheme, words)
            .map(NoteAttachment)
            .map_err(|e| from_str_err(&e.to_string()))
    }

    /// Creates a new note attachment from a single word.
    #[js_export(js_name = "fromWord")]
    pub fn from_word(scheme: &NoteAttachmentScheme, word: &Word) -> NoteAttachment {
        let native_word: NativeWord = word.into();
        NoteAttachment(NativeNoteAttachment::with_word(scheme.into(), native_word))
    }

    /// Creates a new note attachment from a vector of words.
    ///
    /// # Errors
    /// Returns an error if `words` is empty or exceeds `NoteAttachment::MAX_NUM_WORDS`.
    #[js_export(js_name = "fromWords")]
    pub fn from_words(
        scheme: &NoteAttachmentScheme,
        words: Vec<Word>,
    ) -> Result<NoteAttachment, JsErr> {
        let native_words: Vec<NativeWord> = words.iter().map(NativeWord::from).collect();
        NativeNoteAttachment::with_words(scheme.into(), native_words)
            .map(NoteAttachment)
            .map_err(|e| from_str_err(&e.to_string()))
    }

    /// Returns the attachment scheme.
    #[js_export(js_name = "attachmentScheme")]
    pub fn attachment_scheme(&self) -> NoteAttachmentScheme {
        self.0.attachment_scheme().into()
    }

    /// Returns the number of words in this attachment.
    #[js_export(js_name = "numWords")]
    pub fn num_words(&self) -> u16 {
        self.0.num_words()
    }

    /// Returns the attachment content as its constituent words.
    ///
    /// The content is always word-vector-shaped on the 0.15 surface, so this is
    /// the inverse of `fromWord` / `fromWords`: it yields the same `Word`s the
    /// attachment was built from (in order), letting JS callers decode the
    /// packed values back out.
    #[js_export(js_name = "toWords")]
    pub fn to_words(&self) -> Vec<Word> {
        self.0.content().as_words().iter().map(Word::from).collect()
    }

    // NOTE: the previous `newWord` / `newArray` constructors, `asWord` /
    // `asArray` getters, `attachmentKind` accessor, and the
    // `newNetworkAccountTarget` helper were removed in the migration to
    // miden-client PR #2214. The 0.15 protocol surface dropped the
    // word-vs-array content dispatch (content is always `Vec<Word>`) and
    // the `NetworkAccountTarget` type does not exist on this surface.
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
