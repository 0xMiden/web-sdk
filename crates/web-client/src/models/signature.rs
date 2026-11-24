use js_export_macro::js_export;
use miden_client::auth::{
    BoundSignature,
    PublicKeyCommitment,
    Signature as NativeSignature,
    SignatureKey,
};
use miden_protocol::crypto::dsa::ecdsa_k256_keccak;

use crate::js_error_with_context;
use crate::models::felt::Felt;
use crate::models::word::Word;
use crate::platform::{JsBytes, JsErr};
use crate::serialization::{deserialize_from_bytes, serialize_to_bytes};

/// Cryptographic signature produced by supported auth schemes.
#[js_export]
#[derive(Clone)]
pub struct Signature(NativeSignature);

#[js_export]
impl Signature {
    /// Serializes the signature into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes a signature from bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<Signature, JsErr> {
        let native_signature = deserialize_from_bytes::<NativeSignature>(&bytes)?;
        Ok(Signature(native_signature))
    }

    /// Converts the signature to the prepared field elements expected by verifying code.
    ///
    /// Fails if the public key of an ECDSA signature cannot be recovered from the signature and
    /// `message`.
    #[js_export(js_name = "toPreparedSignature")]
    pub fn to_prepared_signature(&self, message: Word) -> Result<Vec<Felt>, JsErr> {
        const CONTEXT: &str = "failed to prepare signature";
        let message = message.into();
        // The encoding needs the public key of the signer. A Falcon signature carries it and an
        // ECDSA signature yields it together with the message.
        let signer: PublicKeyCommitment = match &self.0 {
            NativeSignature::Falcon512Eidos(signature) => {
                signature.public_key().to_commitment().into()
            },
            NativeSignature::EcdsaK256Keccak(signature) => {
                ecdsa_k256_keccak::PublicKey::recover_from(message, signature)
                    .map_err(|err| js_error_with_context(err, CONTEXT))?
                    .into()
            },
        };
        let bound = BoundSignature::new(SignatureKey::new(signer, message), self.0.clone())
            .map_err(|err| js_error_with_context(err, CONTEXT))?;
        Ok(bound.to_encoded_signature().into_iter().map(Into::into).collect())
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeSignature> for Signature {
    fn from(native_signature: NativeSignature) -> Self {
        Signature(native_signature)
    }
}

impl From<&NativeSignature> for Signature {
    fn from(native_signature: &NativeSignature) -> Self {
        Signature(native_signature.clone())
    }
}

impl From<Signature> for NativeSignature {
    fn from(signature: Signature) -> Self {
        signature.0
    }
}

impl From<&Signature> for NativeSignature {
    fn from(signature: &Signature) -> Self {
        signature.0.clone()
    }
}
