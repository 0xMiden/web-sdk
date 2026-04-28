import { describe, it, expect } from "vitest";
import { resolveRpcUrl } from "../../utils/network";

describe("resolveRpcUrl", () => {
  it("should return undefined when no rpcUrl given", () => {
    expect(resolveRpcUrl(undefined)).toBeUndefined();
  });

  it("should resolve 'testnet' to testnet URL", () => {
    expect(resolveRpcUrl("testnet")).toBe("https://rpc.testnet.miden.io");
  });

  it("should resolve 'TESTNET' case-insensitively", () => {
    expect(resolveRpcUrl("TESTNET")).toBe("https://rpc.testnet.miden.io");
  });

  it("should resolve 'devnet' to devnet URL", () => {
    expect(resolveRpcUrl("devnet")).toBe("https://rpc.devnet.miden.io");
  });

  it("should resolve 'DEVNET' case-insensitively", () => {
    expect(resolveRpcUrl("DEVNET")).toBe("https://rpc.devnet.miden.io");
  });

  it("should resolve 'localhost' to localhost URL", () => {
    expect(resolveRpcUrl("localhost")).toBe("http://localhost:57291");
  });

  it("should resolve 'local' to localhost URL", () => {
    expect(resolveRpcUrl("local")).toBe("http://localhost:57291");
  });

  it("should resolve 'LOCAL' case-insensitively", () => {
    expect(resolveRpcUrl("LOCAL")).toBe("http://localhost:57291");
  });

  it("should return custom URL as-is", () => {
    const custom = "https://my-custom-rpc.example.com";
    expect(resolveRpcUrl(custom)).toBe(custom);
  });

  it("should return http URL as-is", () => {
    const url = "http://10.0.0.1:1234";
    expect(resolveRpcUrl(url)).toBe(url);
  });

  it("should trim and normalize when comparing", () => {
    // Leading/trailing whitespace is trimmed before comparison
    expect(resolveRpcUrl("  testnet  ")).toBe("https://rpc.testnet.miden.io");
  });
});
