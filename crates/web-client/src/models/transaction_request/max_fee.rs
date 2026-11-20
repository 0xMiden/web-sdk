//! Sets a max fee on the multisig auth args of a finished request.
//!
//! The summary of a multisig binds a max fee. Auth args without one make the auth procedure
//! estimate the fee on each execution, so the summary binds the estimate of that execution. The
//! approvers sign a cap instead: the max fee that a summary binds, scaled by a margin.

use alloc::string::{String, ToString};
use core::num::NonZeroU32;

use js_export_macro::js_export;
use miden_client::account::AccountId as NativeAccountId;
use miden_client::account::standards::auth::{FeeConversionInfo, MultisigAuthArgs};
use miden_client::asset::AssetAmount;
use miden_client::block::BlockNumber;
use miden_client::transaction::{
    TransactionRequest as NativeTransactionRequest,
    TransactionSummary as NativeTransactionSummary,
};
use miden_client::{Felt as NativeFelt, Word as NativeWord};
use miden_protocol::crypto::SequentialCommit;
use miden_protocol::errors::AccountError;

use super::TransactionRequest;
use crate::models::transaction_summary::TransactionSummary;
use crate::platform::u64_to_js_u64;

/// The number of elements of multisig auth args: the block word, the salt and the conversion
/// info.
const MULTISIG_AUTH_ARGS_LEN: usize = 12;

/// The index of the approval expiration among the user parameters of a multisig summary.
const APPROVAL_EXPIRATION_USER_PARAM_INDEX: usize = 0;

/// The index of the first salt element among the user parameters of a multisig summary. The max
/// fee sits between the approval expiration and the salt.
const SALT_USER_PARAM_INDEX: usize = 2;

// ERRORS
// ================================================================================================

/// Why a request cannot take a max fee from a summary.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MaxFeeError {
    /// The auth args of the request are not multisig auth args.
    #[error("the request has no multisig auth args: {0}")]
    NotMultisigAuthArgs(String),
    /// The summary was not built from the auth args of the request.
    #[error("the summary does not belong to the request: {0}")]
    SummaryMismatch(String),
    /// The max fee that the summary binds, or the margin, is not valid.
    #[error("failed to scale the max fee")]
    InvalidMaxFee(#[source] AccountError),
}

// ESTIMATED MAX FEE
// ================================================================================================

/// A request whose multisig auth args carry a max fee, and the summary that the approvers sign.
///
/// `TransactionRequest.withEstimatedMaxFee` returns it.
#[js_export]
pub struct EstimatedMaxFee {
    request: TransactionRequest,
    summary: TransactionSummary,
    max_fee: u64,
}

#[js_export]
impl EstimatedMaxFee {
    /// Returns the request whose auth args carry the max fee. Executing it reproduces `summary`.
    pub fn request(&self) -> TransactionRequest {
        self.request.clone()
    }

    /// Returns the summary that binds the max fee. The approvers sign its commitment.
    pub fn summary(&self) -> TransactionSummary {
        self.summary.clone()
    }

    /// Returns the max fee, in the native fee asset. Zero means that the auth procedure estimates
    /// the fee on each execution.
    #[js_export(js_name = "maxFee")]
    pub fn max_fee(&self) -> JsU64 {
        u64_to_js_u64(self.max_fee)
    }
}

impl EstimatedMaxFee {
    /// Scales the max fee that `summary` binds by `fee_margin_percent`, and sets it on the
    /// multisig auth args of `request` and on the summary.
    pub(crate) fn new(
        request: &NativeTransactionRequest,
        summary: &NativeTransactionSummary,
        fee_margin_percent: u32,
    ) -> Result<Self, MaxFeeError> {
        let auth_args = multisig_auth_args(request)?;
        check_summary(&auth_args, summary)?;

        let (auth_args, summary) = auth_args
            .with_estimated_max_fee(summary, fee_margin_percent)
            .map_err(MaxFeeError::InvalidMaxFee)?;

        Ok(Self {
            request: request.clone().with_auth_args(&auth_args).into(),
            summary: summary.into(),
            max_fee: auth_args.max_fee().as_u64(),
        })
    }
}

// HELPERS
// ================================================================================================

/// Reads the multisig auth args of `request` from the preimage of its auth argument.
///
/// The auth args have no decoding of their own, so this rebuilds them from the elements and
/// checks that they encode to the same elements. A preimage that another auth component defines
/// is refused, also when it has the same length.
fn multisig_auth_args(request: &NativeTransactionRequest) -> Result<MultisigAuthArgs, MaxFeeError> {
    let not_multisig = |reason: &str| MaxFeeError::NotMultisigAuthArgs(reason.to_string());

    let auth_arg = (*request.auth_arg()).ok_or_else(|| not_multisig("it has no auth argument"))?;
    let preimage = request
        .advice_map()
        .get(&auth_arg)
        .ok_or_else(|| not_multisig("its advice map has no preimage of the auth argument"))?;
    let elements: &[NativeFelt; MULTISIG_AUTH_ARGS_LEN] = preimage
        .as_ref()
        .try_into()
        .map_err(|_| not_multisig("the preimage of its auth argument does not have 12 elements"))?;

    let block_num = |element: NativeFelt| {
        u32::try_from(element.as_canonical_u64())
            .map_err(|_| not_multisig("a block number of its auth args does not fit in 32 bits"))
    };
    let bound_block_num = block_num(elements[0])?;
    let approval_expiration_block_num = block_num(elements[1])?;
    let max_fee = AssetAmount::try_from(elements[2])
        .map_err(|_| not_multisig("the max fee of its auth args is not a valid amount"))?;
    let salt = NativeWord::from([elements[4], elements[5], elements[6], elements[7]]);
    let conversion_info = NativeWord::from([elements[8], elements[9], elements[10], elements[11]]);

    let mut auth_args =
        MultisigAuthArgs::new(BlockNumber::from(bound_block_num), salt).with_max_fee(max_fee);
    // Zero is the encoding of an approval that does not expire.
    if approval_expiration_block_num != 0 {
        let delta = approval_expiration_block_num
            .checked_sub(bound_block_num)
            .and_then(NonZeroU32::new)
            .ok_or_else(|| {
                not_multisig(
                    "the approval expiration of its auth args is not after the bound block",
                )
            })?;
        auth_args = auth_args.with_approval_expiration_delta(delta).map_err(|_| {
            not_multisig("the approval expiration of its auth args is not a block number")
        })?;
    }
    // The empty word is the encoding of auth args without conversion info.
    if conversion_info != NativeWord::empty() {
        let faucet_id = NativeAccountId::try_from_elements(elements[8], elements[9])
            .map_err(|_| not_multisig("the fee faucet of its auth args is not an account ID"))?;
        let info = FeeConversionInfo::new(
            faucet_id,
            elements[10].as_canonical_u64(),
            elements[11].as_canonical_u64(),
        )
        .map_err(|_| not_multisig("the conversion rate of its auth args is not valid"))?;
        auth_args = auth_args.with_conversion_info(info);
    }

    if auth_args.to_elements().as_slice() != elements.as_slice() {
        return Err(not_multisig(
            "the preimage of its auth argument is not the encoding of multisig auth args",
        ));
    }

    Ok(auth_args)
}

/// Checks that `summary` binds the block, the approval expiration and the salt of `auth_args`.
///
/// A summary of another request has another salt. Signatures over it would not authorize the
/// execution of this request, so the pair is refused here.
fn check_summary(
    auth_args: &MultisigAuthArgs,
    summary: &NativeTransactionSummary,
) -> Result<(), MaxFeeError> {
    let mismatch = |what: &str| {
        MaxFeeError::SummaryMismatch(alloc::format!("it does not bind the {what} of the auth args"))
    };
    let user_params = summary.user_params();
    let user_params = user_params.as_elements();

    if summary.block_number() != auth_args.bound_block_num() {
        return Err(mismatch("bound block"));
    }
    let approval_expiration = auth_args
        .approval_expiration_block_num()
        .map_or(NativeFelt::ZERO, NativeFelt::from);
    if user_params[APPROVAL_EXPIRATION_USER_PARAM_INDEX] != approval_expiration {
        return Err(mismatch("approval expiration"));
    }
    let salt = auth_args.salt();
    if user_params[SALT_USER_PARAM_INDEX..] != salt[0..NativeWord::NUM_ELEMENTS] {
        return Err(mismatch("salt"));
    }

    Ok(())
}

// TESTS
// ================================================================================================

#[cfg(all(test, feature = "nodejs"))]
mod tests {
    use alloc::vec;
    use alloc::vec::Vec;

    use miden_client::transaction::TransactionRequestBuilder;
    use miden_protocol::account::{
        AccountCodePatch,
        AccountDelta,
        AccountStoragePatch,
        AccountVaultDelta,
    };
    use miden_protocol::testing::account_id::{
        ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET,
        ACCOUNT_ID_SENDER,
    };
    use miden_protocol::transaction::{
        InputNotes,
        RawOutputNotes,
        TransactionLogs,
        TransactionSummaryUserParams,
    };

    use super::*;

    const BOUND_BLOCK: u32 = 40;
    const SALT: [u32; 4] = [11, 12, 13, 14];

    /// Auth args of any shape, given as their elements.
    struct Preimage(Vec<NativeFelt>);

    impl SequentialCommit for Preimage {
        type Commitment = NativeWord;

        fn to_elements(&self) -> Vec<NativeFelt> {
            self.0.clone()
        }
    }

    fn salt() -> NativeWord {
        NativeWord::from(SALT)
    }

    /// Multisig auth args as the SDK builds them: a bound block, a salt and the conversion info of
    /// the fee faucet.
    fn auth_args() -> MultisigAuthArgs {
        let faucet_id = NativeAccountId::try_from(ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET).unwrap();
        MultisigAuthArgs::new(BlockNumber::from(BOUND_BLOCK), salt())
            .with_conversion_info(FeeConversionInfo::one_to_one(faucet_id))
    }

    fn request_with(auth_args: &MultisigAuthArgs) -> NativeTransactionRequest {
        TransactionRequestBuilder::new().build().unwrap().with_auth_args(auth_args)
    }

    /// The summary that an unsigned execution with `auth_args` reports when the max fee that it
    /// binds is `max_fee`.
    fn summary_of(auth_args: &MultisigAuthArgs, max_fee: u64) -> NativeTransactionSummary {
        let account_id = NativeAccountId::try_from(ACCOUNT_ID_SENDER).unwrap();
        let expiration = auth_args
            .approval_expiration_block_num()
            .map_or(NativeFelt::ZERO, NativeFelt::from);
        let salt = auth_args.salt();
        NativeTransactionSummary::new(
            AccountDelta::new(
                account_id,
                AccountStoragePatch::default(),
                AccountVaultDelta::default(),
                AccountCodePatch::default(),
                NativeFelt::ONE,
            )
            .unwrap(),
            InputNotes::new(vec![]).unwrap(),
            RawOutputNotes::new(vec![]).unwrap(),
            auth_args.bound_block_num(),
            NativeWord::from([1u32, 2, 3, 4]),
            0,
            TransactionSummaryUserParams::new([
                expiration,
                NativeFelt::try_from(max_fee).unwrap(),
                salt[0],
                salt[1],
                salt[2],
                salt[3],
            ]),
            TransactionLogs::default(),
        )
    }

    fn preimage_of(request: &NativeTransactionRequest) -> Vec<NativeFelt> {
        let auth_arg = (*request.auth_arg()).expect("the request has an auth argument");
        request
            .advice_map()
            .get(&auth_arg)
            .expect("the advice map has the preimage")
            .to_vec()
    }

    #[test]
    fn scales_the_estimate_in_the_auth_args_and_in_the_summary() {
        let auth_args = auth_args();
        let request = request_with(&auth_args);
        let summary = summary_of(&auth_args, 1001);

        let capped = EstimatedMaxFee::new(&request, &summary, 150).unwrap();

        // 1001 * 150 / 100, rounded up.
        assert_eq!(capped.max_fee, 1502);
        let capped_request = NativeTransactionRequest::from(&capped.request);
        let capped_summary = NativeTransactionSummary::from(&capped.summary);
        assert_eq!(
            preimage_of(&capped_request),
            auth_args.with_max_fee(AssetAmount::new(1502).unwrap()).to_elements()
        );
        assert_eq!(capped_summary, summary_of(&auth_args, 1502));
        assert_ne!(capped_summary.to_commitment(), summary.to_commitment());
        // Nothing but the auth args changes.
        assert_ne!(capped_request.auth_arg(), request.auth_arg());
        assert_eq!(capped_request.block_numbers(), request.block_numbers());
        assert_eq!(capped_request.script_template(), request.script_template());
    }

    #[test]
    fn keeps_the_approval_expiration_and_raises_a_max_fee_that_is_already_set() {
        let auth_args = auth_args()
            .with_approval_expiration_delta(NonZeroU32::new(7).unwrap())
            .unwrap()
            .with_max_fee(AssetAmount::new(400).unwrap());
        let request = request_with(&auth_args);
        // The summary binds the max fee of the auth args.
        let summary = summary_of(&auth_args, 400);

        let capped = EstimatedMaxFee::new(&request, &summary, 100).unwrap();
        assert_eq!(capped.max_fee, 400);
        assert_eq!(preimage_of(&NativeTransactionRequest::from(&capped.request)), {
            auth_args.to_elements()
        });

        let raised = EstimatedMaxFee::new(&request, &summary, 200).unwrap();
        assert_eq!(raised.max_fee, 800);
        let raised_preimage = preimage_of(&NativeTransactionRequest::from(&raised.request));
        assert_eq!(raised_preimage[1], NativeFelt::from(BOUND_BLOCK + 7));
        assert_eq!(raised_preimage[2], NativeFelt::from(800u32));
    }

    #[test]
    fn a_zero_estimate_sets_no_cap() {
        let auth_args = auth_args();
        let request = request_with(&auth_args);
        let summary = summary_of(&auth_args, 0);

        let capped = EstimatedMaxFee::new(&request, &summary, 150).unwrap();

        assert_eq!(capped.max_fee, 0);
        assert_eq!(NativeTransactionRequest::from(&capped.request).auth_arg(), request.auth_arg());
        assert_eq!(NativeTransactionSummary::from(&capped.summary), summary);
    }

    #[test]
    fn a_zero_margin_is_refused() {
        let auth_args = auth_args();
        let error = EstimatedMaxFee::new(&request_with(&auth_args), &summary_of(&auth_args, 10), 0)
            .err()
            .unwrap();
        assert!(matches!(error, MaxFeeError::InvalidMaxFee(_)), "{error:?}");
    }

    #[test]
    fn a_request_without_multisig_auth_args_is_refused() {
        let auth_args = auth_args();
        let summary = summary_of(&auth_args, 10);
        let not_multisig = |request: &NativeTransactionRequest| {
            let error = EstimatedMaxFee::new(request, &summary, 150).err().unwrap();
            assert!(matches!(error, MaxFeeError::NotMultisigAuthArgs(_)), "{error:?}");
            error.to_string()
        };

        let bare = TransactionRequestBuilder::new().build().unwrap();
        assert!(not_multisig(&bare).contains("no auth argument"));

        // A declared salt is not auth args.
        let salted = TransactionRequestBuilder::new().fee_conversion_salt(salt()).build().unwrap();
        assert!(not_multisig(&salted).contains("no auth argument"));

        // Auth args of another shape.
        let short = bare.clone().with_auth_args(&Preimage(vec![NativeFelt::ONE; 8]));
        assert!(not_multisig(&short).contains("does not have 12 elements"));

        // Twelve elements that multisig auth args do not encode to: the fourth one is not zero.
        let mut elements = auth_args.to_elements();
        elements[3] = NativeFelt::ONE;
        let unknown = bare.clone().with_auth_args(&Preimage(elements));
        assert!(not_multisig(&unknown).contains("not the encoding of multisig auth args"));

        // An approval expiration at the bound block.
        let mut elements = auth_args.to_elements();
        elements[1] = NativeFelt::from(BOUND_BLOCK);
        let expired = bare.with_auth_args(&Preimage(elements));
        assert!(not_multisig(&expired).contains("not after the bound block"));
    }

    #[test]
    fn a_summary_of_another_request_is_refused() {
        let auth_args = auth_args();
        let request = request_with(&auth_args);
        let mismatch = |summary: &NativeTransactionSummary| {
            let error = EstimatedMaxFee::new(&request, summary, 150).err().unwrap();
            assert!(matches!(error, MaxFeeError::SummaryMismatch(_)), "{error:?}");
            error.to_string()
        };

        let other_salt = MultisigAuthArgs::new(
            BlockNumber::from(BOUND_BLOCK),
            NativeWord::from([21u32, 22, 23, 24]),
        );
        assert!(mismatch(&summary_of(&other_salt, 10)).contains("salt"));

        let other_block = MultisigAuthArgs::new(BlockNumber::from(BOUND_BLOCK + 1), salt());
        assert!(mismatch(&summary_of(&other_block, 10)).contains("bound block"));

        let with_expiration = MultisigAuthArgs::new(BlockNumber::from(BOUND_BLOCK), salt())
            .with_approval_expiration_delta(NonZeroU32::new(3).unwrap())
            .unwrap();
        assert!(mismatch(&summary_of(&with_expiration, 10)).contains("approval expiration"));
    }

    #[test]
    fn a_summary_whose_max_fee_is_not_an_amount_is_refused() {
        let auth_args = auth_args();
        let summary = summary_of(&auth_args, AssetAmount::MAX.as_u64() + 1);

        let error = EstimatedMaxFee::new(&request_with(&auth_args), &summary, 100).err().unwrap();
        assert!(matches!(error, MaxFeeError::InvalidMaxFee(_)), "{error:?}");
    }

    #[test]
    fn a_scaled_max_fee_above_the_largest_amount_is_refused() {
        let auth_args = auth_args();
        let request = request_with(&auth_args);
        let summary = summary_of(&auth_args, AssetAmount::MAX.as_u64());

        // The largest amount itself is kept.
        let kept = EstimatedMaxFee::new(&request, &summary, 100).unwrap();
        assert_eq!(kept.max_fee, AssetAmount::MAX.as_u64());

        for fee_margin_percent in [101, u32::MAX] {
            let error = EstimatedMaxFee::new(&request, &summary, fee_margin_percent).err().unwrap();
            assert!(matches!(error, MaxFeeError::InvalidMaxFee(_)), "{error:?}");
        }
    }
}
