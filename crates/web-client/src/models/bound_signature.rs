use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::auth::{
    BoundSignature as NativeBoundSignature,
    PublicKeyCommitment,
    SignatureKey,
};

use super::felt::Felt;
use super::signature::Signature;
use super::word::Word;
use crate::js_error_with_context;
use crate::platform::JsErr;

/// A cryptographic signature bound to the public-key commitment and message it signs.
#[derive(Clone)]
#[js_export]
pub struct BoundSignature(NativeBoundSignature);

#[js_export]
impl BoundSignature {
    /// Binds `signature` to `pub_key_commitment` and `message`.
    ///
    /// Fails if the signer key cannot be recovered from an ECDSA signature or if its commitment
    /// does not match `pub_key_commitment`.
    #[js_export(constructor)]
    pub fn new(
        pub_key_commitment: &Word,
        message: &Word,
        signature: &Signature,
    ) -> Result<BoundSignature, JsErr> {
        let key = SignatureKey::new(
            PublicKeyCommitment::from(NativeWord::from(pub_key_commitment)),
            message.into(),
        );
        NativeBoundSignature::new(key, signature.into())
            .map(BoundSignature)
            .map_err(|err| js_error_with_context(err, "failed to bind signature"))
    }

    /// Returns the commitment to the signer's public key.
    #[js_export(js_name = "pubKeyCommitment")]
    pub fn pub_key_commitment(&self) -> Word {
        NativeWord::from(self.0.key().pub_key_commitment()).into()
    }

    /// Returns the message word bound to this signature.
    pub fn message(&self) -> Word {
        self.0.key().message().into()
    }

    /// Returns the underlying signature.
    pub fn signature(&self) -> Signature {
        self.0.signature().clone().into()
    }

    /// Returns the advice-map key under which the transaction kernel looks up this signature.
    #[js_export(js_name = "toAdviceMapKey")]
    pub fn to_advice_map_key(&self) -> Word {
        self.0.key().to_advice_map_key().into()
    }

    /// Encodes the bound signature as field elements in the format expected by the VM.
    #[js_export(js_name = "toEncodedSignature")]
    pub fn to_encoded_signature(&self) -> Vec<Felt> {
        self.0.to_encoded_signature().into_iter().map(Into::into).collect()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<&NativeBoundSignature> for BoundSignature {
    fn from(bound: &NativeBoundSignature) -> Self {
        BoundSignature(bound.clone())
    }
}

impl_napi_from_value!(BoundSignature);
