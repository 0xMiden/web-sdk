import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../Cargo.toml", () => ({}));

const RESOLVED_WASM_URL =
  "https://cdn.example/assets/miden_client_web-AbCdEf.wasm";

vi.mock("../wasm.js", () => ({
  default: async (moduleOrPath) => ({
    resolveStoreName: (_nodeUrl, storeName) => storeName,
    // wasm-bindgen export name
    // eslint-disable-next-line camelcase -- matches Cargo glue __wasm_url
    __wasm_url: RESOLVED_WASM_URL,
    __initPath: moduleOrPath ?? RESOLVED_WASM_URL,
  }),
  resolveWasmUrl: async () => RESOLVED_WASM_URL,
}));

import { WasmWebClient } from "../index.js";
import { WorkerAction } from "../constants.js";

const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

describe("classic worker WASM URL (#286)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    WasmWebClient.workerMode = "auto";
  });

  async function captureInit({ workerMode, userAgent }) {
    WasmWebClient.workerMode = workerMode;
    const posted = [];
    let onMessage;
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener(type, listener) {
          if (type === "message") onMessage = listener;
        }
        postMessage(message) {
          posted.push(message);
        }
        terminate() {}
      }
    );
    vi.stubGlobal("navigator", { userAgent });

    new WasmWebClient("rpc", "transport", undefined, "store");
    await onMessage({ data: { loaded: true } });
    await vi.waitFor(() => {
      expect(posted.some((m) => m.action === WorkerAction.INIT)).toBe(true);
    });
    return posted.find((m) => m.action === WorkerAction.INIT);
  }

  it("passes the main-thread resolved WASM URL on classic INIT", async () => {
    const init = await captureInit({
      workerMode: "classic",
      userAgent: SAFARI_UA,
    });
    expect(init.args[13]).toBe(RESOLVED_WASM_URL);
  });

  it("omits the WASM URL override on module INIT", async () => {
    const init = await captureInit({
      workerMode: "module",
      userAgent: CHROME_UA,
    });
    expect(init.args[13]).toBeUndefined();
  });

  it("auto mode on Safari UA passes the WASM URL", async () => {
    const init = await captureInit({
      workerMode: "auto",
      userAgent: SAFARI_UA,
    });
    expect(init.args[13]).toBe(RESOLVED_WASM_URL);
  });

  it("auto mode on Chrome UA omits the WASM URL", async () => {
    const init = await captureInit({
      workerMode: "auto",
      userAgent: CHROME_UA,
    });
    expect(init.args[13]).toBeUndefined();
  });
});
