use js_export_macro::js_export;
use miden_client::Felt as NativeFelt;
use miden_client::crypto::Hasher as NativeEidos;

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
}
