import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  MidenProvider,
  useMiden,
  toBech32AccountId,
  installAccountBech32,
  ensureAccountBech32,
} from "@miden-sdk/react";
import { WasmWebClient, MockWebClient } from "@miden-sdk/miden-sdk";

// -- Initial status flags (polled by the test) --------------------------------
window.testAppError = null;
window.sdkLoaded = false;
window.sdkLoadError = null;
window.reactSdkReady = false;

window.addEventListener("error", (event) => {
  const message = event?.error?.message ?? event?.message ?? "Unknown error";
  window.testAppError = JSON.stringify({
    message,
    filename: event?.filename ?? null,
    line: event?.lineno ?? null,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const message =
    event?.reason?.message ?? event?.reason ?? "Unhandled rejection";
  window.testAppError = JSON.stringify({
    message,
    stack: event?.reason?.stack ?? null,
  });
});

// -- Patch WasmWebClient to use the in-memory mock ----------------------------
// We must patch the JS-level wrapper (`WasmWebClient`) — the one MidenProvider
// imports as `WasmWebClient as WebClient`. The bare `WebClient` export is the
// wasm-bindgen low-level class and only has an INSTANCE createClient, so
// patching that one is a no-op and lets MidenProvider hit a real RPC call.
//
// We deliberately drop all args because `MockWebClient.createClient` has a
// different signature (`(serializedMockChain, ..., seed, logLevel)`) than
// `WasmWebClient.createClient` (`(rpcUrl, noteTransportUrl, seed, ...)`).
// Passing the rpcUrl through would feed it into `serializedMockChain` which
// expects a Uint8Array — wasm-bindgen would crash. The tests don't need the
// real rpcUrl on the client; they exercise inferNetworkId() via the store's
// config.rpcUrl which MidenProvider sets independently of createClient.
const patchWebClient = () => {
  WasmWebClient.createClient = () => MockWebClient.createClient();
};

// -- Load full WASM SDK exports onto window -----------------------------------
const initSdk = async () => {
  try {
    const sdkExports = await import("@miden-sdk/miden-sdk");
    for (const [key, value] of Object.entries(sdkExports)) {
      window[key] = value;
    }
    // Restore the WASM AuthScheme enum (the JS API shadows it with a
    // simplified "falcon"/"ecdsa" string map that wasm-bindgen rejects with
    // "invalid enum value passed"). Mirrors the workaround in
    // crates/web-client/test/test-setup.ts and the equivalent in index.html.
    const wasm = await window.getWasmOrThrow();
    window.AuthScheme = wasm.AuthScheme;
    window.sdkLoaded = true;
  } catch (err) {
    window.sdkLoadError = err?.message ?? String(err);
  }
};

// -- Expose bech32 utilities on window ----------------------------------------
// Exposed immediately so tests can call them at any time.
window.__bech32 = {
  toBech32AccountId,
  installAccountBech32,
  ensureAccountBech32,
};

// -- Reads optional ?rpcUrl=<network> query parameter ------------------------
// Allows a single HTML page to exercise different inferNetworkId() branches.
const getConfigFromQuery = () => {
  try {
    const params = new URLSearchParams(window.location.search);
    const rpcUrl = params.get("rpcUrl");
    return rpcUrl ? { rpcUrl, autoSyncInterval: 0 } : { autoSyncInterval: 0 };
  } catch {
    return { autoSyncInterval: 0 };
  }
};

// -- React harness ------------------------------------------------------------
// Sets reactSdkReady=true only once MidenProvider reports isReady=true.
// This guarantees the store's config has been populated (setConfig is called
// before setClient inside MidenProvider's initClient effect).
const Harness = () => {
  const { isReady } = useMiden();

  useEffect(() => {
    if (isReady) {
      window.reactSdkReady = true;
    }
  }, [isReady]);

  return null;
};

const App = () =>
  React.createElement(
    MidenProvider,
    { config: getConfigFromQuery() },
    React.createElement(Harness, null)
  );

patchWebClient();
initSdk();

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(App, null));
