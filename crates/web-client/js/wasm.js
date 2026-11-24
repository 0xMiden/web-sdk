// This is a documented workaround that should avoid issues with Vite projects
// https://github.com/wasm-tool/rollup-plugin-rust?tab=readme-ov-file#usage-with-vite
// Also, this effectively disables SSR.
//
// `moduleOrPath` overrides the Cargo glue's `__wasm_url`. The classic worker
// build rewrites `import.meta.url` → `self.location.href`, so its own
// `__wasm_url` points at an unhashed path relative to the worker script and
// 404s after Vite/webpack hash the asset (#286). Resolve the URL on the main
// thread (where `import.meta.url` stays bundler-traceable) and pass it in.
async function loadWasm(moduleOrPath) {
  let wasmModule;
  if (!import.meta.env || (import.meta.env && !import.meta.env.SSR)) {
    wasmModule = await import("../Cargo.toml");
    // The Cargo glue's __wbg_init TLA is stripped by the rollup build to
    // prevent blocking WKWebView module evaluation. Call it explicitly here
    // with the WASM URL that the Cargo glue pre-resolves (relative to its
    // own import.meta.url, which downstream bundlers handle correctly), or
    // with a caller-supplied URL for the classic-worker path.
    if (wasmModule && typeof wasmModule.__wbg_init === "function") {
      await wasmModule.__wbg_init({
        // eslint-disable-next-line camelcase -- wasm-bindgen init API parameter name
        module_or_path: moduleOrPath ?? wasmModule.__wasm_url,
      });
    }
  }
  return wasmModule;
}

/**
 * Resolve the emitted WASM asset URL on the current thread.
 *
 * Must run where `import.meta.url` is still bundler-traceable (main thread /
 * module worker), not inside the classic worker IIFE.
 *
 * @returns {Promise<URL | string | undefined>}
 */
async function resolveWasmUrl() {
  if (import.meta.env && import.meta.env.SSR) {
    return undefined;
  }
  const wasmModule = await import("../Cargo.toml");
  return wasmModule.__wasm_url;
}

export { resolveWasmUrl };
export default loadWasm;
