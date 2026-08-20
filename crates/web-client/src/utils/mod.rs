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
/// Differs from [`deserialize_from_bytes`] by rejecting bytes left over after a complete value.
/// That matters for a type whose serialized form is a transport blob rather than local
/// persistence, since anyone treating the blob as a cache or dedup key would otherwise get a
/// false distinction between a value and the same value with a suffix.
///
/// It rejects suffixes, not every non-canonical encoding: a non-minimal length prefix is consumed
/// by the reader and still decodes. Catching that as well would mean re-encoding the decoded value
/// and comparing, a full second serialization of the partial blockchain on a path the worker runs
/// for every anchored execution — too much for a dedup-key edge case that cannot change the value.
///
/// Deliberately does NOT use `read_from_bytes_with_budget`. A budget bounds a collection's claimed
/// length by `remaining / min_serialized_size()`. The collection types override that to 1, but
/// `BlockHeader` does not, so it inherits the `size_of::<Self>()` default — larger than its
/// on-wire size, because it omits its derived commitments from the encoding. Any budget tied to
/// the input length therefore rejects legitimate anchors that track even one block. Allocation is
/// bounded instead by how collections decode: `Vec` collects an iterator of `Result`, whose lower
/// size hint is zero and so reserves nothing up front, and the map types loop without reserving.
/// A forged length prefix cannot allocate beyond the bytes actually present.
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
