use js_export_macro::js_export;
use miden_client::transaction::{InputNote as NativeInputNote, InputNotes as NativeInputNotes};

use super::input_note::InputNote;
use super::word::Word;
use crate::platform::{JsErr, from_str_err};

/// Input notes for a transaction, empty if the transaction does not consume notes.
#[derive(Clone)]
#[js_export]
pub struct InputNotes(NativeInputNotes<NativeInputNote>);

#[js_export]
impl InputNotes {
    /// Returns the commitment to all input notes.
    pub fn commitment(&self) -> Word {
        self.0.commitment().into()
    }

    /// Returns the number of input notes.
    #[js_export(js_name = "numNotes")]
    pub fn num_notes(&self) -> u32 {
        u32::from(self.0.num_notes())
    }

    /// Returns true if there are no input notes.
    #[js_export(js_name = "isEmpty")]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Returns the input note at the specified index.
    #[js_export(js_name = "getNote")]
    pub fn get_note(&self, index: u32) -> Result<InputNote, JsErr> {
        let index = index as usize;
        let length = usize::from(self.0.num_notes());
        if index >= length {
            return Err(from_str_err(&format!(
                "InputNotes index out of bounds: tried to access index {index} with length {length}"
            )));
        }

        Ok(self.0.get_note(index).into())
    }

    /// Returns all input notes as a vector.
    pub fn notes(&self) -> Vec<InputNote> {
        self.0.iter().cloned().map(Into::into).collect()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeInputNotes<NativeInputNote>> for InputNotes {
    fn from(native_notes: NativeInputNotes<NativeInputNote>) -> Self {
        InputNotes(native_notes)
    }
}

impl From<&NativeInputNotes<NativeInputNote>> for InputNotes {
    fn from(native_notes: &NativeInputNotes<NativeInputNote>) -> Self {
        InputNotes(native_notes.clone())
    }
}
