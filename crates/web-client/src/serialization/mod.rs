//! Byte encodings of the values that the bindings hand to JavaScript.
//!
//! The helpers here wrap the `miden-client-proto` messages, the `miden-objects` messages and the
//! native `Serializable` encoding. The submodules hold the protobuf messages that this crate owns,
//! for the values that neither the protocol nor `miden-client-proto` encodes.

use miden_client_proto::ProtobufValue;
use miden_objects::{DecodeMessageExt, Verify};
use miden_protocol::utils::serde::{Deserializable, Serializable, SliceReader};
use prost::Message;

use crate::js_error_with_context;
use crate::platform::{JsBytes, JsErr, bytes_to_js};

pub mod summary;
pub mod transaction;

/// Encodes a value as its protobuf message, into the platform byte type.
pub fn encode_proto<T: ProtobufValue>(value: &T) -> JsBytes {
    bytes_to_js(&miden_client_proto::encode(value))
}

/// Decodes platform bytes that hold the protobuf message of `T`, with all the checks of `T`.
pub fn decode_proto<T: ProtobufValue>(bytes: &JsBytes) -> Result<T, JsErr> {
    let vec = crate::platform::js_to_bytes(bytes);
    let context = alloc::format!("failed to deserialize {}", core::any::type_name::<T>());
    miden_client_proto::decode(&vec).map_err(|e| js_error_with_context(e, &context))
}

/// Encodes a `miden-objects` protobuf message, the canonical encoding of a protocol value, into the
/// platform byte type.
pub fn encode_message<M: Message>(message: &M) -> JsBytes {
    bytes_to_js(&message.encode_to_vec())
}

/// Decodes platform bytes that hold the `miden-objects` protobuf message `M`, with all the checks
/// of the protocol value the message carries.
pub fn decode_message<M>(bytes: &JsBytes) -> Result<<M::Decoded as Verify>::Verified, JsErr>
where
    M: Message + Default + DecodeMessageExt,
    M::Decoded: Verify,
{
    let vec = crate::platform::js_to_bytes(bytes);
    let context = alloc::format!(
        "failed to deserialize {}",
        core::any::type_name::<<M::Decoded as Verify>::Verified>()
    );
    let message = M::decode(vec.as_slice()).map_err(|e| js_error_with_context(e, &context))?;
    message.decode_and_verify().map_err(|e| js_error_with_context(e, &context))
}

/// Serializes any value that implements `Serializable` into the platform byte type.
pub fn serialize_to_bytes<T: Serializable>(value: &T) -> JsBytes {
    let mut buffer = Vec::new();
    value.write_into(&mut buffer);
    bytes_to_js(&buffer)
}

/// Deserializes platform bytes into any type that implements `Deserializable`.
pub fn deserialize_from_bytes<T: Deserializable>(bytes: &JsBytes) -> Result<T, JsErr> {
    let vec = crate::platform::js_to_bytes(bytes);
    let mut reader = SliceReader::new(&vec);
    let context = alloc::format!("failed to deserialize {}", core::any::type_name::<T>());
    T::read_from(&mut reader).map_err(|e| js_error_with_context(e, &context))
}

#[cfg(all(test, feature = "browser"))]
mod tests {
    use miden_protocol::utils::serde::{ByteReader, DeserializationError};

    use super::*;

    #[derive(Debug)]
    struct MockFailureType;

    impl Deserializable for MockFailureType {
        fn read_from<R: ByteReader>(_source: &mut R) -> Result<Self, DeserializationError> {
            Err(DeserializationError::InvalidValue("mock error".to_string()))
        }
    }

    #[test]
    fn deserialize_from_bytes_failure_with_type_context() {
        use wasm_bindgen_futures::js_sys::Uint8Array;

        let uint8_array = Uint8Array::new_with_length(10);
        let result = deserialize_from_bytes::<MockFailureType>(&uint8_array);

        assert!(result.is_err());
        let error = result.unwrap_err();
        let error_string = error.as_string().unwrap();
        assert!(error_string.contains("MockFailureType"));
        assert!(error_string.contains("failed to deserialize"));
        assert!(error_string.contains("mock error"));
    }
}
