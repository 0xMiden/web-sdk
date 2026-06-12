use alloc::format;
use alloc::string::ToString;
use alloc::sync::Arc;
use core::time::Duration;

use js_export_macro::js_export;
use miden_client::RemoteTransactionProver;
use miden_client::transaction::{
    LocalTransactionProver, ProvingOptions, TransactionProver as TransactionProverTrait,
};
#[cfg(feature = "browser")]
use miden_client::transaction::{ProvenTransaction, TransactionInputs, TransactionProverError};
#[cfg(feature = "browser")]
use miden_client::utils::{Deserializable, Serializable};
#[cfg(feature = "browser")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "browser")]
use wasm_bindgen_futures::JsFuture;
#[cfg(feature = "browser")]
use wasm_bindgen_futures::js_sys::{Function, Promise, Uint8Array};

use crate::platform::{JsErr, from_str_err, js_u64_to_u64};

/// Wrapper over local or remote transaction proving backends.
#[js_export]
#[derive(Clone)]
pub struct TransactionProver {
    prover: Arc<dyn TransactionProverTrait + Send + Sync>,
    endpoint: Option<String>,
    timeout: Option<Duration>,
}

#[js_export]
impl TransactionProver {
    /// Creates a new remote transaction prover.
    ///
    /// Arguments:
    /// - `endpoint`: The URL of the remote prover.
    /// - `timeout_ms`: The timeout in milliseconds for the remote prover.
    #[js_export(js_name = "newRemoteProver")]
    pub fn new_remote_prover(endpoint: String, timeout_ms: Option<JsU64>) -> TransactionProver {
        TransactionProver::new_remote_prover_inner(endpoint, timeout_ms.map(js_u64_to_u64))
    }

    /// Creates a prover that uses the local proving backend.
    #[js_export(js_name = "newLocalProver")]
    pub fn new_local_prover() -> TransactionProver {
        let local_prover = LocalTransactionProver::new(ProvingOptions::default());
        TransactionProver {
            prover: Arc::new(local_prover),
            endpoint: None,
            timeout: None,
        }
    }

    /// Serializes the prover configuration into a string descriptor.
    ///
    /// Format:
    /// - `"local"` for local prover
    /// - `"remote|{endpoint}"` for remote prover without timeout
    /// - `"remote|{endpoint}|{timeout_ms}"` for remote prover with timeout
    ///
    /// Uses `|` as delimiter since it's not a valid URL character.
    pub fn serialize(&self) -> String {
        match (&self.endpoint, &self.timeout) {
            (Some(ep), Some(timeout)) => {
                let timeout_ms = u64::try_from(timeout.as_millis())
                    .expect("timeout was created from u64 milliseconds");
                format!("remote|{ep}|{timeout_ms}")
            },
            (Some(ep), None) => format!("remote|{ep}"),
            (None, _) => "local".to_string(),
        }
    }

    /// Reconstructs a prover from its serialized descriptor.
    ///
    /// Parses the format produced by `serialize()`:
    /// - `"local"` for local prover
    /// - `"remote|{endpoint}"` for remote prover without timeout
    /// - `"remote|{endpoint}|{timeout_ms}"` for remote prover with timeout
    pub fn deserialize(payload: String) -> Result<TransactionProver, JsErr> {
        if payload == "local" {
            return Ok(TransactionProver::new_local_prover());
        }

        if let Some(rest) = payload.strip_prefix("remote|") {
            if rest.is_empty() {
                return Err(from_str_err("Remote prover requires an endpoint"));
            }

            // Split on last `|` to extract optional timeout
            if let Some(last_pipe) = rest.rfind('|') {
                let endpoint = &rest[..last_pipe];
                let timeout_str = &rest[last_pipe + 1..];

                // Check if the suffix is a valid integer (timeout)
                if let Ok(timeout_ms) = timeout_str.parse::<u64>() {
                    return Ok(TransactionProver::new_remote_prover_inner(
                        endpoint.to_string(),
                        Some(timeout_ms),
                    ));
                }
            }

            // No valid timeout found, entire rest is the endpoint
            return Ok(TransactionProver::new_remote_prover_inner(rest.to_string(), None));
        }

        Err(from_str_err(&format!("Invalid prover payload: {payload}")))
    }

    /// Returns the endpoint if this is a remote prover.
    pub fn endpoint(&self) -> Option<String> {
        self.endpoint.clone()
    }
}

impl TransactionProver {
    /// Internal constructor for remote prover, usable from both platforms.
    pub(crate) fn new_remote_prover_inner(
        endpoint: String,
        timeout_ms: Option<u64>,
    ) -> TransactionProver {
        let mut remote_prover = RemoteTransactionProver::new(&endpoint);

        let timeout = if let Some(timeout) = timeout_ms {
            let timeout = Duration::from_millis(timeout);
            remote_prover = remote_prover.with_timeout(timeout);
            Some(timeout)
        } else {
            None
        };

        TransactionProver {
            prover: Arc::new(remote_prover),
            endpoint: Some(endpoint),
            timeout,
        }
    }
}

impl TransactionProver {
    /// Returns the underlying proving trait object.
    pub fn get_prover(&self) -> Arc<dyn TransactionProverTrait + Send + Sync> {
        self.prover.clone()
    }
}

impl From<Arc<dyn TransactionProverTrait + Send + Sync>> for TransactionProver {
    fn from(prover: Arc<dyn TransactionProverTrait + Send + Sync>) -> Self {
        TransactionProver { prover, endpoint: None, timeout: None }
    }
}

impl_napi_from_value!(TransactionProver);

// ────────────────────────────────────────────────────────────────────────
// JsCallbackTransactionProver — delegates prove() to a JS function.
// ────────────────────────────────────────────────────────────────────────
//
// Browser-only: the callback is a `js_sys::Function`, which has no napi
// representation — the Node.js binding gets local/remote provers only.

/// Browser-only constructors that cannot go through `js_export` because
/// their parameter types exist only in the wasm-bindgen world.
#[cfg(feature = "browser")]
#[wasm_bindgen]
impl TransactionProver {
    /// Creates a prover that delegates `prove()` to a JavaScript callback.
    ///
    /// The callback receives the serialized [`TransactionInputs`] as a
    /// `Uint8Array` and must return a `Promise<Uint8Array>` resolving to a
    /// serialized [`ProvenTransaction`] (same encoding the gRPC remote
    /// prover uses: `tx_inputs.to_bytes()` in, `ProvenTransaction::read_from_bytes`
    /// out).
    ///
    /// Use case: routing prove to a native iOS / Android plugin
    /// (`@miden/native-prover`) so mobile builds skip WASM prove entirely
    /// — `WKWebView` can't be made cross-origin-isolated reliably and the
    /// MT WASM bundle can't instantiate without `SharedArrayBuffer`, so the
    /// host wraps a native Rust prover (built with the same `miden_tx`
    /// crate) and exposes a JS-shaped callback over the Capacitor bridge.
    ///
    /// The SDK does NOT serialize the prover for persistence across
    /// reloads (unlike `newRemoteProver`), since the callback is a
    /// runtime JS reference. Hosts must recreate the prover on every
    /// page load.
    #[wasm_bindgen(js_name = "newCallbackProver")]
    pub fn new_callback_prover(callback: Function) -> TransactionProver {
        let prover = JsCallbackTransactionProver { callback };
        TransactionProver {
            prover: Arc::new(prover),
            endpoint: None,
            timeout: None,
        }
    }
}

/// [`TransactionProverTrait`] adapter that dispatches `prove()` to a JS
/// callback returning a `Promise<Uint8Array>`. See
/// [`TransactionProver::newCallbackProver`].
#[cfg(feature = "browser")]
pub(crate) struct JsCallbackTransactionProver {
    callback: Function,
}

// `Function` / `JsValue` are not `Send`/`Sync`, but the SDK only runs on
// the single-threaded WASM main context. Mirrors the same pattern
// `WebKeyStore`'s `JsCallbacks` uses for its own JS-held callbacks.
#[cfg(feature = "browser")]
unsafe impl Send for JsCallbackTransactionProver {}
#[cfg(feature = "browser")]
unsafe impl Sync for JsCallbackTransactionProver {}

#[cfg(feature = "browser")]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
impl TransactionProverTrait for JsCallbackTransactionProver {
    async fn prove(
        &self,
        tx_inputs: TransactionInputs,
    ) -> Result<ProvenTransaction, TransactionProverError> {
        // Wire format matches the existing gRPC `RemoteTransactionProver`:
        // `tx_inputs.to_bytes()` in, `ProvenTransaction::read_from_bytes(..)`
        // out. Keeping these identical means a native prover plugin can be
        // re-used unchanged behind either dispatcher.
        let serialized = tx_inputs.to_bytes();
        let input_arr = Uint8Array::from(serialized.as_slice());

        let call_result =
            self.callback.call1(&JsValue::NULL, &input_arr.into()).map_err(|err| {
                TransactionProverError::other(format!(
                    "callback prover threw at invocation: {err:?}"
                ))
            })?;

        let resolved = if let Some(promise) = call_result.dyn_ref::<Promise>() {
            JsFuture::from(promise.clone()).await.map_err(|err| {
                TransactionProverError::other(format!("callback prover promise rejected: {err:?}"))
            })?
        } else {
            call_result
        };

        let bytes = resolved
            .dyn_ref::<Uint8Array>()
            .ok_or_else(|| {
                TransactionProverError::other(
                    "callback prover must resolve to Uint8Array".to_string(),
                )
            })?
            .to_vec();

        ProvenTransaction::read_from_bytes(&bytes).map_err(|err| {
            TransactionProverError::other(format!(
                "callback prover returned undecodable ProvenTransaction: {err:?}"
            ))
        })
    }
}
