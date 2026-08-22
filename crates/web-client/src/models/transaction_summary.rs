use js_export_macro::js_export;
use miden_client::transaction::TransactionSummary as NativeTransactionSummary;

use super::account_delta::AccountDelta;
use super::felt::Felt;
use super::input_notes::InputNotes;
use super::output_notes::OutputNotes;
use super::word::Word;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_untrusted_bytes, serialize_to_bytes};

/// Represents a transaction summary.
#[derive(Clone)]
#[js_export]
pub struct TransactionSummary(NativeTransactionSummary);

#[js_export]
impl TransactionSummary {
    /// Serializes the summary into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes a summary from bytes.
    ///
    /// Uses the untrusted path, like [`ChainAnchor::deserialize`]: a summary crosses the same
    /// wire, from the same counterparty, in the same envelope.
    ///
    /// [`ChainAnchor::deserialize`]: crate::models::chain_anchor::ChainAnchor::deserialize
    pub fn deserialize(bytes: JsBytes) -> Result<TransactionSummary, JsErr> {
        deserialize_untrusted_bytes::<NativeTransactionSummary>(&bytes).map(TransactionSummary)
    }

    /// Returns the account delta described by the summary.
    #[js_export(js_name = "accountDelta")]
    pub fn account_delta(&self) -> Result<AccountDelta, JsErr> {
        Ok(self.0.account_delta().into())
    }

    /// Returns the input notes referenced by the summary.
    #[js_export(js_name = "inputNotes")]
    pub fn input_notes(&self) -> Result<InputNotes, JsErr> {
        Ok(self.0.input_notes().into())
    }

    /// Returns the output notes referenced by the summary.
    #[js_export(js_name = "outputNotes")]
    pub fn output_notes(&self) -> Result<OutputNotes, JsErr> {
        Ok(self.0.output_notes().into())
    }

    /// Returns the seven user-defined elements bound by the summary commitment.
    ///
    /// The protocol assigns no meaning to these elements. A caller that uses some of them as a
    /// salt for replay protection reads back what it wrote.
    #[js_export(js_name = "userParams")]
    pub fn user_params(&self) -> Vec<Felt> {
        self.0.user_params().as_elements().iter().map(Into::into).collect()
    }

    /// Returns the commitment of the reference block this summary was built against.
    ///
    /// Signed into the summary, so a co-signer can check a received [`ChainAnchor`] against it
    /// directly: `anchor.commitment()` must equal this. Cheaper than re-deriving the summary.
    ///
    /// It proves the anchor and the summary agree, not that either is what you meant to sign —
    /// a proposer supplies both. Inspect the summary's effects before signing.
    ///
    /// [`ChainAnchor`]: crate::models::chain_anchor::ChainAnchor
    #[js_export(js_name = "blockCommitment")]
    pub fn block_commitment(&self) -> Word {
        self.0.block_commitment().into()
    }

    /// Returns the number of blocks after the reference block within which the transaction
    /// must be included.
    ///
    /// Returns 0 when no expiration was set, meaning the transaction never expires — not that it
    /// expires immediately. Treat a deadline as `blockNum() + delta` only when `delta != 0`.
    #[js_export(js_name = "expirationDelta")]
    pub fn expiration_delta(&self) -> u16 {
        self.0.expiration_delta()
    }

    /// Computes the commitment to this `TransactionSummary`.
    #[js_export(js_name = "toCommitment")]
    pub fn to_commitment(&self) -> Word {
        self.0.to_commitment().into()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<TransactionSummary> for NativeTransactionSummary {
    fn from(transaction_summary: TransactionSummary) -> Self {
        transaction_summary.0
    }
}

impl From<&TransactionSummary> for NativeTransactionSummary {
    fn from(transaction_summary: &TransactionSummary) -> Self {
        transaction_summary.0.clone()
    }
}

impl From<NativeTransactionSummary> for TransactionSummary {
    fn from(transaction_summary: NativeTransactionSummary) -> Self {
        TransactionSummary(transaction_summary)
    }
}

impl From<&NativeTransactionSummary> for TransactionSummary {
    fn from(transaction_summary: &NativeTransactionSummary) -> Self {
        TransactionSummary(transaction_summary.clone())
    }
}

impl_napi_from_value!(TransactionSummary);
