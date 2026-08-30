use js_export_macro::js_export;
use miden_client::account::AccountId as NativeAccountId;
use miden_client::account::component::FeeConversionInfo as NativeFeeConversionInfo;

use super::account_id::AccountId;

/// Names the asset a transaction pays its fee in, and the rate to convert the fee into it.
///
/// Since protocol 0.16 the fee is paid from inside the account's auth procedure rather than the
/// kernel epilogue, and `fee::pay_fee` reads this from the transaction's auth args. A transaction
/// on a fee-charging chain that commits none aborts with `ERR_FEE_CONVERSION_INFO_MISSING`.
#[derive(Clone, Copy)]
#[js_export]
pub struct FeeConversionInfo(NativeFeeConversionInfo);

#[js_export]
impl FeeConversionInfo {
    /// Pays the fee in the asset issued by `faucet_id` at a rate of 1/1.
    ///
    /// This is the right choice when paying in the chain's own fee asset, whose faucet is
    /// `BlockHeader.feeFaucetId()` — no conversion is involved, so the rate is the identity.
    ///
    /// The identity rate is the only rate this binding expresses, so passing any OTHER faucet pays
    /// the native fee's raw magnitude in that asset's smallest unit. That is only what you want for
    /// an asset whose unit scale and value match the fee asset's; for anything else it overpays or
    /// underpays by the true exchange rate, and the amount is withdrawn from the account's vault
    /// without appearing in the request's expected output notes, since the kernel creates the fee
    /// note itself.
    #[js_export(js_name = "oneToOne")]
    pub fn one_to_one(faucet_id: &AccountId) -> FeeConversionInfo {
        let native: NativeAccountId = faucet_id.into();
        FeeConversionInfo(NativeFeeConversionInfo::one_to_one(native))
    }

    /// Returns the faucet issuing the asset the fee is paid in.
    #[js_export(js_name = "faucetId")]
    pub fn faucet_id(&self) -> AccountId {
        self.0.faucet_id().into()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<FeeConversionInfo> for NativeFeeConversionInfo {
    fn from(info: FeeConversionInfo) -> Self {
        info.0
    }
}

impl From<&FeeConversionInfo> for NativeFeeConversionInfo {
    fn from(info: &FeeConversionInfo) -> Self {
        info.0
    }
}

impl From<NativeFeeConversionInfo> for FeeConversionInfo {
    fn from(info: NativeFeeConversionInfo) -> Self {
        FeeConversionInfo(info)
    }
}
