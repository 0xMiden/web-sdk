use js_export_macro::js_export;

use super::input_note_record::InputNoteRecord;

/// Result of a bounded browser input-note scan before state filtering.
#[derive(Clone)]
#[js_export]
pub struct InputNotePageResult {
    pub(crate) notes: Vec<InputNoteRecord>,
    pub(crate) next_cursor: Option<String>,
    pub(crate) exhausted: bool,
}

#[js_export]
impl InputNotePageResult {
    /// Selected records, including partial records without metadata or a note ID.
    pub fn notes(&self) -> Vec<InputNoteRecord> {
        self.notes.clone()
    }

    /// Last scanned details commitment, including when no records matched.
    #[js_export(js_name = "nextCursor")]
    pub fn next_cursor(&self) -> Option<String> {
        self.next_cursor.clone()
    }

    /// Whether no further primary key existed when this page was read.
    pub fn exhausted(&self) -> bool {
        self.exhausted
    }
}
