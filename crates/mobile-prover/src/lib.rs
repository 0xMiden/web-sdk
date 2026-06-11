//! Native Miden transaction prover with a C ABI.
//!
//! Wraps `miden_client::transaction::LocalTransactionProver` so iOS and
//! Android Capacitor plugins can prove transactions in pure native code
//! without going through the WASM bundle. Required because iOS WKWebView
//! does not engage `crossOriginIsolated` under Capacitor 8 regardless of
//! how COOP/COEP headers reach the WebView, which means
//! `SharedArrayBuffer` is unavailable and the MT WASM bundle's
//! `WebAssembly.Memory({shared: true})` fails at instantiate time. This
//! crate runs the same `LocalTransactionProver` on real native threads
//! via rayon (enabled by the `concurrent` feature on miden-client).
//!
//! Wire format matches the existing gRPC `RemoteTransactionProver` and the
//! web-sdk's `JsCallbackTransactionProver`: input is
//! `TransactionInputs::to_bytes()`, output is `ProvenTransaction::to_bytes()`.
//! Hosts can swap between dispatchers without changing serialization.

use miden_client::transaction::{
    LocalTransactionProver, ProvenTransaction, ProvingOptions, TransactionInputs,
};
use miden_client::utils::{Deserializable, Serializable};

/// Status codes returned by [`miden_prove_transaction`].
#[repr(i32)]
enum Status {
    Ok = 0,
    /// `input_ptr`/`input_len` did not decode as a `TransactionInputs`.
    BadInput = -1,
    /// `LocalTransactionProver::prove` returned an error. The host should
    /// treat this as a "tried to prove a malformed/invalid tx" — not a
    /// transport/connectivity problem.
    ProveFailed = -2,
    /// `output_buf_cap` was smaller than the serialized
    /// `ProvenTransaction`. `output_written` is set to the required size
    /// so the host can re-allocate and call again.
    BufferTooSmall = -3,
}

/// Prove a serialized transaction.
///
/// # Safety
///
/// - `input_ptr` must point to `input_len` initialized bytes that decode
///   as a `miden_client::transaction::TransactionInputs` (the same byte
///   format the gRPC `RemoteTransactionProver` and the JS
///   `TransactionProver.newCallbackProver` callback consume).
/// - `output_buf_ptr` must point to a writable region of at least
///   `output_buf_cap` bytes.
/// - `output_written` must point to a writable `usize`. On every return
///   path (success or `BufferTooSmall`) it is set to the number of bytes
///   that would be / were written.
///
/// Returns one of the variants of `Status` (cast to `i32`). On `Ok`,
/// `output_written` is the number of bytes the host should slice from
/// the output buffer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn miden_prove_transaction(
    input_ptr: *const u8,
    input_len: usize,
    output_buf_ptr: *mut u8,
    output_buf_cap: usize,
    output_written: *mut usize,
) -> i32 {
    // SAFETY: caller-asserted contract (see doc comment).
    let input = unsafe { core::slice::from_raw_parts(input_ptr, input_len) };

    let inputs = match TransactionInputs::read_from_bytes(input) {
        Ok(i) => i,
        Err(_) => {
            // SAFETY: caller-asserted output_written validity.
            unsafe { *output_written = 0 };
            return Status::BadInput as i32;
        }
    };

    let prover = LocalTransactionProver::new(ProvingOptions::default());
    // The prove future is CPU-bound (no real async I/O); a tiny single-
    // thread executor suffices to drive it to completion. rayon-backed
    // parallelism inside the prover spawns its own threads via the
    // `concurrent` feature, independent of this outer executor.
    let proven: ProvenTransaction = match futures_executor::block_on(prover.prove(inputs)) {
        Ok(p) => p,
        Err(_) => {
            unsafe { *output_written = 0 };
            return Status::ProveFailed as i32;
        }
    };

    let serialized = proven.to_bytes();
    unsafe { *output_written = serialized.len() };

    if serialized.len() > output_buf_cap {
        return Status::BufferTooSmall as i32;
    }

    // SAFETY: bounds checked above.
    unsafe {
        core::ptr::copy_nonoverlapping(serialized.as_ptr(), output_buf_ptr, serialized.len());
    }
    Status::Ok as i32
}
