use js_export_macro::js_export;
use miden_client::transaction::{InputNote as NativeInputNote, NoteArgs as NativeNoteArgs};

use crate::models::input_note::InputNote;
use crate::models::miden_arrays::InputNoteAndArgsArray;
use crate::models::transaction_request::note_and_args::NoteArgs;

/// An input note paired with its optional arguments, carrying the mode the note is consumed in.
#[derive(Clone)]
#[js_export]
pub struct InputNoteAndArgs {
    note: InputNote,
    args: Option<NoteArgs>,
}

#[js_export]
impl InputNoteAndArgs {
    /// Creates a new input note/args pair for transaction building.
    #[js_export(constructor)]
    pub fn new(note: &InputNote, args: Option<NoteArgs>) -> InputNoteAndArgs {
        InputNoteAndArgs { note: note.clone(), args }
    }
}

impl From<InputNoteAndArgs> for (NativeInputNote, Option<NativeNoteArgs>) {
    fn from(note_and_args: InputNoteAndArgs) -> Self {
        let native_note: NativeInputNote = note_and_args.note.into();
        let native_args: Option<NativeNoteArgs> = note_and_args.args.map(Into::into);
        (native_note, native_args)
    }
}

impl From<&InputNoteAndArgs> for (NativeInputNote, Option<NativeNoteArgs>) {
    fn from(note_and_args: &InputNoteAndArgs) -> Self {
        let native_note: NativeInputNote = (&note_and_args.note).into();
        let native_args: Option<NativeNoteArgs> = note_and_args.args.clone().map(Into::into);
        (native_note, native_args)
    }
}

impl From<InputNoteAndArgsArray> for Vec<(NativeInputNote, Option<NativeNoteArgs>)> {
    fn from(note_and_args_array: InputNoteAndArgsArray) -> Self {
        note_and_args_array.into_iter().map(Into::into).collect()
    }
}

impl From<&InputNoteAndArgsArray> for Vec<(NativeInputNote, Option<NativeNoteArgs>)> {
    fn from(note_and_args_array: &InputNoteAndArgsArray) -> Self {
        note_and_args_array.iter().map(Into::into).collect()
    }
}

impl_napi_from_value!(InputNoteAndArgs);
