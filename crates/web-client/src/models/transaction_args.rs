use js_export_macro::js_export;
use miden_client::transaction::TransactionArgs as NativeTransactionArgs;

use super::advice_inputs::AdviceInputs;
use super::bound_signature::BoundSignature;
use super::note_id::NoteId;
use super::note_recipient::NoteRecipient;
use super::transaction_script::TransactionScript;
use super::word::Word;

/// Optional transaction arguments.
///
/// - Transaction script: a program that is executed in a transaction after all input notes scripts
///   have been executed.
/// - Note arguments: data put onto the stack right before a note script is executed. These are
///   different from note inputs, as the user executing the transaction can specify arbitrary note
///   args.
/// - Advice inputs: Provides data needed by the runtime. The recipients of the expected output
///   notes and the signatures are not part of them. Read those with `outputNoteRecipients` and
///   `signatures`.
/// - Account inputs: Provides account data that will be accessed in the transaction.
#[derive(Clone)]
#[js_export]
pub struct TransactionArgs(NativeTransactionArgs);

#[js_export]
impl TransactionArgs {
    /// Returns the transaction script if provided.
    #[js_export(js_name = "txScript")]
    pub fn tx_script(&self) -> Option<TransactionScript> {
        self.0.tx_script().map(Into::into)
    }

    /// Returns note-specific arguments for the given note ID.
    #[js_export(js_name = "getNoteArgs")]
    pub fn get_note_args(&self, note_id: &NoteId) -> Option<Word> {
        self.0.get_note_args(note_id.into()).map(Into::into)
    }

    /// Returns advice inputs attached to the transaction.
    #[js_export(js_name = "adviceInputs")]
    pub fn advice_inputs(&self) -> AdviceInputs {
        self.0.advice_inputs().into()
    }

    /// Returns the recipients of the output notes that the transaction is expected to create.
    #[js_export(js_name = "outputNoteRecipients")]
    pub fn output_note_recipients(&self) -> Vec<NoteRecipient> {
        self.0.output_note_recipients().iter().map(Into::into).collect()
    }

    /// Returns the bound signatures that the transaction carries for its authentication.
    pub fn signatures(&self) -> Vec<BoundSignature> {
        self.0.signatures().iter().map(Into::into).collect()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeTransactionArgs> for TransactionArgs {
    fn from(native_args: NativeTransactionArgs) -> Self {
        TransactionArgs(native_args)
    }
}

impl From<&NativeTransactionArgs> for TransactionArgs {
    fn from(native_args: &NativeTransactionArgs) -> Self {
        TransactionArgs(native_args.clone())
    }
}
