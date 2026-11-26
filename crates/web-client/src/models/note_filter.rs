use js_export_macro::js_export;
use miden_client::note::{NoteScriptRoot, Nullifier};
use miden_client::store::NoteFilter as NativeNoteFilter;

use super::note_id::NoteId;
use super::word::Word;
use crate::platform::{JsErr, from_str_err};

/// Filter options for querying notes from the store.
#[derive(Clone)]
#[js_export]
pub struct NoteFilter {
    note_type: NoteFilterTypes,
    note_ids: Option<Vec<NoteId>>,
    script_roots: Option<Vec<Word>>,
    nullifiers: Option<Vec<Word>>,
    after: Option<String>,
    limit: Option<u32>,
}

#[js_export]
impl NoteFilter {
    /// Creates a new filter for the given type and optional note IDs, script roots or nullifiers.
    #[js_export(constructor)]
    pub fn new(
        note_type: NoteFilterTypes,
        note_ids: Option<Vec<NoteId>>,
        script_roots: Option<Vec<Word>>,
        nullifiers: Option<Vec<Word>>,
    ) -> NoteFilter {
        NoteFilter {
            note_type,
            note_ids,
            script_roots,
            nullifiers,
            after: None,
            limit: None,
        }
    }

    /// Returns this filter bounded to a page: at most `limit` notes, ordered by their key and
    /// strictly above the `after` cursor.
    ///
    /// Input notes are keyed by details commitment (hex of `detailsCommitment()`), output notes
    /// by note ID (`id().toString()`). Pass the key of the last note of a page to read the next.
    pub fn page(&self, after: Option<String>, limit: Option<u32>) -> NoteFilter {
        NoteFilter { after, limit, ..self.clone() }
    }
}

impl NoteFilter {
    /// Cuts `records` to this filter's page, or returns them untouched when it has none.
    pub(crate) fn bound<T>(&self, records: Vec<T>, key: impl Fn(&T) -> String) -> Vec<T> {
        if self.after.is_none() && self.limit.is_none() {
            return records;
        }
        crate::bounded::page_after(records, key, self.after.as_ref(), self.limit)
    }
}

#[derive(Clone)]
#[js_export]
pub enum NoteFilterTypes {
    All,
    Consumed,
    Committed,
    Expected,
    Processing,
    List,
    Unique,
    Nullifiers,
    Unverified,
    ScriptRoots,
}

// CONVERSIONS
// ================================================================================================

impl TryFrom<NoteFilter> for NativeNoteFilter {
    type Error = JsErr;

    fn try_from(filter: NoteFilter) -> Result<Self, Self::Error> {
        (&filter).try_into()
    }
}

impl TryFrom<&NoteFilter> for NativeNoteFilter {
    type Error = JsErr;

    fn try_from(filter: &NoteFilter) -> Result<Self, Self::Error> {
        Ok(match filter.note_type {
            NoteFilterTypes::All => NativeNoteFilter::All,
            NoteFilterTypes::Consumed => NativeNoteFilter::Consumed,
            NoteFilterTypes::Committed => NativeNoteFilter::Committed,
            NoteFilterTypes::Expected => NativeNoteFilter::Expected,
            NoteFilterTypes::Processing => NativeNoteFilter::Processing,
            NoteFilterTypes::List => {
                let note_ids = filter
                    .note_ids
                    .clone()
                    .ok_or_else(|| from_str_err("Note IDs required for List filter"))?;
                NativeNoteFilter::List(note_ids.iter().map(Into::into).collect())
            },
            NoteFilterTypes::Unique => {
                let note_ids = filter
                    .note_ids
                    .clone()
                    .ok_or_else(|| from_str_err("Note ID required for Unique filter"))?;

                if note_ids.len() != 1 {
                    return Err(from_str_err("Only one Note ID can be provided"));
                }

                NativeNoteFilter::Unique(note_ids.first().expect("length checked above").into())
            },
            NoteFilterTypes::Nullifiers => {
                let nullifiers = filter
                    .nullifiers
                    .clone()
                    .ok_or_else(|| from_str_err("Nullifiers required for Nullifiers filter"))?;

                NativeNoteFilter::Nullifiers(
                    nullifiers
                        .iter()
                        .map(|nullifier| Nullifier::from_raw(nullifier.into()))
                        .collect(),
                )
            },
            NoteFilterTypes::Unverified => NativeNoteFilter::Unverified,
            NoteFilterTypes::ScriptRoots => {
                let script_roots = filter
                    .script_roots
                    .clone()
                    .ok_or_else(|| from_str_err("Script roots required for ScriptRoots filter"))?;

                NativeNoteFilter::ScriptRoots(
                    script_roots
                        .iter()
                        .map(|script_root| NoteScriptRoot::from_raw(script_root.into()))
                        .collect(),
                )
            },
        })
    }
}

impl_napi_from_value!(NoteFilter);
