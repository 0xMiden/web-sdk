// Guards the positional wiring of `ClientOptions.debugMode` from `MidenClient.create()` down to
// the WASM `createClient` / `createClientWithExternalKeystore` constructors.
//
// The flag travels through a long positional argument list on both constructors. A dropped or
// shifted argument does not fail to compile and does not fail any type check — it just silently
// leaves debug mode off, so `debug.*` MASM output never appears. The end-to-end Playwright test
// (test/debug_output.test.ts) covers the real behavior but needs a live node; these assertions
// pin the argument positions cheaply.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MidenClient } from "../client.js";

// Positions per crates/web-client/js/index.js, which mirror the wasm-bindgen signatures in
// dist/st/crates/miden_client_web.d.ts.
const CREATE_DEBUG_MODE_INDEX = 4;
const EXTERNAL_KEYSTORE_DEBUG_MODE_INDEX = 7;

describe("MidenClient.create debugMode wiring", () => {
  let createClient;
  let createClientWithExternalKeystore;
  let savedWasmWebClient;
  let savedGetWasm;

  beforeEach(() => {
    createClient = vi.fn().mockResolvedValue({});
    createClientWithExternalKeystore = vi.fn().mockResolvedValue({});

    savedWasmWebClient = MidenClient._WasmWebClient;
    savedGetWasm = MidenClient._getWasmOrThrow;

    MidenClient._WasmWebClient = {
      createClient,
      createClientWithExternalKeystore,
    };
    // createDevnet/createTestnet default a proverUrl, which resolves through the wasm module.
    MidenClient._getWasmOrThrow = vi.fn().mockResolvedValue({
      TransactionProver: { newRemoteProver: vi.fn().mockReturnValue({}) },
    });
  });

  afterEach(() => {
    MidenClient._WasmWebClient = savedWasmWebClient;
    MidenClient._getWasmOrThrow = savedGetWasm;
  });

  it("forwards debugMode: true to createClient in the expected position", async () => {
    await MidenClient.create({ rpcUrl: "devnet", debugMode: true });
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient.mock.calls[0][CREATE_DEBUG_MODE_INDEX]).toBe(true);
  });

  it("forwards debugMode: false rather than coercing it to undefined", async () => {
    await MidenClient.create({ rpcUrl: "devnet", debugMode: false });
    expect(createClient.mock.calls[0][CREATE_DEBUG_MODE_INDEX]).toBe(false);
  });

  it("leaves debugMode undefined when the option is omitted", async () => {
    await MidenClient.create({ rpcUrl: "devnet" });
    expect(createClient.mock.calls[0][CREATE_DEBUG_MODE_INDEX]).toBeUndefined();
  });

  it("forwards debugMode on the external-keystore path in the expected position", async () => {
    const keystore = {
      getKey: vi.fn(),
      insertKey: vi.fn(),
      sign: vi.fn(),
    };
    await MidenClient.create({ rpcUrl: "devnet", debugMode: true, keystore });
    expect(createClientWithExternalKeystore).toHaveBeenCalledOnce();
    expect(createClient).not.toHaveBeenCalled();
    expect(
      createClientWithExternalKeystore.mock.calls[0][
        EXTERNAL_KEYSTORE_DEBUG_MODE_INDEX
      ]
    ).toBe(true);
  });

  it("does not displace the keystore callbacks that precede debugMode", async () => {
    const keystore = {
      getKey: vi.fn(),
      insertKey: vi.fn(),
      sign: vi.fn(),
    };
    await MidenClient.create({ rpcUrl: "devnet", debugMode: true, keystore });
    const args = createClientWithExternalKeystore.mock.calls[0];
    expect(args[4]).toBe(keystore.getKey);
    expect(args[5]).toBe(keystore.insertKey);
    expect(args[6]).toBe(keystore.sign);
  });

  it("forwards debugMode through createDevnet's option defaults", async () => {
    await MidenClient.createDevnet({ debugMode: true, autoSync: false });
    expect(createClient.mock.calls[0][CREATE_DEBUG_MODE_INDEX]).toBe(true);
  });
});
