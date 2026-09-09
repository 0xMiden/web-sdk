use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::note::{
    Note as NativeNote,
    NoteDetails as NativeNoteDetails,
    NoteRecipient as NativeNoteRecipient,
    NoteTag as NativeNoteTag,
};
use miden_client::transaction::{
    ForeignAccount as NativeForeignAccount,
    NoteArgs as NativeNoteArgs,
    TransactionRequestBuilder as NativeTransactionRequestBuilder,
    TransactionScript as NativeTransactionScript,
};
use miden_client::vm::AdviceMap as NativeAdviceMap;

use crate::js_error_with_context;
use crate::models::advice_map::AdviceMap;
use crate::models::foreign_account::ForeignAccount;
use crate::models::miden_arrays::{
    ForeignAccountArray,
    NoteAndArgsArray,
    NoteArray,
    NoteDetailsAndTagArray,
    NoteRecipientArray,
};
use crate::models::note_recipient::NoteRecipient;
use crate::models::transaction_request::TransactionRequest;
use crate::models::transaction_request::note_and_args::NoteAndArgs;
use crate::models::transaction_request::note_details_and_tag::NoteDetailsAndTag;
use crate::models::transaction_script::TransactionScript;
use crate::models::word::Word;
use crate::platform::JsErr;

/// A builder for a `TransactionRequest`.
///
/// Use this builder to construct a `TransactionRequest` by adding input notes, specifying
/// scripts, and setting other transaction parameters.
#[derive(Clone)]
#[js_export]
pub struct TransactionRequestBuilder {
    builder: NativeTransactionRequestBuilder,
}

// Internal methods accessible from Rust code (not processed by napi/wasm_bindgen).
impl TransactionRequestBuilder {
    /// Creates a new empty transaction request builder (internal Rust access).
    pub(crate) fn new() -> TransactionRequestBuilder {
        TransactionRequestBuilder::from_native(NativeTransactionRequestBuilder::new())
    }

    /// Wraps a builder assembled in Rust.
    pub(crate) fn from_native(
        builder: NativeTransactionRequestBuilder,
    ) -> TransactionRequestBuilder {
        TransactionRequestBuilder { builder }
    }
}

#[js_export]
impl TransactionRequestBuilder {
    /// Creates a new empty transaction request builder.
    #[js_export(constructor)]
    pub fn js_new() -> TransactionRequestBuilder {
        TransactionRequestBuilder::new()
    }

    /// Adds input notes with optional arguments.
    #[js_export(js_name = "withInputNotes")]
    pub fn with_input_notes(&mut self, notes: NoteAndArgsArray) -> Self {
        let items: Vec<NoteAndArgs> = notes.into();
        let native_note_and_note_args: Vec<(NativeNote, Option<NativeNoteArgs>)> =
            items.into_iter().map(Into::into).collect();
        self.builder = self.builder.clone().input_notes(native_note_and_note_args);
        self.clone()
    }

    /// Adds output notes created by the sender that should be emitted by the transaction.
    #[js_export(js_name = "withOwnOutputNotes")]
    pub fn with_own_output_notes(&mut self, notes: NoteArray) -> Self {
        let native_notes: Vec<NativeNote> = notes.into();
        self.builder = self.builder.clone().own_output_notes(native_notes);
        self.clone()
    }

    /// Attaches a custom transaction script.
    #[js_export(js_name = "withCustomScript")]
    pub fn with_custom_script(&mut self, script: &TransactionScript) -> Self {
        let native_script: NativeTransactionScript = script.into();
        self.builder = self.builder.clone().custom_script(native_script);
        self.clone()
    }

    /// Sets the maximum number of blocks until the transaction request expires.
    #[js_export(js_name = "withExpirationDelta")]
    pub fn with_expiration_delta(&mut self, expiration_delta: u16) -> Self {
        self.builder = self.builder.clone().expiration_delta(expiration_delta);
        self.clone()
    }

    /// Declares expected output recipients (used for verification).
    #[js_export(js_name = "withExpectedOutputRecipients")]
    pub fn with_expected_output_notes(&mut self, recipients: NoteRecipientArray) -> Self {
        let items: Vec<NoteRecipient> = recipients.into();
        let native_recipients: Vec<NativeNoteRecipient> =
            items.into_iter().map(NativeNoteRecipient::from).collect();
        self.builder = self.builder.clone().expected_output_recipients(native_recipients);
        self.clone()
    }

    /// Declares notes expected to be created in follow-up executions.
    #[js_export(js_name = "withExpectedFutureNotes")]
    pub fn with_expected_future_notes(
        &mut self,
        note_details_and_tag: NoteDetailsAndTagArray,
    ) -> Self {
        let items: Vec<NoteDetailsAndTag> = note_details_and_tag.into();
        let native_note_details_and_tag: Vec<(NativeNoteDetails, NativeNoteTag)> =
            items.into_iter().map(Into::into).collect();
        self.builder = self.builder.clone().expected_future_notes(native_note_details_and_tag);
        self.clone()
    }

    /// Merges an advice map to be available during script execution.
    #[js_export(js_name = "extendAdviceMap")]
    pub fn extend_advice_map(&mut self, advice_map: &AdviceMap) -> Self {
        let native_advice_map: NativeAdviceMap = advice_map.into();
        self.builder = self.builder.clone().extend_advice_map(native_advice_map);
        self.clone()
    }

    /// Registers foreign accounts referenced by the transaction.
    #[js_export(js_name = "withForeignAccounts")]
    pub fn with_foreign_accounts(&mut self, foreign_accounts: ForeignAccountArray) -> Self {
        let items: Vec<ForeignAccount> = foreign_accounts.into();
        let native_foreign_accounts: Vec<NativeForeignAccount> =
            items.into_iter().map(Into::into).collect();
        self.builder = self.builder.clone().foreign_accounts(native_foreign_accounts);
        self.clone()
    }

    /// Adds a transaction script argument.
    #[js_export(js_name = "withScriptArg")]
    pub fn with_script_arg(&mut self, script_arg: &Word) -> Self {
        let native_word: NativeWord = script_arg.into();
        self.builder = self.builder.clone().script_arg(native_word);
        self.clone()
    }

    /// Adds an authentication argument: a `Word` pushed to the stack for the account's
    /// authentication procedure.
    ///
    /// Mutually exclusive with `withFeeConversionSalt`, and the exclusion is enforced by
    /// miden-client rather than reported as an error: each setter clears the other, so whichever
    /// is called last wins and the request can never carry both.
    ///
    /// Setting this opts the request out of the client's fee-conversion machinery entirely. The
    /// client commits conversion info only when the request carries no auth argument of its own,
    /// so a caller that sets one is taking responsibility for the fee: on a fee-charging chain
    /// the word has to be the commitment `hash(CONVERSION_INFO || SALT)`, with its preimage
    /// reachable through `extendAdviceMap`, or `fee::pay_fee` aborts in the VM with
    /// `ERR_FEE_CONVERSION_INFO_MISSING`. This is the escape hatch for an account whose auth
    /// component miden-client does not recognise and therefore will not commit for; where the
    /// account is a standard one, prefer `withFeeConversionSalt` or nothing at all.
    #[js_export(js_name = "withAuthArg")]
    pub fn with_auth_arg(&mut self, auth_arg: &Word) -> Self {
        let native_word: NativeWord = auth_arg.into();
        self.builder = self.builder.clone().auth_arg(native_word);
        self.clone()
    }

    /// Declares the salt the transaction's fee conversion info is committed under.
    ///
    /// Fees are always settled in the chain's native fee asset at rate 1/1, so there is no
    /// conversion info to supply — only, optionally, the salt it is committed under. The client
    /// builds the info and commits it through the auth args itself while preparing the
    /// transaction.
    ///
    /// Needed only where the account's auth component reuses that salt as a replay guard, which
    /// is every multisig flavour (`AuthMultisig`, `AuthMultisigSmart`, `AuthGuardedMultisig`):
    /// there the client refuses to guess and execution fails with `FeeConversionInfoRequired`
    /// naming the component. A single-sig account needs nothing — the client commits under a
    /// fixed default salt, deliberately fixed so the signed transaction summary is reproducible.
    /// Declaring a salt against an account whose auth component does not read the auth args as
    /// conversion info is refused with `FeeConversionInfoUnsupported`.
    ///
    /// Mutually exclusive with `withAuthArg` — see the note there.
    #[js_export(js_name = "withFeeConversionSalt")]
    pub fn with_fee_conversion_salt(&mut self, salt: &Word) -> Self {
        let native_salt: NativeWord = salt.into();
        self.builder = self.builder.clone().fee_conversion_salt(native_salt);
        self.clone()
    }

    /// Finalizes the builder into a `TransactionRequest`.
    pub fn build(&self) -> Result<TransactionRequest, JsErr> {
        self.builder
            .clone()
            .build()
            .map(TransactionRequest)
            .map_err(|err| js_error_with_context(err, "failed to build transaction request"))
    }
}

// CONVERSIONS
// ================================================================================================

impl Default for TransactionRequestBuilder {
    fn default() -> Self {
        Self::new()
    }
}
