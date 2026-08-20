use miden_client::SliceReader;
use miden_client::utils::{ByteReader, Deserializable, Serializable};

use crate::js_error_with_context;
use crate::platform::{JsBytes, JsErr, bytes_to_js, from_str_err};

#[cfg(all(feature = "testing", feature = "browser"))]
pub mod test_utils;

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

/// Deserializes platform bytes that came from an untrusted party.
///
/// Differs from [`deserialize_from_bytes`] by rejecting trailing bytes, which keeps the encoding
/// canonical on read. That matters for a type whose serialized form is a transport blob rather
/// than local persistence: otherwise unboundedly many byte strings decode to the same value, and
/// anyone treating the blob as a cache or dedup key gets a false distinction.
///
/// Deliberately does NOT use `read_from_bytes_with_budget`. A budget bounds a collection's claimed
/// length by `remaining / min_serialized_size()`, and that default is `size_of::<Self>()` — larger
/// than the on-wire size for every type in a `ChainAnchor`, because `BlockHeader` omits its derived
/// commitments from the encoding. Any budget tied to the input length therefore rejects legitimate
/// anchors that track even one block. Allocation is bounded instead by the reader itself:
/// collection reads stream through `read_many_iter().collect()`, which reserves nothing up front,
/// so a forged length prefix cannot allocate beyond the bytes actually present.
pub fn deserialize_untrusted_bytes<T: Deserializable>(bytes: &JsBytes) -> Result<T, JsErr> {
    let vec = crate::platform::js_to_bytes(bytes);
    let context = alloc::format!("failed to deserialize {}", core::any::type_name::<T>());
    let mut reader = SliceReader::new(&vec);
    let value = T::read_from(&mut reader).map_err(|e| js_error_with_context(e, &context))?;
    if reader.has_more_bytes() {
        return Err(from_str_err(&alloc::format!(
            "{context}: trailing bytes after a complete value"
        )));
    }
    Ok(value)
}

#[cfg(all(test, feature = "browser"))]
mod tests {
    use miden_client::utils::{ByteReader, DeserializationError};

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
