# js-export-macro

Procedural attribute macro (`#[js_export]`) for the [Miden Web SDK](https://github.com/0xMiden/web-sdk) that generates dual [`wasm-bindgen`](https://crates.io/crates/wasm-bindgen) and [`napi`](https://crates.io/crates/napi) bindings from a single Rust definition.

It is built for [`miden-client-web`](https://crates.io/crates/miden-client-web) so structs, enums, and `impl` blocks target both browser WebAssembly (`wasm32-unknown-unknown` under the `browser` feature) and Node.js native addons (under the `nodejs` feature) without duplicating attribute boilerplate.

## What `#[js_export]` Generates

`#[js_export]` supports `struct`, `enum`, and `impl` items (applying it to other items emits a compile error).

- **Browser (`feature = "browser"`)**: emits `#[cfg_attr(feature = "browser", ::wasm_bindgen::prelude::wasm_bindgen(...))]`.
- **Node.js (`feature = "nodejs"`)**: emits `#[cfg_attr(feature = "nodejs", ::napi_derive::napi(...))]`.
- **Structs and enums**: prepends both `cfg_attr` attributes to the item, preserving existing attributes (such as `#[derive(...)]` and `#[repr(u8)]`) and forwarding any arguments (for example `#[js_export]` or `#[js_export(js_name = "RpcStatusInfo")]`).
- **`impl` blocks and methods**: forwards outer `#[js_export(...)]` arguments onto the `impl` block and strips method-level `#[js_export(...)]` attributes, emitting both platform `cfg_attr` attributes on every method in the block:
  - `#[js_export(constructor)]`
  - `#[js_export(getter)]`
  - `#[js_export(js_name = "camelCase")]`
  - `#[js_export(getter, js_name = "noteDetails")]`
  - Methods inside a `#[js_export]` `impl` block without a method-level `#[js_export]` attribute still receive bare `wasm_bindgen` and `napi` `cfg_attr` attributes; non-function items (`const`, `type`) remain unchanged.

### `JsU64` Signature Splitting

When a method signature contains `JsU64` (including `Vec<JsU64>` or `Option<Vec<JsU64>>`) in its parameters or return type, `#[js_export]` splits that method into separate `#[cfg(feature = "browser")]` (`#[::wasm_bindgen::prelude::wasm_bindgen]`) and `#[cfg(feature = "nodejs")]` (`#[::napi_derive::napi]`) `impl` blocks while leaving the method body untouched:

- **Under `browser`**: replaces `JsU64` in arguments with `::js_sys::BigInt` (allowing explicit `0..2^64` range validation instead of `wasm-bindgen`'s modulo `2^64` wrapping) and replaces `JsU64` in the return type with `u64`. Adds `unchecked_param_type = "BigUint64Array | bigint[]"` for `Vec<JsU64>` arguments and `unchecked_param_type = "BigUint64Array | bigint[] | null | void"` for `Option<Vec<JsU64>>` arguments.
- **Under `nodejs`**: replaces `JsU64` in both arguments and return types with `::napi::bindgen_prelude::BigInt`.

## Usage

Add `js-export-macro` to `Cargo.toml`. Consumer crates must define `browser` and `nodejs` Cargo features with `wasm-bindgen` and `js-sys` available under `browser`, and `napi` and `napi-derive` available under `nodejs`.

```toml
[dependencies]
js-export-macro = "0.18"
```

Example struct, constructor, getter, and `JsU64` method (from `crates/web-client/src/models/`):

```rust
use js_export_macro::js_export;

#[derive(Clone, Copy)]
#[js_export]
pub struct Felt(NativeFelt);

#[js_export]
impl Felt {
    #[js_export(constructor)]
    pub fn new(value: JsU64) -> Result<Felt, JsErr> {
        NativeFelt::new(js_u64_to_u64(value)?)
            .map(Felt)
            .map_err(|err| from_str_err(&format!("invalid Felt value: {err}")))
    }

    #[js_export(js_name = "asInt")]
    pub fn as_int(&self) -> JsU64 {
        u64_to_js_u64(self.0.as_canonical_u64())
    }
}

#[derive(Clone)]
#[js_export(js_name = "RpcStatusInfo")]
pub struct RpcStatusInfo {
    version: String,
    chain_tip: u32,
}

#[js_export]
impl RpcStatusInfo {
    #[js_export(getter)]
    pub fn version(&self) -> String {
        self.version.clone()
    }

    #[js_export(getter, js_name = "chainTip")]
    pub fn chain_tip(&self) -> u32 {
        self.chain_tip
    }
}
```

## Links

- [Repository](https://github.com/0xMiden/web-sdk)
- [Crate source](https://github.com/0xMiden/web-sdk/tree/main/crates/js-export-macro)
- [API documentation](https://docs.rs/js-export-macro)

## License

This project is licensed under the MIT License. See the [LICENSE](https://github.com/0xMiden/web-sdk/blob/main/LICENSE) file for details.
