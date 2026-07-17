use js_export_macro::js_export;
use miden_client::asset::AssetCallbackFlag as NativeAssetCallbackFlag;

/// Whether a faucet's asset callbacks run when an asset is added to an account or a note.
///
/// The flag is part of an asset's vault key, so two assets from the same faucet with different
/// flags occupy different vault slots and do not merge. Assets minted by a faucet that registers
/// transfer policies carry `Enabled`; everything else carries `Disabled`.
#[js_export]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum AssetCallbackFlag {
    /// The faucet's callbacks are not invoked for this asset. This is the default for an asset
    /// built via the `FungibleAsset` constructor.
    Disabled = 0,

    /// The faucet's callbacks are invoked before this asset is added to an account or a note.
    Enabled = 1,
}

// Compile-time check to keep enum values aligned with `miden_client::asset::AssetCallbackFlag`.
const _: () = {
    assert!(NativeAssetCallbackFlag::Disabled as u8 == AssetCallbackFlag::Disabled as u8);
    assert!(NativeAssetCallbackFlag::Enabled as u8 == AssetCallbackFlag::Enabled as u8);
};

impl From<NativeAssetCallbackFlag> for AssetCallbackFlag {
    fn from(value: NativeAssetCallbackFlag) -> Self {
        match value {
            NativeAssetCallbackFlag::Disabled => AssetCallbackFlag::Disabled,
            NativeAssetCallbackFlag::Enabled => AssetCallbackFlag::Enabled,
        }
    }
}

impl From<AssetCallbackFlag> for NativeAssetCallbackFlag {
    fn from(value: AssetCallbackFlag) -> Self {
        match value {
            AssetCallbackFlag::Disabled => NativeAssetCallbackFlag::Disabled,
            AssetCallbackFlag::Enabled => NativeAssetCallbackFlag::Enabled,
        }
    }
}
