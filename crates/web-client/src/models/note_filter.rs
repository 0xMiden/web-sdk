use js_export_macro::js_export;
use miden_client::note::NoteScriptRoot;
use miden_client::store::NoteFilter as NativeNoteFilter;

use super::note_id::NoteId;
use super::word::Word;
use crate::platform::{JsErr, from_str_err};

// TODO: Add nullifier support

/// Filter options for querying notes from the store.
#[derive(Clone)]
#[js_export]
pub struct NoteFilter {
    note_type: NoteFilterTypes,
    note_ids: Option<Vec<NoteId>>,
    script_roots: Option<Vec<Word>>,
}

#[js_export]
impl NoteFilter {
    /// Creates a new filter for the given type and optional note IDs or script roots.
    #[js_export(constructor)]
    pub fn new(
        note_type: NoteFilterTypes,
        note_ids: Option<Vec<NoteId>>,
        script_roots: Option<Vec<Word>>,
    ) -> NoteFilter {
        NoteFilter { note_type, note_ids, script_roots }
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
            NoteFilterTypes::Nullifiers => NativeNoteFilter::Nullifiers(vec![]),
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

#[cfg(test)]
mod tests {
    use super::{NativeNoteFilter, NoteFilter, NoteFilterTypes};

    // Regression tests for a bug where constructing a `NoteFilter` with
    // `NoteFilterTypes::List` / `Unique` but no `note_ids` (a perfectly valid
    // call from the JS side, since `note_ids` is `Option<Vec<NoteId>>`) used
    // to panic (`unreachable` in WASM) instead of surfacing a catchable JS
    // error. See notes.rs::get_input_notes / get_output_notes for the call
    // sites that now propagate this via `try_into()?`.

    #[test]
    fn list_filter_without_note_ids_is_an_error_not_a_panic() {
        let filter = NoteFilter::new(NoteFilterTypes::List, None, None);
        let result: Result<NativeNoteFilter, _> = filter.try_into();
        assert!(result.is_err());
    }

    #[test]
    fn unique_filter_without_note_ids_is_an_error_not_a_panic() {
        let filter = NoteFilter::new(NoteFilterTypes::Unique, None, None);
        let result: Result<NativeNoteFilter, _> = filter.try_into();
        assert!(result.is_err());
    }
}
