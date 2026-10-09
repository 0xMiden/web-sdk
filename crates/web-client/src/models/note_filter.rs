use js_export_macro::js_export;
use miden_client::note::NoteScriptRoot;
use miden_client::store::NoteFilter as NativeNoteFilter;

use super::note_id::NoteId;
use super::word::Word;

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

impl From<NoteFilter> for NativeNoteFilter {
    fn from(filter: NoteFilter) -> Self {
        (&filter).into()
    }
}

impl From<&NoteFilter> for NativeNoteFilter {
    fn from(filter: &NoteFilter) -> Self {
        match filter.note_type {
            NoteFilterTypes::All => NativeNoteFilter::All,
            NoteFilterTypes::Consumed => NativeNoteFilter::Consumed,
            NoteFilterTypes::Committed => NativeNoteFilter::Committed,
            NoteFilterTypes::Expected => NativeNoteFilter::Expected,
            NoteFilterTypes::Processing => NativeNoteFilter::Processing,
            NoteFilterTypes::List => {
                let note_ids = filter
                    .note_ids
                    .clone()
                    .unwrap_or_else(|| panic!("Note IDs required for List filter"));
                NativeNoteFilter::List(note_ids.iter().map(Into::into).collect())
            },
            NoteFilterTypes::Unique => {
                let note_ids = filter
                    .note_ids
                    .clone()
                    .unwrap_or_else(|| panic!("Note ID required for Unique filter"));

                assert!(note_ids.len() == 1, "Only one Note ID can be provided");

                NativeNoteFilter::Unique(note_ids.first().unwrap().into())
            },
            NoteFilterTypes::Nullifiers => NativeNoteFilter::Nullifiers(vec![]),
            NoteFilterTypes::Unverified => NativeNoteFilter::Unverified,
            NoteFilterTypes::ScriptRoots => {
                let script_roots = filter
                    .script_roots
                    .clone()
                    .unwrap_or_else(|| panic!("Script roots required for ScriptRoots filter"));

                NativeNoteFilter::ScriptRoots(
                    script_roots
                        .iter()
                        .map(|script_root| NoteScriptRoot::from_raw(script_root.into()))
                        .collect(),
                )
            },
        }
    }
}

impl_napi_from_value!(NoteFilter);
