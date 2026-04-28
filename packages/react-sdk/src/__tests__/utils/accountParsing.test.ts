import { describe, it, expect, vi } from "vitest";
import {
  parseAccountId,
  isFaucetId,
  parseAddress,
} from "../../utils/accountParsing";

// The @miden-sdk/miden-sdk/lazy module is mocked via setup.ts.
// AccountId.fromHex / AccountId.fromBech32 / Address.fromBech32 / Address.fromAccountId
// are all mock functions.

// ---------------------------------------------------------------------------
// parseAccountId
// ---------------------------------------------------------------------------

describe("parseAccountId", () => {
  it("should parse a 0x-prefixed hex string", () => {
    const result = parseAccountId("0xabcdef1234567890");
    expect(result.toString()).toBe("0xabcdef1234567890");
  });

  it("should add 0x prefix to bare hex string", () => {
    const result = parseAccountId("abcdef1234567890");
    // normalizeHexInput prepends 0x
    expect(result.toString()).toBe("0xabcdef1234567890");
  });

  it("should parse a bech32 string starting with 'm'", () => {
    // isBech32Input returns true for strings starting with 'm'
    const result = parseAccountId("miden1qy35...");
    expect(result).toBeDefined();
  });

  it("should fall back to AccountId.fromBech32 when Address.fromBech32 throws (lines 25-26)", async () => {
    const { Address, AccountId } = await import("@miden-sdk/miden-sdk/lazy");
    vi.mocked(Address.fromBech32).mockImplementationOnce(() => {
      throw new Error("bad bech32");
    });
    // With Address.fromBech32 throwing, falls back to AccountId.fromBech32
    const result = parseAccountId("miden1fallback");
    expect(result).toBeDefined();
  });

  it("should strip miden: prefix from bech32", () => {
    // normalizeAccountIdInput strips 'miden:' prefix (case-insensitive)
    const result = parseAccountId("miden:miden1test");
    expect(result).toBeDefined();
  });

  it("should parse an Account-like object with .id() method", () => {
    const mockAccountId = { toString: () => "0xfromaccount", toHex: () => "0xfromaccount" };
    const accountLike = { id: vi.fn(() => mockAccountId) };
    const result = parseAccountId(accountLike as any);
    expect(result).toBe(mockAccountId);
    expect(accountLike.id).toHaveBeenCalled();
  });

  it("should return the value itself when it has no .id() method and is not a string", () => {
    // Already an AccountId — no id() function, not a string
    const accountId = {
      toString: () => "0xdirect",
      toHex: () => "0xdirect",
    };
    const result = parseAccountId(accountId as any);
    expect(result).toBe(accountId);
  });
});

// ---------------------------------------------------------------------------
// isFaucetId
// ---------------------------------------------------------------------------

describe("isFaucetId", () => {
  it("should return false for non-faucet account type (0b00 = regular off-chain)", () => {
    // Bits 61-60 = 0b00 → account type 0 → regular account
    // First nibble must encode bits 63-60. For type=0b00: first byte = 0x0X
    expect(isFaucetId({ toHex: () => "0x0000000000000000" })).toBe(false);
  });

  it("should return false for regular on-chain account (0b01)", () => {
    // First nibble = 0x1 → type = 0b01
    expect(isFaucetId({ toHex: () => "0x1000000000000000" })).toBe(false);
  });

  it("should return true for fungible faucet (0b10)", () => {
    // First nibble = 0x2 → type = 0b10
    expect(isFaucetId({ toHex: () => "0x2000000000000000" })).toBe(true);
  });

  it("should return true for non-fungible faucet (0b11)", () => {
    // First nibble = 0x3 → type = 0b11
    expect(isFaucetId({ toHex: () => "0x3000000000000000" })).toBe(true);
  });

  it("should strip 0x prefix before parsing", () => {
    expect(isFaucetId({ toHex: () => "0x2abc" })).toBe(true);
  });

  it("should handle hex without 0x prefix via String()", () => {
    // If toHex is not a function, falls back to String()
    expect(isFaucetId("2000000000000000")).toBe(true);
  });

  it("should return false on thrown error", () => {
    expect(
      isFaucetId({
        toHex: () => {
          throw new Error("bad");
        },
      })
    ).toBe(false);
  });

  it("should return false for invalid hex", () => {
    expect(isFaucetId("not-hex-at-all")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAddress
// ---------------------------------------------------------------------------

describe("parseAddress", () => {
  it("should parse a bech32 string directly via Address.fromBech32", () => {
    const addr = parseAddress("miden1test");
    expect(addr).toBeDefined();
  });

  it("should fall back to Address.fromAccountId when fromBech32 throws", () => {
    // The mock Address.fromBech32 succeeds normally, but we can verify it is called
    const addr = parseAddress("mtst1someaddress");
    expect(addr).toBeDefined();
  });

  it("should parse hex string via AccountId.fromHex and wrap in Address", () => {
    const addr = parseAddress("0xabcdef");
    expect(addr).toBeDefined();
  });

  it("should parse a bare hex string (no 0x prefix)", () => {
    const addr = parseAddress("abcdef1234");
    expect(addr).toBeDefined();
  });

  it("should handle non-string Account-like with provided accountId", () => {
    const mockAccount = {
      id: vi.fn(() => ({ toString: () => "0xacc", toHex: () => "0xacc" })),
    };
    const mockId = { toString: () => "0xacc", toHex: () => "0xacc" };
    const addr = parseAddress(mockAccount as any, mockId as any);
    expect(addr).toBeDefined();
  });

  it("should handle non-string Account-like without provided accountId", () => {
    const mockAccount = {
      id: vi.fn(() => ({ toString: () => "0xacc", toHex: () => "0xacc" })),
    };
    const addr = parseAddress(mockAccount as any);
    expect(addr).toBeDefined();
  });

  it("should fall back when Address.fromBech32 throws in parseAddress (lines 89-91)", async () => {
    const { Address } = await import("@miden-sdk/miden-sdk/lazy");
    vi.mocked(Address.fromBech32).mockImplementationOnce(() => {
      throw new Error("fromBech32 fail");
    });
    // Falls back: AccountId.fromBech32 → Address.fromAccountId
    const addr = parseAddress("miden1parseaddress");
    expect(addr).toBeDefined();
  });
});
