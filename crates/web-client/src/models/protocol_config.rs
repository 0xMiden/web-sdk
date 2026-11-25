use js_export_macro::js_export;
use miden_client::protocol_config::ProtocolConfig as NativeProtocolConfig;

use super::account_id::AccountId;
use super::word::Word;

/// The rarely changing parameters of a network, such as the asset fees are paid in.
///
/// Block headers carry only its commitment; the client fetches the configuration itself from the
/// node, for the genesis block when it is created and for later blocks when it syncs.
#[derive(Clone)]
#[js_export]
pub struct ProtocolConfig(NativeProtocolConfig);

#[js_export]
impl ProtocolConfig {
    /// Returns the faucet of the asset that fees are paid in.
    #[js_export(js_name = "feeFaucetId")]
    pub fn fee_faucet_id(&self) -> AccountId {
        self.0.fee_asset_id().faucet_id().into()
    }

    /// Returns the commitment to this configuration, as committed to by block headers.
    pub fn commitment(&self) -> Word {
        self.0.to_commitment().into()
    }
}

impl From<NativeProtocolConfig> for ProtocolConfig {
    fn from(config: NativeProtocolConfig) -> Self {
        ProtocolConfig(config)
    }
}
