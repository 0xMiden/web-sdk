import { describe, expect, it, vi } from "vitest";

// Only the binary boundary is mocked: the real browser and Node entries wrap
// these stand-ins. Both stand-ins refuse a value that is not one of their
// AuthScheme values, as the wasm-bindgen and napi enum conversions do, and
// record what they were handed.
const fakes = vi.hoisted(() => {
  const received = [];
  const checkScheme = (scheme) => {
    if (scheme !== 1 && scheme !== 2) {
      throw new Error("invalid enum value passed");
    }
    received.push(scheme);
  };
  const makeConfig = () =>
    class AuthGuardedMultisigConfig {
      constructor(approvers, defaultThreshold, guardian, authScheme) {
        checkScheme(authScheme);
      }
      withProcThresholds() {
        return new AuthGuardedMultisigConfig([], 1, null, 2);
      }
    };

  // wasm-bindgen: a frozen enum with reverse mappings, writable statics.
  const BrowserConfig = makeConfig();
  class BrowserAccountComponent {
    static createAuthComponentFromCommitment(commitment, authScheme) {
      checkScheme(authScheme);
      return "component";
    }
  }
  const browserWasm = {
    AuthScheme: Object.freeze({
      AuthEcdsaK256Keccak: 1,
      1: "AuthEcdsaK256Keccak",
      AuthRpoFalcon512: 2,
      2: "AuthRpoFalcon512",
    }),
    AuthGuardedMultisigConfig: BrowserConfig,
    AccountComponent: BrowserAccountComponent,
  };

  // napi: an enum whose members are not enumerable, and frozen statics.
  const NodeConfig = makeConfig();
  class NodeAccountComponent {}
  Object.defineProperty(
    NodeAccountComponent,
    "createAuthComponentFromCommitment",
    {
      value: (commitment, authScheme) => {
        checkScheme(authScheme);
        return "component";
      },
      writable: false,
      configurable: false,
    }
  );
  const nodeNative = {
    AuthScheme: Object.defineProperties(
      {},
      {
        AuthEcdsaK256Keccak: { value: 1 },
        AuthRpoFalcon512: { value: 2 },
      }
    ),
    AuthGuardedMultisigConfig: NodeConfig,
    AccountComponent: NodeAccountComponent,
  };

  return { received, browserWasm, nodeNative };
});

vi.mock("../../Cargo.toml", () => fakes.browserWasm);
vi.mock("../wasm.js", () => ({
  default: async () => fakes.browserWasm,
  resolveWasmUrl: async () => undefined,
}));
vi.mock("../node/loader.js", () => ({
  loadNativeModule: () => fakes.nodeNative,
}));

import * as browser from "../index.js";
import * as node from "../node-index.js";

await browser.getWasmOrThrow();

const lastReceived = () => fakes.received.at(-1);
const word = {};

describe.each([
  ["browser", browser, fakes.browserWasm],
  ["Node", node, fakes.nodeNative],
])("%s entry", (_name, sdk, native) => {
  it.each([
    ["AuthScheme.ECDSA", () => sdk.AuthScheme.ECDSA, 1],
    ["AuthScheme.Falcon", () => sdk.AuthScheme.Falcon, 2],
    ["the native ECDSA value", () => native.AuthScheme.AuthEcdsaK256Keccak, 1],
    ["the native Falcon value", () => native.AuthScheme.AuthRpoFalcon512, 2],
  ])(
    "new AuthGuardedMultisigConfig hands the native constructor %s as its enum value",
    (_label, scheme, expected) => {
      const config = new sdk.AuthGuardedMultisigConfig(
        [word],
        1,
        word,
        scheme()
      );
      expect(lastReceived()).toBe(expected);
      expect(config).toBeInstanceOf(native.AuthGuardedMultisigConfig);
      expect(config).toBeInstanceOf(sdk.AuthGuardedMultisigConfig);
    }
  );

  it("keeps the native prototype, so method results are instances too", () => {
    const config = new sdk.AuthGuardedMultisigConfig([word], 1, word, "ecdsa");
    expect(sdk.AuthGuardedMultisigConfig.prototype).toBe(
      native.AuthGuardedMultisigConfig.prototype
    );
    expect(config.withProcThresholds()).toBeInstanceOf(
      sdk.AuthGuardedMultisigConfig
    );
  });

  it.each([undefined, null])(
    "new AuthGuardedMultisigConfig rejects a missing scheme (%s) instead of defaulting to Falcon",
    (scheme) => {
      const before = fakes.received.length;
      expect(
        () => new sdk.AuthGuardedMultisigConfig([word], 1, word, scheme)
      ).toThrow(
        new TypeError(
          'AuthGuardedMultisigConfig requires an auth scheme: AuthScheme.ECDSA ("ecdsa") or AuthScheme.Falcon ("falcon").'
        )
      );
      expect(fakes.received.length).toBe(before);
    }
  );

  it.each([
    ["rsa", 'Unknown auth scheme: "rsa". Expected "falcon" or "ecdsa".'],
    [99, 'Unknown auth scheme: "99". Expected "falcon" or "ecdsa".'],
  ])("new AuthGuardedMultisigConfig rejects %s", (scheme, message) => {
    expect(
      () => new sdk.AuthGuardedMultisigConfig([word], 1, word, scheme)
    ).toThrow(message);
  });

  it("AuthGuardedMultisigConfig still requires new", () => {
    expect(() =>
      sdk.AuthGuardedMultisigConfig([word], 1, word, "falcon")
    ).toThrow(TypeError);
  });

  it.each([
    ["AuthScheme.ECDSA", () => sdk.AuthScheme.ECDSA, 1],
    ["AuthScheme.Falcon", () => sdk.AuthScheme.Falcon, 2],
    ["the native ECDSA value", () => native.AuthScheme.AuthEcdsaK256Keccak, 1],
  ])(
    "AccountComponent.createAuthComponentFromCommitment hands the native static %s as its enum value",
    (_label, scheme, expected) => {
      expect(
        sdk.AccountComponent.createAuthComponentFromCommitment(word, scheme())
      ).toBe("component");
      expect(lastReceived()).toBe(expected);
    }
  );

  it("AccountComponent.createAuthComponentFromCommitment rejects a missing scheme", () => {
    expect(() =>
      sdk.AccountComponent.createAuthComponentFromCommitment(word)
    ).toThrow(
      new TypeError(
        'AccountComponent.createAuthComponentFromCommitment requires an auth scheme: AuthScheme.ECDSA ("ecdsa") or AuthScheme.Falcon ("falcon").'
      )
    );
  });
});

it("Node keeps the wrapper as the constructor its instances report", () => {
  const config = new node.AuthGuardedMultisigConfig([word], 1, word, "falcon");
  expect(config.constructor).toBe(node.AuthGuardedMultisigConfig);
});
