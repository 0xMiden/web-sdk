use js_export_macro::js_export;
use miden_client::Felt as NativeFelt;
use miden_protocol::crypto::hash::eidos::Eidos as NativeEidos;

use super::felt::Felt;
use super::word::Word;
use crate::models::miden_arrays::FeltArray;

/// Eidos hashing helpers exposed to JavaScript.
#[js_export]
#[derive(Copy, Clone)]
pub struct Eidos;

#[js_export]
impl Eidos {
    /// Computes an Eidos digest from the provided field elements.
    #[js_export(js_name = "hashElements")]
    pub fn hash_elements(felt_array: FeltArray) -> Word {
        let felts: Vec<Felt> = felt_array.into();
        let native_felts: Vec<NativeFelt> = felts.iter().map(Into::into).collect();

        let native_digest = NativeEidos::hash_elements(&native_felts);

        native_digest.into()
    }

    /// Computes the Merkle inner node of `left` and `right`.
    ///
    /// This is the value an `InnerNodeInfo` must carry. It differs from `hashElements` over the
    /// eight elements of `left` and `right`.
    pub fn merge(left: &Word, right: &Word) -> Word {
        NativeEidos::merge(&[left.into(), right.into()]).into()
    }
}
