use js_export_macro::js_export;
use miden_client::note::TxFeeNote;
use miden_client::transaction::{
    RawOutputNote as NativeRawOutputNote,
    RawOutputNotes as NativeRawOutputNotes,
    TransactionOutcome as NativeTransactionOutcome,
    TransactionWitness as NativeTransactionWitness,
};

use super::account_header::AccountHeader;
use super::account_id::AccountId;
use super::account_patch::AccountPatch;
use super::block_header::BlockHeader;
use super::input_notes::InputNotes;
use super::output_note::OutputNote;
use super::output_notes::OutputNotes;
use super::transaction_args::TransactionArgs;
use super::transaction_id::TransactionId;
use super::transaction_logs::TransactionLogs;
use crate::platform::{JsErr, from_str_err};

/// Describes the result of executing a transaction program for the Miden protocol.
///
/// An executed transaction has two parts:
/// - The outcome: a complete description of the effects of the transaction. It contains the account
///   headers before and after the transaction, the absolute-valued account patch, the input notes
///   and all output notes created as the result of the transaction.
/// - The witness: the inputs required to re-execute and prove the transaction. An executed
///   transaction from a `TransactionStoreUpdate` does not have it, so `txArgs()` and
///   `blockHeader()` throw for it.
#[derive(Clone)]
#[js_export]
pub struct ExecutedTransaction {
    outcome: NativeTransactionOutcome,
    witness: Option<NativeTransactionWitness>,
}

#[js_export]
impl ExecutedTransaction {
    /// Returns the transaction ID.
    pub fn id(&self) -> TransactionId {
        self.outcome.id().into()
    }

    /// Returns the account the transaction was executed against.
    #[js_export(js_name = "accountId")]
    pub fn account_id(&self) -> AccountId {
        self.outcome.account_id().into()
    }

    //TODO: Expose partial account
    /// Returns the initial account header before execution.
    #[js_export(js_name = "initialAccountHeader")]
    pub fn initial_account_header(&self) -> AccountHeader {
        self.outcome.initial_account().into()
    }

    /// Returns the final account header after execution.
    #[js_export(js_name = "finalAccountHeader")]
    pub fn final_account_header(&self) -> AccountHeader {
        self.outcome.final_account().into()
    }

    /// Returns the input notes consumed by the transaction.
    #[js_export(js_name = "inputNotes")]
    pub fn input_notes(&self) -> InputNotes {
        self.outcome.effects().input_notes().into()
    }

    /// Returns the output notes produced by the transaction.
    ///
    /// NOTE: this includes the kernel's `TX_FEE` note on any chain whose `verification_base_fee`
    /// is non-zero. A transaction that produced one note on a fee-free chain produces two here,
    /// so callers that index or count this list must split it first -- see [`Self::fee_note`]
    /// and [`Self::user_output_notes`].
    #[js_export(js_name = "outputNotes")]
    pub fn output_notes(&self) -> OutputNotes {
        self.native_output_notes().into()
    }

    /// Returns the kernel's `TX_FEE` note, or `undefined` when the transaction paid no fee.
    ///
    /// The fee note is identified by its note script root -- the kernel's own designation -- and
    /// not by the `0xfee` note tag, which is a plain `u32` that any caller-supplied output note
    /// can carry. A script root is the hash of the note's script, so it takes the fee script
    /// itself to collide with.
    #[js_export(js_name = "feeNote")]
    pub fn fee_note(&self) -> Option<OutputNote> {
        self.native_output_notes().iter().find(|note| is_fee_note(note)).map(Into::into)
    }

    /// Returns the output notes the transaction's author actually created, with the kernel's
    /// `TX_FEE` note removed.
    ///
    /// This is what almost every caller of [`Self::output_notes`] means. Reaching for index 0
    /// of the unsplit list is correct only on a fee-free chain, and silently picks the fee note
    /// whenever the kernel happens to order it first.
    #[js_export(js_name = "userOutputNotes")]
    pub fn user_output_notes(&self) -> Vec<OutputNote> {
        self.native_output_notes()
            .iter()
            .filter(|note| !is_fee_note(note))
            .map(Into::into)
            .collect()
    }

    /// Returns the arguments passed to the transaction script.
    ///
    /// Throws for an executed transaction from a `TransactionStoreUpdate`, which does not hold the
    /// transaction inputs.
    #[js_export(js_name = "txArgs")]
    pub fn tx_args(&self) -> Result<TransactionArgs, JsErr> {
        Ok(self.witness()?.tx_inputs().tx_args().into())
    }

    /// Returns the reference block header of the transaction.
    ///
    /// Throws for an executed transaction from a `TransactionStoreUpdate`, which does not hold the
    /// transaction inputs.
    #[js_export(js_name = "blockHeader")]
    pub fn block_header(&self) -> Result<BlockHeader, JsErr> {
        Ok(self.witness()?.tx_inputs().block_header().into())
    }

    /// Returns the absolute account patch resulting from execution.
    #[js_export(js_name = "accountPatch")]
    pub fn account_patch(&self) -> AccountPatch {
        self.outcome.effects().account_patch().into()
    }

    /// Returns the logs that the transaction emitted, in emission order.
    pub fn logs(&self) -> TransactionLogs {
        self.outcome.effects().logs().clone().into()
    }

    // TODO: tx_inputs

    // TODO: advice_witness
}

impl ExecutedTransaction {
    /// Creates an executed transaction from its outcome and, if available, its witness.
    pub(crate) fn new(
        outcome: NativeTransactionOutcome,
        witness: Option<NativeTransactionWitness>,
    ) -> Self {
        Self { outcome, witness }
    }

    fn native_output_notes(&self) -> &NativeRawOutputNotes {
        self.outcome.effects().output_notes()
    }

    fn witness(&self) -> Result<&NativeTransactionWitness, JsErr> {
        self.witness.as_ref().ok_or_else(|| {
            from_str_err(
                "the executed transaction of a TransactionStoreUpdate does not hold the \
                 transaction inputs",
            )
        })
    }
}

/// Whether an output note is the kernel's `TX_FEE` note.
///
/// By script root, not by tag: a tag is a free `u32` on any note the transaction was asked to
/// create, whereas colliding on the root takes the fee script itself. A note whose body is not
/// available (header-only) cannot be the fee note -- the kernel always emits it as a full public
/// note.
// Not literally unforgeable: `TxFeeNote::script()` is public, so a transaction can be asked to
// emit an output note carrying the fee script, and the first match wins. The only party able to do
// that is the transaction's own author, who gains nothing by misleading their own client.
// `TxFeeNote::derive_serial_number` would make the predicate exact if a caller-hostile case ever
// appears.
fn is_fee_note(note: &NativeRawOutputNote) -> bool {
    note.recipient()
        .is_some_and(|recipient| recipient.script().root() == TxFeeNote::script_root())
}
