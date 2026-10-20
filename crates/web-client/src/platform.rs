// Platform abstraction layer for browser (wasm_bindgen) vs Node.js (napi-rs).
//
// Provides type aliases and helper functions that abstract over the differences
// between the two binding technologies.

// ERROR TYPES
// ================================================================================================

/// Platform-specific JS error type.
#[cfg(feature = "browser")]
pub(crate) type JsErr = wasm_bindgen::JsValue;

/// Platform-specific JS error type.
#[cfg(feature = "nodejs")]
pub(crate) type JsErr = napi::Error;

/// Create an error from a string message.
#[cfg(feature = "browser")]
pub(crate) fn from_str_err(msg: &str) -> JsErr {
    wasm_bindgen::JsValue::from_str(msg)
}

/// Create an error from a string message.
#[cfg(feature = "nodejs")]
pub(crate) fn from_str_err(msg: &str) -> JsErr {
    napi::Error::from_reason(msg)
}

/// Create an error carrying a stable machine-readable `code` property, so JS
/// callers can branch on the code instead of matching the (changeable) message
/// text. The worker shim forwards `code` across the worker boundary.
#[cfg(feature = "browser")]
pub(crate) fn from_str_err_with_code(msg: &str, code: &str) -> JsErr {
    let js_error: wasm_bindgen::JsValue = wasm_bindgen::JsError::new(msg).into();
    let _ = js_sys::Reflect::set(
        &js_error,
        &wasm_bindgen::JsValue::from_str("code"),
        &wasm_bindgen::JsValue::from_str(code),
    );
    js_error
}

/// Create an error carrying a stable machine-readable `code`. The Node.js
/// binding's error `code` property is napi's fixed `Status` enum (always
/// `GenericFailure` here), so the stable code is prefixed onto the message
/// instead: `"<CODE>: <message>"`.
#[cfg(feature = "nodejs")]
pub(crate) fn from_str_err_with_code(msg: &str, code: &str) -> JsErr {
    napi::Error::from_reason(format!("{code}: {msg}"))
}

// BYTE TYPES
// ================================================================================================

/// Platform-specific byte array type for serialization/deserialization.
#[cfg(feature = "browser")]
pub(crate) type JsBytes = js_sys::Uint8Array;

/// Platform-specific byte array type for serialization/deserialization.
#[cfg(feature = "nodejs")]
pub(crate) type JsBytes = napi::bindgen_prelude::Buffer;

/// Convert a byte slice to the platform-specific byte array type.
#[cfg(feature = "browser")]
pub(crate) fn bytes_to_js(bytes: &[u8]) -> JsBytes {
    js_sys::Uint8Array::from(bytes)
}

/// Convert a byte slice to the platform-specific byte array type.
#[cfg(feature = "nodejs")]
pub(crate) fn bytes_to_js(bytes: &[u8]) -> JsBytes {
    napi::bindgen_prelude::Buffer::from(bytes)
}

/// Convert a platform-specific byte array to a Vec<u8>.
pub(crate) fn js_to_bytes(js_bytes: &JsBytes) -> Vec<u8> {
    js_bytes.to_vec()
}

/// A JavaScript `Uint16Array`, used for RPC nullifier prefixes.
#[cfg(feature = "browser")]
pub(crate) type JsU16Array = Vec<u16>;

/// An owned snapshot of a JavaScript `Uint16Array` for async RPC calls.
#[cfg(feature = "nodejs")]
pub(crate) use owned_u16_array::JsU16Array;

#[cfg(feature = "nodejs")]
mod owned_u16_array {
    use std::ptr;

    use napi::bindgen_prelude::{
        FromNapiValue,
        TypeName,
        Uint16ArraySlice,
        ValidateNapiValue,
        sys,
    };

    pub struct JsU16Array(pub(crate) Vec<u16>);

    impl TypeName for JsU16Array {
        fn type_name() -> &'static str {
            "Uint16Array"
        }

        fn value_type() -> napi::ValueType {
            napi::ValueType::Object
        }
    }

    impl ValidateNapiValue for JsU16Array {
        unsafe fn validate(
            env: sys::napi_env,
            value: sys::napi_value,
        ) -> napi::Result<sys::napi_value> {
            unsafe { Uint16ArraySlice::validate(env, value) }
        }
    }

    impl FromNapiValue for JsU16Array {
        unsafe fn from_napi_value(
            env: sys::napi_env,
            value: sys::napi_value,
        ) -> napi::Result<Self> {
            let mut backing_buffer = ptr::null_mut();
            napi::check_status!(
                unsafe {
                    sys::napi_get_typedarray_info(
                        env,
                        value,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &raw mut backing_buffer,
                        ptr::null_mut(),
                    )
                },
                "Expected a Uint16Array"
            )?;
            let mut ordinary_buffer = false;
            napi::check_status!(unsafe {
                sys::napi_is_arraybuffer(env, backing_buffer, &raw mut ordinary_buffer)
            })?;
            if !ordinary_buffer {
                return Err(napi::Error::new(
                    napi::Status::InvalidArg,
                    "Uint16Array prefixes must use an ArrayBuffer, not a SharedArrayBuffer",
                ));
            }

            // NAPI converts arguments on the JS thread before scheduling the async body.
            // Ordinary ArrayBuffer memory cannot be mutated concurrently here. Rejecting
            // shared backing memory above makes this temporary slice safe to copy.
            let values = unsafe { Uint16ArraySlice::from_napi_value(env, value) }?;
            Ok(Self(values.to_vec()))
        }
    }
}

// INTERIOR MUTABILITY
// ================================================================================================

/// Platform-specific async-compatible interior mutability wrapper.
///
/// - Browser (WASM): Uses `RefCell` (single-threaded, no contention).
/// - Node.js (native): Uses `tokio::sync::Mutex` (async-safe for napi's tokio runtime).
#[cfg(feature = "browser")]
pub(crate) struct AsyncCell<T>(std::cell::RefCell<T>);

#[cfg(feature = "nodejs")]
pub(crate) struct AsyncCell<T>(tokio::sync::Mutex<T>);

#[cfg(feature = "browser")]
impl<T> AsyncCell<T> {
    pub fn new(val: T) -> Self {
        Self(std::cell::RefCell::new(val))
    }

    // `unknown_lints` keeps this compiling across the floating `+nightly` clippy
    // CI uses: older toolchains know only `unused_async`, newer ones added
    // `unused_async_trait_impl`. The async is intentional, so both are allowed.
    #[allow(unknown_lints, clippy::unused_async, clippy::unused_async_trait_impl)]
    pub async fn lock(&self) -> std::cell::RefMut<'_, T> {
        self.0.borrow_mut()
    }

    /// Synchronous shared borrow (browser-only, single-threaded).
    ///
    /// Used by `#[wasm_bindgen(getter)]` methods that cannot be async.
    pub fn borrow(&self) -> std::cell::Ref<'_, T> {
        self.0.borrow()
    }
}

#[cfg(feature = "nodejs")]
impl<T: Send> AsyncCell<T> {
    pub fn new(val: T) -> Self {
        Self(tokio::sync::Mutex::new(val))
    }

    pub async fn lock(&self) -> impl core::ops::DerefMut<Target = T> + '_ {
        self.0.lock().await
    }
}

// NUMERIC TYPES
// ================================================================================================

/// Platform-specific unsigned 64-bit integer type for JS interop.
///
/// Both platforms expose this as a JavaScript `BigInt`. See `js-export-macro` for why
/// Node.js uses `napi::bindgen_prelude::BigInt` instead of `u64`.
#[cfg(feature = "browser")]
pub type JsU64 = u64;

#[cfg(feature = "nodejs")]
pub type JsU64 = napi::bindgen_prelude::BigInt;

/// Converts a [`JsU64`] to `u64`.
#[inline]
pub fn js_u64_to_u64(val: JsU64) -> u64 {
    #[cfg(feature = "browser")]
    {
        val
    }
    #[cfg(feature = "nodejs")]
    {
        let (signed, value, lossless) = val.get_u64();
        assert!(
            !signed && lossless,
            "BigInt value is outside the u64 range (0..2^64); \
             got signed={signed}, lossless={lossless}"
        );
        value
    }
}

/// Converts a `u64` to a [`JsU64`] for return to JS.
#[inline]
pub fn u64_to_js_u64(val: u64) -> JsU64 {
    #[cfg(feature = "browser")]
    {
        val
    }
    #[cfg(feature = "nodejs")]
    {
        napi::bindgen_prelude::BigInt::from(val)
    }
}

// FUTURE SEND WRAPPER
// ================================================================================================

/// On browser (WASM), futures are not `Send` and don't need to be — just pass through.
#[cfg(feature = "browser")]
pub(crate) fn maybe_wrap_send<F: std::future::Future>(
    future: F,
) -> impl std::future::Future<Output = F::Output> {
    future
}

/// On Node.js, napi-rs requires `Send` futures for its multi-threaded tokio runtime.
/// This unsafely asserts `Send` — sound because the concrete types behind trait objects
/// (`SqliteStore`, `GrpcClient`, `FilesystemKeyStore`) are all `Send + Sync`; only the
/// `dyn Trait` bounds lack `Send`.
#[cfg(feature = "nodejs")]
pub(crate) fn maybe_wrap_send<F: std::future::Future>(
    future: F,
) -> impl std::future::Future<Output = F::Output> + Send {
    struct AssertSend<F>(F);
    unsafe impl<F> Send for AssertSend<F> {}
    impl<F: std::future::Future> std::future::Future for AssertSend<F> {
        type Output = F::Output;
        fn poll(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Self::Output> {
            unsafe { self.map_unchecked_mut(|s| &mut s.0) }.poll(cx)
        }
    }
    AssertSend(future)
}

// CLIENT AUTH TYPE
// ================================================================================================

/// Platform-specific client authenticator type.
#[cfg(feature = "browser")]
pub(crate) type ClientAuth = crate::web_keystore::WebKeyStore<rand::rngs::StdRng>;

/// Platform-specific client authenticator type.
#[cfg(feature = "nodejs")]
pub(crate) type ClientAuth = miden_client::keystore::FilesystemKeyStore;
