use js_export_macro::js_export;
use miden_client::note::{
    NetworkAccountTarget as NativeNetworkAccountTarget,
    NoteAttachment as NativeNoteAttachment,
    NoteExecutionHint as NativeNoteExecutionHint,
};

use super::account_id::AccountId;
use super::note_attachment::NoteAttachment;
use super::note_execution_hint::NoteExecutionHint;
use crate::js_error_with_context;
use crate::platform::JsErr;

/// Targets a note at a public network account so the operator auto-consumes it.
///
/// A note is a network note when it is `Public` and carries a valid
/// `NetworkAccountTarget` attachment (see `Note.isNetworkNote`).
#[derive(Clone, Copy)]
#[js_export]
pub struct NetworkAccountTarget(NativeNetworkAccountTarget);

#[js_export]
impl NetworkAccountTarget {
    /// Creates a target for the given network account. `executionHint` defaults
    /// to `NoteExecutionHint.always()`.
    ///
    /// # Errors
    /// Errors if `account_id` is not a public account.
    #[js_export(constructor)]
    pub fn new(
        account_id: &AccountId,
        execution_hint: Option<NoteExecutionHint>,
    ) -> Result<NetworkAccountTarget, JsErr> {
        let hint: NativeNoteExecutionHint =
            execution_hint.map_or(NativeNoteExecutionHint::Always, Into::into);
        NativeNetworkAccountTarget::new(account_id.into(), hint)
            .map(NetworkAccountTarget)
            .map_err(|err| js_error_with_context(err, "create network account target"))
    }

    /// Encodes this target as a `NoteAttachment`.
    #[js_export(js_name = "toAttachment")]
    pub fn to_attachment(&self) -> NoteAttachment {
        let native: NativeNoteAttachment = self.0.into();
        native.into()
    }

    /// Decodes a `NoteAttachment` back into a `NetworkAccountTarget`.
    ///
    /// # Errors
    /// Errors if the attachment is not a valid network-account-target attachment.
    #[js_export(js_name = "fromAttachment")]
    pub fn from_attachment(attachment: &NoteAttachment) -> Result<NetworkAccountTarget, JsErr> {
        let native: NativeNoteAttachment = attachment.into();
        NativeNetworkAccountTarget::try_from(&native)
            .map(NetworkAccountTarget)
            .map_err(|err| js_error_with_context(err, "decode network account target"))
    }

    /// Returns the targeted network account id.
    #[js_export(js_name = "targetId")]
    pub fn target_id(&self) -> AccountId {
        self.0.target_id().into()
    }

    /// Returns the note execution hint.
    #[js_export(js_name = "executionHint")]
    pub fn execution_hint(&self) -> NoteExecutionHint {
        self.0.execution_hint().into()
    }
}

impl From<&NetworkAccountTarget> for NativeNetworkAccountTarget {
    fn from(value: &NetworkAccountTarget) -> Self {
        value.0
    }
}

impl From<NativeNetworkAccountTarget> for NetworkAccountTarget {
    fn from(value: NativeNetworkAccountTarget) -> Self {
        NetworkAccountTarget(value)
    }
}
