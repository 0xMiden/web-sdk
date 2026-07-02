use js_export_macro::js_export;
use miden_client::agglayer::EthAddress as NativeEthAddress;

use crate::platform::{JsBytes, JsErr, bytes_to_js, from_str_err, js_to_bytes};

/// A 20-byte Ethereum address, used as the destination of an `AggLayer` bridge-out (B2AGG) note.
///
/// Construct one from a hex string with [`EthAddress::from_hex`] (the `0x` prefix is optional) or
/// from raw bytes with [`EthAddress::from_bytes`]. The canonical lowercase, `0x`-prefixed hex form
/// is available via [`EthAddress::to_hex`] (also exposed as `toString`).
#[js_export]
#[derive(Clone, Copy, Debug)]
pub struct EthAddress(NativeEthAddress);

#[js_export]
impl EthAddress {
    /// Builds an Ethereum address from a hex string (with or without the `0x` prefix).
    ///
    /// Returns an error if the string is not valid hex or does not encode exactly 20 bytes.
    #[js_export(js_name = "fromHex")]
    pub fn from_hex(hex: String) -> Result<EthAddress, JsErr> {
        let native = NativeEthAddress::from_hex(&hex).map_err(|err| {
            from_str_err(&format!("error instantiating EthAddress from hex: {err}"))
        })?;
        Ok(EthAddress(native))
    }

    /// Builds an Ethereum address from its raw 20-byte big-endian representation.
    ///
    /// Returns an error if the input is not exactly 20 bytes long.
    #[js_export(js_name = "fromBytes")]
    pub fn from_bytes(bytes: JsBytes) -> Result<EthAddress, JsErr> {
        let bytes = js_to_bytes(&bytes);
        let fixed: [u8; 20] = bytes.as_slice().try_into().map_err(|_| {
            from_str_err(&format!("EthAddress requires exactly 20 bytes, got {}", bytes.len()))
        })?;
        Ok(EthAddress(NativeEthAddress::new(fixed)))
    }

    /// Returns the canonical lowercase, `0x`-prefixed hex representation of the address.
    #[js_export(js_name = "toHex")]
    pub fn to_hex(&self) -> String {
        self.0.to_hex()
    }

    /// Returns the canonical lowercase, `0x`-prefixed hex representation of the address.
    #[js_export(js_name = "toString")]
    #[allow(clippy::inherent_to_string)]
    pub fn to_string(&self) -> String {
        self.to_hex()
    }

    /// Returns the raw 20-byte big-endian representation of the address.
    #[js_export(js_name = "toBytes")]
    pub fn to_bytes(&self) -> JsBytes {
        bytes_to_js(&self.0.as_bytes()[..])
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeEthAddress> for EthAddress {
    fn from(native: NativeEthAddress) -> Self {
        EthAddress(native)
    }
}

impl From<EthAddress> for NativeEthAddress {
    fn from(addr: EthAddress) -> Self {
        addr.0
    }
}

impl From<&EthAddress> for NativeEthAddress {
    fn from(addr: &EthAddress) -> Self {
        addr.0
    }
}

impl_napi_from_value!(EthAddress);
