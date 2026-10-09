use js_export_macro::js_export;
use miden_client::crypto::MerklePath as NativeMerklePath;
#[cfg(feature = "testing")]
use miden_client::crypto::SparseMerklePath;
use miden_client::note::NoteInclusionProof as NativeNoteInclusionProof;

use super::merkle_path::MerklePath;
use super::note_location::NoteLocation;
#[cfg(feature = "testing")]
use crate::platform::{JsErr, from_str_err};

/// Contains the data required to prove inclusion of a note in the canonical chain.
#[derive(Clone)]
#[js_export]
pub struct NoteInclusionProof(NativeNoteInclusionProof);

#[js_export]
impl NoteInclusionProof {
    /// Returns the location of the note within the tree.
    pub fn location(&self) -> NoteLocation {
        self.0.location().into()
    }

    /// Returns the Merkle authentication path for the note.
    #[js_export(js_name = "notePath")]
    pub fn note_path(&self) -> MerklePath {
        NativeMerklePath::from(self.0.note_path().clone()).into()
    }

    /// Build a proof whose location block is `block_num` and whose path is empty.
    ///
    /// The mock note transport records that block and does not authenticate the path. A real
    /// node rejects the proof. The published package is built with the `testing` feature, so
    /// this constructor is present there; it is not a way to produce a proof a node accepts.
    #[cfg(feature = "testing")]
    #[js_export(js_name = "mockAtBlock")]
    pub fn mock_at_block(block_num: u32) -> Result<NoteInclusionProof, JsErr> {
        let path = SparseMerklePath::from_parts(0, Vec::new())
            .expect("an empty node list with an empty mask is a depth-0 path");
        let native = NativeNoteInclusionProof::new(block_num.into(), 0, path).map_err(|err| {
            from_str_err(&format!("failed to build a mock inclusion proof: {err}"))
        })?;
        Ok(native.into())
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNoteInclusionProof> for NoteInclusionProof {
    fn from(native_proof: NativeNoteInclusionProof) -> Self {
        NoteInclusionProof(native_proof)
    }
}

impl From<&NativeNoteInclusionProof> for NoteInclusionProof {
    fn from(native_proof: &NativeNoteInclusionProof) -> Self {
        NoteInclusionProof(native_proof.clone())
    }
}
impl From<NoteInclusionProof> for NativeNoteInclusionProof {
    fn from(proof: NoteInclusionProof) -> Self {
        proof.0
    }
}

impl_napi_from_value!(NoteInclusionProof);
