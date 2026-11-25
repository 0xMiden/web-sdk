use js_export_macro::js_export;
use miden_protocol::transaction::TransactionMeasurements as NativeTransactionMeasurements;

use super::note_id::NoteId;

/// VM cycles one input note took to execute.
#[derive(Clone)]
#[js_export]
pub struct NoteExecutionCycles {
    note_id: NoteId,
    cycles: u32,
}

#[js_export]
impl NoteExecutionCycles {
    /// Returns the ID of the executed note.
    #[js_export(getter, js_name = "noteId")]
    pub fn note_id(&self) -> NoteId {
        self.note_id.clone()
    }

    /// Returns the cycles the note's script took.
    #[js_export(getter)]
    pub fn cycles(&self) -> u32 {
        self.cycles
    }
}

/// Cycle counts of each phase of an executed transaction.
#[derive(Clone)]
#[js_export]
pub struct TransactionMeasurements(NativeTransactionMeasurements);

#[js_export]
impl TransactionMeasurements {
    /// Returns the cycles spent in the transaction prologue.
    #[js_export(getter)]
    pub fn prologue(&self) -> u32 {
        cycles(self.0.prologue)
    }

    /// Returns the cycles spent preparing and processing all input notes.
    #[js_export(getter, js_name = "notesProcessing")]
    pub fn notes_processing(&self) -> u32 {
        cycles(self.0.notes_processing)
    }

    /// Returns the cycles of each executed note, in execution order.
    #[js_export(getter, js_name = "noteExecution")]
    pub fn note_execution(&self) -> Vec<NoteExecutionCycles> {
        self.0
            .note_execution
            .iter()
            .map(|(note_id, count)| NoteExecutionCycles {
                note_id: note_id.into(),
                cycles: cycles(*count),
            })
            .collect()
    }

    /// Returns the cycles spent running the transaction script.
    #[js_export(getter, js_name = "txScriptProcessing")]
    pub fn tx_script_processing(&self) -> u32 {
        cycles(self.0.tx_script_processing)
    }

    /// Returns the cycles spent in the transaction epilogue.
    #[js_export(getter)]
    pub fn epilogue(&self) -> u32 {
        cycles(self.0.epilogue)
    }

    /// Returns the cycles spent in the account's authentication procedure.
    #[js_export(getter, js_name = "authProcedure")]
    pub fn auth_procedure(&self) -> u32 {
        cycles(self.0.auth_procedure)
    }

    /// Returns the total cycles of the transaction: prologue, notes, script and epilogue.
    #[js_export(getter, js_name = "totalCycles")]
    pub fn total_cycles(&self) -> u32 {
        cycles(self.0.total_cycles())
    }
}

// The VM caps a trace at 2^29 rows, so a count never reaches `u32::MAX`; saturate rather than wrap.
fn cycles(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

impl From<&NativeTransactionMeasurements> for TransactionMeasurements {
    fn from(native: &NativeTransactionMeasurements) -> Self {
        TransactionMeasurements(native.clone())
    }
}
