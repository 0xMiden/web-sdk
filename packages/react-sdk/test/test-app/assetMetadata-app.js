import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MidenProvider, useAssetMetadata, useMiden } from "@miden-sdk/react";
import { WebClient, MockWebClient } from "@miden-sdk/miden-sdk";

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

// -- Patch WebClient to use the in-memory mock --------------------------------
const patchWebClient = () => {
  if (typeof WebClient?.createClient === "function") {
    WebClient.createClient = MockWebClient.createClient.bind(MockWebClient);
  }
};

// -- Load full WASM SDK exports onto window -----------------------------------
const initSdk = async () => {
  try {
    const sdkExports = await import("@miden-sdk/miden-sdk");
    for (const [key, value] of Object.entries(sdkExports)) {
      window[key] = value;
    }
    window.sdkLoaded = true;
  } catch (err) {
    window.sdkLoadError = err?.message ?? String(err);
  }
};

// -- Reads optional ?rpcUrl=<network> query parameter ------------------------
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
const Harness = () => {
  const { isReady } = useMiden();
  const [assetIds, setAssetIds] = React.useState([]);
  const { assetMetadata } = useAssetMetadata(assetIds);

  useEffect(() => {
    if (isReady) {
      window.reactSdkReady = true;
    }
  }, [isReady]);

  // Expose control API for tests
  useEffect(() => {
    window.__assetMetadata = {
      setAssetIds: (ids) => {
        setAssetIds(ids);
      },
      getMetadata: (assetId) => {
        const meta = assetMetadata.get(assetId);
        if (!meta) return null;
        return {
          assetId: meta.assetId,
          symbol: meta.symbol ?? null,
          decimals: meta.decimals ?? null,
        };
      },
      getMetadataMap: () => {
        const result = {};
        for (const [key, value] of assetMetadata.entries()) {
          result[key] = {
            assetId: value.assetId,
            symbol: value.symbol ?? null,
            decimals: value.decimals ?? null,
          };
        }
        return result;
      },
    };
  }, [assetMetadata]);

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
