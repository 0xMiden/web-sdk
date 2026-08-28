use js_export_macro::js_export;
use miden_client::store::NoteFilter as NativeNoteFilter;

use super::note_id::NoteId;
use crate::platform::{JsErr, from_str_err};

// TODO: Add nullifier support

/// Filter options for querying notes from the store.
#[derive(Clone)]
#[js_export]
pub struct NoteFilter {
    note_type: NoteFilterTypes,
    note_ids: Option<Vec<NoteId>>,
}

#[js_export]
impl NoteFilter {
    /// Creates a new filter for the given type and optional note IDs.
    ///
    /// `List` requires `note_ids` to be set (any length). `Unique` requires
    /// exactly one note ID. Other filter types ignore `note_ids`.
    ///
    /// @throws if `note_ids` is missing or has the wrong length for a `List`
    /// or `Unique` filter.
    #[js_export(constructor)]
    pub fn new(
        note_type: NoteFilterTypes,
        note_ids: Option<Vec<NoteId>>,
    ) -> Result<NoteFilter, JsErr> {
        match note_type {
            NoteFilterTypes::List if note_ids.is_none() => {
                return Err(from_str_err("Note IDs required for List filter"));
            },
            NoteFilterTypes::Unique => match &note_ids {
                None => return Err(from_str_err("Note ID required for Unique filter")),
                Some(ids) if ids.len() != 1 => {
                    return Err(from_str_err("Exactly one Note ID must be provided for Unique filter"));
                },
                _ => {},
            },
            _ => {},
        }

        Ok(NoteFilter { note_type, note_ids })
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
}

// CONVERSIONS
// ================================================================================================

impl From<NoteFilter> for NativeNoteFilter {
    fn from(filter: NoteFilter) -> Self {
        match filter.note_type {
            NoteFilterTypes::All => NativeNoteFilter::All,
            NoteFilterTypes::Consumed => NativeNoteFilter::Consumed,
            NoteFilterTypes::Committed => NativeNoteFilter::Committed,
            NoteFilterTypes::Expected => NativeNoteFilter::Expected,
            NoteFilterTypes::Processing => NativeNoteFilter::Processing,
            NoteFilterTypes::List => {
                // Invariant guaranteed by NoteFilter::new: List filters always carry Some(_).
                let note_ids = filter.note_ids.expect("NoteFilter::new guarantees note_ids for List");
                NativeNoteFilter::List(note_ids.iter().map(Into::into).collect())
            },
            NoteFilterTypes::Unique => {
                // Invariant guaranteed by NoteFilter::new: Unique filters always carry exactly
                // one note ID.
                let note_ids = filter
                    .note_ids
                    .expect("NoteFilter::new guarantees exactly one note_id for Unique");
                NativeNoteFilter::Unique(
                    note_ids
                        .first()
                        .expect("NoteFilter::new guarantees exactly one note_id for Unique")
                        .into(),
                )
            },
            NoteFilterTypes::Nullifiers => NativeNoteFilter::Nullifiers(vec![]),
            NoteFilterTypes::Unverified => NativeNoteFilter::Unverified,
        }
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
                // Invariant guaranteed by NoteFilter::new: List filters always carry Some(_).
                let note_ids = filter
                    .note_ids
                    .clone()
                    .expect("NoteFilter::new guarantees note_ids for List");
                NativeNoteFilter::List(note_ids.iter().map(Into::into).collect())
            },
            NoteFilterTypes::Unique => {
                // Invariant guaranteed by NoteFilter::new: Unique filters always carry exactly
                // one note ID.
                let note_ids = filter
                    .note_ids
                    .clone()
                    .expect("NoteFilter::new guarantees exactly one note_id for Unique");
                NativeNoteFilter::Unique(
                    note_ids
                        .first()
                        .expect("NoteFilter::new guarantees exactly one note_id for Unique")
                        .into(),
                )
            },
            NoteFilterTypes::Nullifiers => NativeNoteFilter::Nullifiers(vec![]),
            NoteFilterTypes::Unverified => NativeNoteFilter::Unverified,
        }
    }
}

impl_napi_from_value!(NoteFilter);
