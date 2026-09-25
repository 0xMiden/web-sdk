use alloc::sync::Arc;

use js_export_macro::js_export;
use miden_client::account::standards::auth::Eip712TransactionSummary;
use miden_client::auth::{PublicKey as NativePublicKey, Signature as NativeSignature};
use miden_client::transaction::TransactionSummary as NativeTransactionSummary;
use miden_client::vm::AdviceMap as NativeAdviceMap;

use super::account_delta::AccountDelta;
use super::felt::Felt;
use super::input_notes::InputNotes;
use super::output_notes::OutputNotes;
use super::public_key::PublicKey;
use super::signature::Signature;
use super::word::Word;
use crate::models::advice_map::AdviceMap;
use crate::platform::{JsBytes, JsErr, bytes_to_js, from_str_err};
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
    ///
    /// NOTE: this includes the kernel's `TX_FEE` note on any chain whose `verification_base_fee` is
    /// non-zero. Every standard auth procedure calls `fee::pay_fee` before building the summary, so
    /// the fee note is inside what a co-signer signs over — which is the point, but it means a UI
    /// rendering this list for confirmation shows the fee note alongside the notes the user asked
    /// for, and should label it rather than present it as one of theirs.
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

    /// Returns the EIP-712 digest signed by an Ethereum-compatible wallet.
    #[js_export(js_name = "eip712Hash")]
    pub fn eip712_hash(&self) -> JsBytes {
        bytes_to_js(self.0.eip712_hash().as_bytes())
    }

    /// Returns the domain-separated advice-map key for an ECDSA approver.
    #[js_export(js_name = "eip712SignatureKey")]
    pub fn eip712_signature_key(&self, public_key: &PublicKey) -> Result<Word, JsErr> {
        match &public_key.0 {
            NativePublicKey::EcdsaK256Keccak(key) => {
                Ok(self.0.eip712_signature_key(key.to_commitment().into()).into())
            },
            _ => Err(from_str_err("EIP-712 requires an ECDSA public key")),
        }
    }

    /// Returns the advice-map entry for an ECDSA signature over `eip712Hash()`.
    #[js_export(js_name = "eip712SignatureAdvice")]
    pub fn eip712_signature_advice(
        &self,
        public_key: &PublicKey,
        signature: &Signature,
    ) -> Result<AdviceMap, JsErr> {
        let native_signature: NativeSignature = signature.into();
        match (&public_key.0, native_signature) {
            (NativePublicKey::EcdsaK256Keccak(key), NativeSignature::EcdsaK256Keccak(sig)) => {
                let (advice_key, witness) = self.0.eip712_signature_advice(key, &sig);
                let mut advice_map = NativeAdviceMap::default();
                advice_map.insert(advice_key, Arc::from(witness));
                Ok(advice_map.into())
            },
            _ => Err(from_str_err("EIP-712 requires an ECDSA public key and signature")),
        }
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
