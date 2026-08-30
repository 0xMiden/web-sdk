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
use crate::models::fee_conversion_info::FeeConversionInfo;
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
use crate::platform::{JsErr, from_str_err_with_code};

/// A builder for a `TransactionRequest`.
///
/// Use this builder to construct a `TransactionRequest` by adding input notes, specifying
/// scripts, and setting other transaction parameters.
#[derive(Clone)]
#[js_export]
pub struct TransactionRequestBuilder {
    builder: NativeTransactionRequestBuilder,
    /// Whether the builder currently commits fee conversion info in its auth arg.
    ///
    /// Tracked here rather than read back from `builder` for two reasons: the native builder
    /// exposes no getter for its own declaration, and `auth_arg` clears that declaration as a side
    /// effect, so by the time a request is built the overwrite is no longer observable on it.
    declares_fee_conversion_info: bool,
    /// Whether `withAuthArg` replaced a fee-conversion commitment, leaving its preimage in the
    /// advice map keyed by a word nothing will look up. `build` refuses such a builder.
    fee_conversion_info_auth_arg_overwritten: bool,
}

// Internal methods accessible from Rust code (not processed by napi/wasm_bindgen).
impl TransactionRequestBuilder {
    /// Creates a new empty transaction request builder (internal Rust access).
    pub(crate) fn new() -> TransactionRequestBuilder {
        TransactionRequestBuilder::from_native(NativeTransactionRequestBuilder::new(), false)
    }

    /// Wraps a builder assembled in Rust.
    ///
    /// `declares_fee_conversion_info` states whether that builder already commits fee conversion
    /// info, which is what lets a later `withAuthArg` be recognised as overwriting the commitment.
    /// There is deliberately no `From<NativeTransactionRequestBuilder>` impl: the answer cannot be
    /// recovered from the builder, so every wrapping site has to supply it.
    pub(crate) fn from_native(
        builder: NativeTransactionRequestBuilder,
        declares_fee_conversion_info: bool,
    ) -> TransactionRequestBuilder {
        TransactionRequestBuilder {
            builder,
            declares_fee_conversion_info,
            fee_conversion_info_auth_arg_overwritten: false,
        }
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

    /// Adds an authentication argument.
    ///
    /// Mutually exclusive with `withFeeConversionInfo`, which commits to the same slot: calling
    /// this afterwards replaces the commitment while leaving its preimage in the advice map keyed
    /// by the old one. `fee::load_conversion_info` looks the preimage up by the *current* auth arg,
    /// finds nothing, and `pay_fee` aborts in the VM with `ERR_FEE_CONVERSION_INFO_MISSING`.
    /// `build` refuses that combination with error code
    /// `FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN` instead. Build one request per auth argument.
    ///
    /// The other order is fine: `withFeeConversionInfo` writes both the commitment and its
    /// preimage, so calling it last wins outright.
    #[js_export(js_name = "withAuthArg")]
    pub fn with_auth_arg(&mut self, auth_arg: &Word) -> Self {
        let native_word: NativeWord = auth_arg.into();
        self.builder = self.builder.clone().auth_arg(native_word);
        // Recorded here because the native `auth_arg` also clears its own fee-conversion
        // declaration, so nothing downstream can tell the commitment was ever present.
        if self.declares_fee_conversion_info {
            self.declares_fee_conversion_info = false;
            self.fee_conversion_info_auth_arg_overwritten = true;
        }
        self.clone()
    }

    /// Commits fee conversion info to the transaction's auth args.
    ///
    /// Since protocol 0.16 a signature-authenticated transaction pays its fee inside the auth
    /// procedure, and `fee::pay_fee` requires `AUTH_ARGS` to be the commitment
    /// `hash(CONVERSION_INFO || SALT)` with the preimage reachable in the advice map. Without it
    /// the transaction aborts with `ERR_FEE_CONVERSION_INFO_MISSING` on any chain whose
    /// `verificationBaseFee` is non-zero.
    ///
    /// The salt is the caller's: for a multisig flow it doubles as the summary's replay guard, so
    /// this deliberately takes it rather than generating one.
    ///
    /// Only meaningful for an account whose auth component is one of the standard ones that reads
    /// the auth args as conversion info — single-sig, multisig, or guarded multisig. An account
    /// carrying a custom auth procedure cannot be classified by miden-client, which is what
    /// validates the declaration, so executing such a request fails with error code
    /// `FEE_CONVERSION_INFO_UNCLASSIFIABLE`; use `TransactionRequest.withAuthArg` to attach a
    /// self-computed commitment without the declaration instead.
    ///
    /// Mutually exclusive with `withAuthArg` — see the note there.
    #[js_export(js_name = "withFeeConversionInfo")]
    pub fn with_fee_conversion_info(
        &mut self,
        conversion_info: &FeeConversionInfo,
        salt: &Word,
    ) -> Self {
        let native_salt: NativeWord = salt.into();
        self.builder =
            self.builder.clone().fee_conversion_info(conversion_info.into(), native_salt);
        self.declares_fee_conversion_info = true;
        // This writes the commitment and its preimage together, so it clears any earlier overwrite.
        self.fee_conversion_info_auth_arg_overwritten = false;
        self.clone()
    }

    /// Finalizes the builder into a `TransactionRequest`.
    ///
    /// # Errors
    ///
    /// Fails with code `FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN` when `withAuthArg` was called
    /// after `withFeeConversionInfo`, which leaves the request unable to pay its fee. Refused here
    /// rather than at execution because the native builder drops its own record of the
    /// declaration, so this is the last point at which the mistake is still visible.
    pub fn build(&self) -> Result<TransactionRequest, JsErr> {
        if self.fee_conversion_info_auth_arg_overwritten {
            return Err(from_str_err_with_code(
                "this builder committed fee conversion info and then had its auth argument \
                 replaced by `withAuthArg`, which leaves the commitment's preimage in the advice \
                 map keyed by a word nothing looks up. Executing the result would abort in the VM \
                 with ERR_FEE_CONVERSION_INFO_MISSING. The two are mutually exclusive — build one \
                 request per auth argument, or call `withFeeConversionInfo` last.",
                "FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN",
            ));
        }

        self.builder
            .clone()
            .build()
            .map(TransactionRequest)
            .map_err(|err| js_error_with_context(err, "failed to build transaction request"))
    }
}

// CONVERSIONS
// ================================================================================================

// Deliberately no `From<TransactionRequestBuilder> for NativeTransactionRequestBuilder`: it would
// hand out the inner builder without `build`'s `FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN` check,
// and the native builder no longer records the declaration that check is derived from. `build` is
// the only finalizing path for that reason.

impl Default for TransactionRequestBuilder {
    fn default() -> Self {
        Self::new()
    }
}
