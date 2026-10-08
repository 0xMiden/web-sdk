import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MidenClient } from "../client.js";

// `js/index.js` re-exports the wasm-bindgen surface from "../Cargo.toml", which
// the node test environment cannot parse. The WebClient wrapper reads the wasm
// module through `loadWasm`, stubbed here with the AuthScheme enum in the shape
// wasm-bindgen emits (each value also maps back to its name).
const wasmModule = vi.hoisted(() => ({
  AuthScheme: Object.freeze({
    AuthEcdsaK256Keccak: 1,
    1: "AuthEcdsaK256Keccak",
    AuthRpoFalcon512: 2,
    2: "AuthRpoFalcon512",
  }),
}));
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({ default: async () => wasmModule }));

import {
  WasmWebClient,
  __createClientProxyForTest as createClientProxy,
} from "../index.js";

// `MidenClient` is constructible without a real WASM module as long as the test
// supplies the two things its constructor takes: the proxied inner client and a
// `getWasm` thunk. The resource classes it builds are covered separately under
// `__tests__/resources/`; what is exercised here is the client's own surface.

const makeWasm = () => ({
  AccountId: {
    fromHex: vi.fn((hex) => ({ kind: "fromHex", hex, toString: () => hex })),
    fromBech32: vi.fn((b32) => ({
      kind: "fromBech32",
      bech32: b32,
      toString: () => b32,
    })),
  },
});

const makeClient = (innerOverrides = {}) => {
  const wasm = makeWasm();
  const inner = {
    feeAwareTransactionRequestBuilder: vi
      .fn()
      .mockResolvedValue({ kind: "builder" }),
    storeIdentifier: vi.fn().mockResolvedValue("store"),
    ...innerOverrides,
  };
  const client = new MidenClient(inner, async () => wasm, null);
  return { client, inner, wasm };
};

describe("MidenClient.feeAwareTransactionRequestBuilder", () => {
  let client;
  let inner;
  let wasm;

  beforeEach(() => {
    ({ client, inner, wasm } = makeClient());
  });

  it("returns the builder the inner client produced", async () => {
    await expect(
      client.feeAwareTransactionRequestBuilder("0xabc")
    ).resolves.toEqual({ kind: "builder" });
  });

  // Every documented call form goes through `resolveAccountRef`. Without it the
  // hex/bech32/Account forms reach the WASM boundary unparsed, which is what the
  // README, the narrative docs and the CHANGELOG all show a consumer passing.
  it("parses a hex string into an AccountId", async () => {
    await client.feeAwareTransactionRequestBuilder("0xabc");
    expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0xabc");
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "fromHex", hex: "0xabc" }),
      undefined,
      undefined,
      undefined
    );
  });

  it("parses a bech32 string into an AccountId", async () => {
    await client.feeAwareTransactionRequestBuilder("mtst1qabc");
    expect(wasm.AccountId.fromBech32).toHaveBeenCalledWith("mtst1qabc");
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "fromBech32", bech32: "mtst1qabc" }),
      undefined,
      undefined,
      undefined
    );
  });

  it("resolves an Account through its id()", async () => {
    const id = { toString: () => "0xfromAccount" };
    const account = { id: vi.fn(() => id) };
    await client.feeAwareTransactionRequestBuilder(account);
    expect(account.id).toHaveBeenCalled();
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      id,
      undefined,
      undefined,
      undefined
    );
  });

  it("passes an AccountId through untouched", async () => {
    const accountId = { toString: () => "0xalready" };
    await client.feeAwareTransactionRequestBuilder(accountId);
    expect(wasm.AccountId.fromHex).not.toHaveBeenCalled();
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      accountId,
      undefined,
      undefined,
      undefined
    );
  });

  it("rejects a nullish account rather than passing null into WASM", async () => {
    await expect(
      client.feeAwareTransactionRequestBuilder(undefined)
    ).rejects.toThrow(/cannot be null or undefined/i);
    expect(inner.feeAwareTransactionRequestBuilder).not.toHaveBeenCalled();
  });

  // Every multisig override is off unless asked for: the cases above pin the
  // `undefined`s that mean "SDK default", these pin that each option reaches the
  // WASM boundary unchanged, in its own positional slot.
  it("forwards an approval expiration delta", async () => {
    const accountId = { kind: "accountId" };
    await client.feeAwareTransactionRequestBuilder(accountId, {
      approvalExpirationDelta: 100,
    });
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      accountId,
      100,
      undefined,
      undefined
    );
  });

  // The two a co-signer needs to reproduce a proposal rather than receive it.
  it("forwards the salt and bound block a co-signer must agree on", async () => {
    const accountId = { kind: "accountId" };
    const salt = { kind: "word" };
    await client.feeAwareTransactionRequestBuilder(accountId, {
      feeConversionSalt: salt,
      boundBlockNum: 42,
    });
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      accountId,
      undefined,
      salt,
      42
    );
  });

  it("throws once terminated", async () => {
    client.terminate();
    await expect(
      client.feeAwareTransactionRequestBuilder("0xabc")
    ).rejects.toThrow("Client terminated");
    expect(inner.feeAwareTransactionRequestBuilder).not.toHaveBeenCalled();
  });
});

describe("WebClient AuthScheme resolution", () => {
  let client;
  let inner;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    inner = {
      newWallet: vi.fn().mockResolvedValue("wallet"),
      newFaucet: vi.fn().mockResolvedValue("faucet"),
      importPublicAccountFromSeed: vi.fn().mockResolvedValue("account"),
    };
    const instance = new WasmWebClient(
      null,
      null,
      undefined,
      "auth-scheme-store",
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );
    instance.wasmWebClient = inner;
    client = createClientProxy(instance);
  });

  afterEach(() => vi.restoreAllMocks());

  it("newWallet hands the wasm client the ECDSA enum value", async () => {
    await expect(client.newWallet("mode", "ecdsa")).resolves.toBe("wallet");
    expect(inner.newWallet).toHaveBeenCalledWith("mode", 1, undefined);
  });

  it("newFaucet hands the wasm client the Falcon enum value", async () => {
    await expect(
      client.newFaucet("mode", false, "Token", "TOK", 8, 1000n, "falcon")
    ).resolves.toBe("faucet");
    expect(inner.newFaucet).toHaveBeenCalledWith(
      "mode",
      false,
      "Token",
      "TOK",
      8,
      1000n,
      2
    );
  });

  it("importPublicAccountFromSeed hands the wasm client the Falcon enum value", async () => {
    const seed = new Uint8Array(32);
    await expect(
      client.importPublicAccountFromSeed(seed, "falcon")
    ).resolves.toBe("account");
    expect(inner.importPublicAccountFromSeed).toHaveBeenCalledWith(seed, 2);
  });

  it("importPublicAccountFromSeed rejects a number that is not an AuthScheme value", async () => {
    await expect(
      client.importPublicAccountFromSeed(new Uint8Array(32), 99)
    ).rejects.toThrow('Unknown auth scheme: "99"');
    expect(inner.importPublicAccountFromSeed).not.toHaveBeenCalled();
  });
});
