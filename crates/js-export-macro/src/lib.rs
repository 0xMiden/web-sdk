//! Proc macro that generates dual `wasm_bindgen`/`napi` annotations from a single attribute.
//!
//! # Usage
//!
//! ```ignore
//! #[js_export]                          // bare — applies to struct/enum/impl
//! #[js_export(constructor)]             // forwarded to both wasm_bindgen & napi
//! #[js_export(js_name = "foo")]         // forwarded to both
//! #[js_export(getter, js_name = "x")]   // forwarded to both
//! ```
//!
//! When a method signature contains [`JsU64`], the macro automatically splits it
//! into browser (`::js_sys::BigInt` arguments, `u64` returns) and Node.js
//! (`::napi::bindgen_prelude::BigInt`) variants. Both map to JavaScript `BigInt`, preserving
//! full `u64` precision on both platforms; pass arguments through `js_u64_to_u64` to reject
//! values outside `0..2^64`.
//!
//! # Expansion example (JsU64 split)
//!
//! A method with `JsU64` in its signature:
//!
//! ```ignore
//! #[js_export]
//! impl Felt {
//!     #[js_export(constructor)]
//!     pub fn new(value: JsU64) -> Result<Felt, JsErr> { ... }
//! }
//! ```
//!
//! expands to one impl block per platform, with `JsU64` replaced by the concrete type:
//!
//! ```ignore
//! #[cfg(feature = "browser")]
//! #[::wasm_bindgen::prelude::wasm_bindgen]
//! impl Felt {
//!     #[::wasm_bindgen::prelude::wasm_bindgen(constructor)]
//!     pub fn new(value: ::js_sys::BigInt) -> Result<Felt, JsErr> { ... }
//! }
//!
//! #[cfg(feature = "nodejs")]
//! #[::napi_derive::napi]
//! impl Felt {
//!     #[::napi_derive::napi(constructor)]
//!     pub fn new(value: ::napi::bindgen_prelude::BigInt) -> Result<Felt, JsErr> { ... }
//! }
//! ```
//!
//! Methods without `JsU64` stay in a single impl block with `#[cfg_attr]` forwarding
//! the platform-specific macro.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::visit_mut::VisitMut;
use syn::{ImplItem, ImplItemFn, Item, ItemEnum, ItemImpl, ItemStruct, parse_macro_input};

// ================================================================================================
// Entry point
// ================================================================================================

#[proc_macro_attribute]
pub fn js_export(attr: TokenStream, item: TokenStream) -> TokenStream {
    let attr: TokenStream2 = attr.into();
    let item = parse_macro_input!(item as Item);

    let output = match item {
        Item::Struct(s) => handle_struct(&attr, s),
        Item::Enum(e) => handle_enum(&attr, e),
        Item::Impl(i) => handle_impl(&attr, i),
        other => {
            return syn::Error::new_spanned(other, "#[js_export] only supports struct, enum, impl")
                .to_compile_error()
                .into();
        },
    };

    output.into()
}

// ================================================================================================
// Struct / Enum handlers
// ================================================================================================

fn handle_struct(attr: &TokenStream2, item: ItemStruct) -> TokenStream2 {
    let wasm = wasm_attr(attr);
    let napi = napi_attr(attr);

    // item already contains its own attributes (like #[derive(Clone)]),
    // so we just prepend the platform attrs.
    quote! {
        #wasm
        #napi
        #item
    }
}

fn handle_enum(attr: &TokenStream2, item: ItemEnum) -> TokenStream2 {
    let wasm = wasm_attr(attr);
    let napi = napi_attr(attr);

    quote! {
        #wasm
        #napi
        #item
    }
}

// ================================================================================================
// Impl block handler
// ================================================================================================

struct JsU64Method {
    method: ImplItemFn,
    export_args: TokenStream2,
}

fn handle_impl(outer_attr: &TokenStream2, mut item: ItemImpl) -> TokenStream2 {
    let self_ty = &item.self_ty;
    let generics = &item.generics;

    // Partition methods into:
    // - shared methods, which can stay in one cfg-gated impl block
    // - JsU64 methods, which need platform-specific signatures generated later
    let mut shared_methods: Vec<ImplItemFn> = Vec::new();
    let mut jsu64_methods: Vec<JsU64Method> = Vec::new();
    let mut other_items: Vec<ImplItem> = Vec::new(); // const, type, etc.

    for member in item.items.drain(..) {
        match member {
            ImplItem::Fn(mut method) => {
                // Strip #[js_export(...)] from the method before rebuilding the export attrs.
                // Impl-level export attrs are added on the enclosing impl block, while
                // method-level args (constructor, getter, js_name, etc.) are re-emitted on
                // the generated method items below.
                let method_attr = extract_js_export_attr(&mut method);
                let method_attr_tokens = method_attr.unwrap_or_default();

                if has_jsu64(&method) {
                    // JsU64 maps to different JS-facing Rust types on each platform, so these
                    // methods cannot stay in the shared impl block; `make_platform_method`
                    // rebuilds them as browser/node-specific clones.
                    jsu64_methods.push(JsU64Method { method, export_args: method_attr_tokens });
                } else {
                    // Annotate the method inline with dual cfg_attr.
                    let wasm = wasm_attr(&method_attr_tokens);
                    let napi = napi_attr(&method_attr_tokens);
                    method.attrs.push(syn::parse_quote!(#wasm));
                    method.attrs.push(syn::parse_quote!(#napi));
                    shared_methods.push(method);
                }
            },
            other => other_items.push(other),
        }
    }

    let mut output = TokenStream2::new();

    // --- Shared impl block (methods without JsU64) ---
    if !shared_methods.is_empty() || !other_items.is_empty() {
        let wasm_outer = wasm_attr(outer_attr);
        let napi_outer = napi_attr(outer_attr);
        output.extend(quote! {
            #wasm_outer
            #napi_outer
            impl #generics #self_ty {
                #(#other_items)*
                #(#shared_methods)*
            }
        });
    }

    // --- Platform-specific impl blocks (methods with JsU64) ---
    if !jsu64_methods.is_empty() {
        let browser_methods: Vec<ImplItemFn> = jsu64_methods
            .iter()
            .map(|m| make_platform_method(&m.method, &m.export_args, Platform::Browser))
            .collect();
        let nodejs_methods: Vec<ImplItemFn> = jsu64_methods
            .iter()
            .map(|m| make_platform_method(&m.method, &m.export_args, Platform::Nodejs))
            .collect();

        output.extend(quote! {
            #[cfg(feature = "browser")]
            #[::wasm_bindgen::prelude::wasm_bindgen]
            impl #generics #self_ty {
                #(#browser_methods)*
            }

            #[cfg(feature = "nodejs")]
            #[::napi_derive::napi]
            impl #generics #self_ty {
                #(#nodejs_methods)*
            }
        });
    }

    output
}

// ================================================================================================
// Platform-specific method generation
// ================================================================================================

#[derive(Clone, Copy)]
enum Platform {
    Browser,
    Nodejs,
}

fn make_platform_method(
    method: &ImplItemFn,
    args: &TokenStream2,
    platform: Platform,
) -> ImplItemFn {
    // Clone once per platform so both generated variants start from the same source method.
    let mut method = method.clone();

    // Apply the original method-level export args to each platform-specific clone.
    match platform {
        Platform::Browser => {
            if args.is_empty() {
                method.attrs.push(syn::parse_quote!(#[::wasm_bindgen::prelude::wasm_bindgen]));
            } else {
                method
                    .attrs
                    .push(syn::parse_quote!(#[::wasm_bindgen::prelude::wasm_bindgen(#args)]));
            }
        },
        Platform::Nodejs => {
            if args.is_empty() {
                method.attrs.push(syn::parse_quote!(#[::napi_derive::napi]));
            } else {
                method.attrs.push(syn::parse_quote!(#[::napi_derive::napi(#args)]));
            }
        },
    }

    // Replace JsU64 in signature with the platform-specific concrete type.
    // Browser arguments use `js_sys::BigInt` so the range can be checked (a bare `u64`
    // argument is silently reduced modulo 2^64 by wasm_bindgen); a `Vec<JsU64>` argument stays
    // `Vec<u64>` (a `BigUint64Array`, which cannot hold an out-of-range element), and return
    // values stay `u64`. Node.js uses napi's `BigInt` struct because napi-rs does not implement
    // `FromNapiValue` for `u64`. All resolve to a JS `BigInt` on the JS side.
    let (arg_replacement, ret_replacement): (syn::Path, syn::Path) = match platform {
        Platform::Browser => (syn::parse_quote!(::js_sys::BigInt), syn::parse_quote!(u64)),
        Platform::Nodejs => {
            let big: syn::Path = syn::parse_quote!(::napi::bindgen_prelude::BigInt);
            (big.clone(), big)
        },
    };
    let mut replacer = JsU64Replacer {
        replacement: arg_replacement,
        ret_replacement,
        vec_replacement: match platform {
            Platform::Browser => Some(syn::parse_quote!(u64)),
            Platform::Nodejs => None,
        },
        in_return: false,
    };
    replacer.visit_impl_item_fn_mut(&mut method);

    method
}

// ================================================================================================
// JsU64 detection
// ================================================================================================

fn has_jsu64(method: &ImplItemFn) -> bool {
    let mut detector = JsU64Detector { found: false };
    // Check params.
    for arg in &method.sig.inputs {
        if let syn::FnArg::Typed(pat_type) = arg {
            let mut ty = (*pat_type.ty).clone();
            detector.visit_type_mut(&mut ty);
        }
    }
    // Check return type.
    if let syn::ReturnType::Type(_, ty) = &method.sig.output {
        let mut ty = (**ty).clone();
        detector.visit_type_mut(&mut ty);
    }
    detector.found
}

struct JsU64Detector {
    found: bool,
}

impl VisitMut for JsU64Detector {
    fn visit_type_path_mut(&mut self, tp: &mut syn::TypePath) {
        if tp.path.is_ident("JsU64") {
            self.found = true;
        }
        syn::visit_mut::visit_type_path_mut(self, tp);
    }
}

// ================================================================================================
// JsU64 replacement (only in method signature, NOT in body)
// ================================================================================================

struct JsU64Replacer {
    /// Replacement for `JsU64` in argument position.
    replacement: syn::Path,
    /// Replacement for `JsU64` in the return type.
    ret_replacement: syn::Path,
    /// When set, replacement for the element type of a `Vec<JsU64>` argument.
    vec_replacement: Option<syn::Path>,
    in_return: bool,
}

impl JsU64Replacer {
    fn is_jsu64(ty: &syn::Type) -> bool {
        matches!(ty, syn::Type::Path(tp) if tp.path.is_ident("JsU64"))
    }

    /// Returns the sole type argument of a `Vec<_>` path.
    fn vec_elem_mut(tp: &mut syn::TypePath) -> Option<&mut syn::Type> {
        let last = tp.path.segments.last_mut()?;
        if last.ident != "Vec" {
            return None;
        }
        let syn::PathArguments::AngleBracketed(args) = &mut last.arguments else {
            return None;
        };
        let mut it = args.args.iter_mut();
        match (it.next(), it.next()) {
            (Some(syn::GenericArgument::Type(ty)), None) => Some(ty),
            _ => None,
        }
    }
}

impl VisitMut for JsU64Replacer {
    fn visit_impl_item_fn_mut(&mut self, method: &mut ImplItemFn) {
        // Only visit the signature, NOT the body.
        self.in_return = false;
        for arg in &mut method.sig.inputs {
            self.visit_fn_arg_mut(arg);
        }
        self.in_return = true;
        self.visit_return_type_mut(&mut method.sig.output);
        // Deliberately skip: self.visit_block_mut(&mut method.block);
    }

    fn visit_type_path_mut(&mut self, tp: &mut syn::TypePath) {
        if tp.path.is_ident("JsU64") {
            tp.path = if self.in_return {
                self.ret_replacement.clone()
            } else {
                self.replacement.clone()
            };
        } else if !self.in_return
            && let Some(vec_replacement) = self.vec_replacement.clone()
            && let Some(inner) = Self::vec_elem_mut(tp)
            && Self::is_jsu64(inner)
        {
            *inner = syn::Type::Path(syn::TypePath { qself: None, path: vec_replacement });
            return;
        }
        syn::visit_mut::visit_type_path_mut(self, tp);
    }
}

// ================================================================================================
// Attribute helpers
// ================================================================================================

/// Build `#[cfg_attr(feature = "browser", ::wasm_bindgen::prelude::wasm_bindgen(...))]`
fn wasm_attr(args: &TokenStream2) -> TokenStream2 {
    if args.is_empty() {
        quote! { #[cfg_attr(feature = "browser", ::wasm_bindgen::prelude::wasm_bindgen)] }
    } else {
        quote! { #[cfg_attr(feature = "browser", ::wasm_bindgen::prelude::wasm_bindgen(#args))] }
    }
}

/// Build `#[cfg_attr(feature = "nodejs", ::napi_derive::napi(...))]`
fn napi_attr(args: &TokenStream2) -> TokenStream2 {
    if args.is_empty() {
        quote! { #[cfg_attr(feature = "nodejs", ::napi_derive::napi)] }
    } else {
        quote! { #[cfg_attr(feature = "nodejs", ::napi_derive::napi(#args))] }
    }
}

/// Extract and remove a `#[js_export(...)]` attribute from a method, returning its args.
fn extract_js_export_attr(method: &mut ImplItemFn) -> Option<TokenStream2> {
    let mut extracted = None;
    method.attrs.retain(|attr| {
        if attr.path().is_ident("js_export") {
            extracted = Some(match &attr.meta {
                syn::Meta::Path(_) => TokenStream2::new(),
                syn::Meta::List(list) => list.tokens.clone(),
                syn::Meta::NameValue(_) => TokenStream2::new(),
            });
            false
        } else {
            true
        }
    });
    extracted
}
