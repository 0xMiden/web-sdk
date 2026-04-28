import { describe, it, expect } from "vitest";
import { resolveRpcUrl } from "../../utils/network";

describe("resolveRpcUrl", () => {
  it("returns undefined when input is undefined", () => {
    expect(resolveRpcUrl(undefined)).toBeUndefined();
  });

  it("returns undefined when input is empty string", () => {
    // empty string is falsy → undefined branch
    expect(resolveRpcUrl("" as never)).toBeUndefined();
  });

  it('maps "testnet" to the canonical testnet URL', () => {
    expect(resolveRpcUrl("testnet")).toBe("https://rpc.testnet.miden.io");
  });

  it('maps "devnet" to the canonical devnet URL', () => {
    expect(resolveRpcUrl("devnet")).toBe("https://rpc.devnet.miden.io");
  });

  it('maps "localhost" to the local RPC port', () => {
    expect(resolveRpcUrl("localhost")).toBe("http://localhost:57291");
  });

  it('maps "local" to the local RPC port', () => {
    expect(resolveRpcUrl("local")).toBe("http://localhost:57291");
  });

  it("is case-insensitive for shortcuts", () => {
    expect(resolveRpcUrl("TestNet")).toBe("https://rpc.testnet.miden.io");
    expect(resolveRpcUrl("DEVNET")).toBe("https://rpc.devnet.miden.io");
    expect(resolveRpcUrl("LOCALHOST")).toBe("http://localhost:57291");
  });

  it("trims whitespace before matching shortcuts", () => {
    expect(resolveRpcUrl("  testnet  ")).toBe("https://rpc.testnet.miden.io");
  });

  it("passes a custom URL through unchanged", () => {
    expect(resolveRpcUrl("https://custom.example.com")).toBe(
      "https://custom.example.com"
    );
  });

  it("does not lower-case a custom URL", () => {
    // When the input doesn't match any shortcut, it's returned verbatim
    // (not the lower-cased version).
    expect(resolveRpcUrl("https://CUSTOM.example.com")).toBe(
      "https://CUSTOM.example.com"
    );
  });
});
