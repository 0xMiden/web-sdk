use js_export_macro::js_export;
use miden_protocol::crypto::merkle::InnerNodeInfo as NativeInnerNodeInfo;

use super::word::Word;

/// An inner node of a Merkle tree: its `value` and the `left` and `right` children it hashes.
/// `value` must be the Poseidon2 merge of `left` and `right`; the Merkle store indexes the node
/// by `value` without checking.
#[derive(Clone)]
#[js_export]
pub struct InnerNodeInfo(NativeInnerNodeInfo);

#[js_export]
impl InnerNodeInfo {
    /// Creates an inner node from its value and its two children.
    #[js_export(constructor)]
    pub fn new(value: &Word, left: &Word, right: &Word) -> InnerNodeInfo {
        InnerNodeInfo(NativeInnerNodeInfo {
            value: value.into(),
            left: left.into(),
            right: right.into(),
        })
    }

    /// Returns the node's value.
    pub fn value(&self) -> Word {
        self.0.value.into()
    }

    /// Returns the left child.
    pub fn left(&self) -> Word {
        self.0.left.into()
    }

    /// Returns the right child.
    pub fn right(&self) -> Word {
        self.0.right.into()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeInnerNodeInfo> for InnerNodeInfo {
    fn from(native_node: NativeInnerNodeInfo) -> Self {
        InnerNodeInfo(native_node)
    }
}

impl From<InnerNodeInfo> for NativeInnerNodeInfo {
    fn from(node: InnerNodeInfo) -> Self {
        node.0
    }
}

impl_napi_from_value!(InnerNodeInfo);
