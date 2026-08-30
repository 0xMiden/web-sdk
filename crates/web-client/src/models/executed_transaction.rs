use js_export_macro::js_export;
use miden_client::account::AccountHeader as NativeAccountHeader;
use miden_client::note::TxFeeNote;
use miden_client::transaction::ExecutedTransaction as NativeExecutedTransaction;
use miden_client::transaction::RawOutputNote as NativeRawOutputNote;

use super::account_header::AccountHeader;
use super::account_id::AccountId;
use super::account_patch::AccountPatch;
use super::block_header::BlockHeader;
use super::input_notes::InputNotes;
use super::output_note::OutputNote;
use super::output_notes::OutputNotes;
use super::transaction_args::TransactionArgs;
use super::transaction_id::TransactionId;

/// Describes the result of executing a transaction program for the Miden protocol.
///
/// Executed transaction serves two primary purposes:
/// - It contains a complete description of the effects of the transaction. Specifically, it
///   contains all output notes created as the result of the transaction and the absolute-valued
///   account patch produced by execution.
/// - It contains all the information required to re-execute and prove the transaction in a
///   stateless manner. This includes all public transaction inputs, but also all nondeterministic
///   inputs that the host provided to Miden VM while executing the transaction (i.e., advice
///   witness).
#[derive(Clone)]
#[js_export]
pub struct ExecutedTransaction(NativeExecutedTransaction);

#[js_export]
impl ExecutedTransaction {
    /// Returns the transaction ID.
    pub fn id(&self) -> TransactionId {
        self.0.id().into()
    }

    /// Returns the account the transaction was executed against.
    #[js_export(js_name = "accountId")]
    pub fn account_id(&self) -> AccountId {
        self.0.account_id().into()
    }

    //TODO: Expose partial account
    /// Returns the initial account header before execution.
    #[js_export(js_name = "initialAccountHeader")]
    pub fn initial_account_header(&self) -> AccountHeader {
        NativeAccountHeader::from(self.0.initial_account()).into()
    }

    /// Returns the final account header after execution.
    #[js_export(js_name = "finalAccountHeader")]
    pub fn final_account_header(&self) -> AccountHeader {
        self.0.final_account().into()
    }

    /// Returns the input notes consumed by the transaction.
    #[js_export(js_name = "inputNotes")]
    pub fn input_notes(&self) -> InputNotes {
        self.0.input_notes().into()
    }

    /// Returns the output notes produced by the transaction.
    ///
    /// NOTE: this includes the kernel's TX_FEE note on any chain whose `verification_base_fee`
    /// is non-zero. A transaction that produced one note on a fee-free chain produces two here,
    /// so callers that index or count this list must split it first -- see [`Self::fee_note`]
    /// and [`Self::user_output_notes`].
    #[js_export(js_name = "outputNotes")]
    pub fn output_notes(&self) -> OutputNotes {
        self.0.output_notes().into()
    }

    /// Returns the kernel's TX_FEE note, or `undefined` when the transaction paid no fee.
    ///
    /// Identified by NOTE SCRIPT ROOT against `TxFeeNote::script_root()`, which is the
    /// kernel's own designation. Consumers previously had to infer this from the `0xfee`
    /// note tag, and a tag is a plain `u32` that any caller-supplied output note can carry --
    /// so a tag-based split could both mislabel an ordinary note as the fee AND erase it from
    /// the transaction's totals. The script root cannot be forged by a note the transaction
    /// was merely asked to create.
    #[js_export(js_name = "feeNote")]
    pub fn fee_note(&self) -> Option<OutputNote> {
        self.0
            .output_notes()
            .iter()
            .find(|note| is_fee_note(note))
            .map(Into::into)
    }

    /// Returns the output notes the transaction's author actually created, with the kernel's
    /// TX_FEE note removed.
    ///
    /// This is what almost every caller of [`Self::output_notes`] means. Reaching for index 0
    /// of the unsplit list is correct only on a fee-free chain, and silently picks the fee note
    /// whenever the kernel happens to order it first.
    #[js_export(js_name = "userOutputNotes")]
    pub fn user_output_notes(&self) -> Vec<OutputNote> {
        self.0
            .output_notes()
            .iter()
            .filter(|note| !is_fee_note(note))
            .map(Into::into)
            .collect()
    }

    /// Returns the arguments passed to the transaction script.
    #[js_export(js_name = "txArgs")]
    pub fn tx_args(&self) -> TransactionArgs {
        self.0.tx_args().into()
    }

    /// Returns the block header that included the transaction.
    #[js_export(js_name = "blockHeader")]
    pub fn block_header(&self) -> BlockHeader {
        self.0.block_header().into()
    }

    /// Returns the absolute account patch resulting from execution.
    #[js_export(js_name = "accountPatch")]
    pub fn account_patch(&self) -> AccountPatch {
        self.0.account_patch().into()
    }

    // TODO: tx_inputs

    // TODO: advice_witness
}

// CONVERSIONS
// ================================================================================================

impl From<NativeExecutedTransaction> for ExecutedTransaction {
    fn from(native_executed_transaction: NativeExecutedTransaction) -> Self {
        ExecutedTransaction(native_executed_transaction)
    }
}

impl From<&NativeExecutedTransaction> for ExecutedTransaction {
    fn from(native_executed_transaction: &NativeExecutedTransaction) -> Self {
        ExecutedTransaction(native_executed_transaction.clone())
    }
}

/// Whether an output note is the kernel's TX_FEE note.
///
/// By script root, not by tag: the tag is forgeable by any note the transaction was asked to
/// create, the script root is not. A note whose body is not available (header-only) cannot be
/// the fee note -- the kernel always emits it as a full public note.
fn is_fee_note(note: &NativeRawOutputNote) -> bool {
    note.recipient()
        .is_some_and(|recipient| recipient.script().root() == TxFeeNote::script_root())
}
