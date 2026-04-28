import { describe, it, expect, vi } from "vitest";
import { AccountId, Address } from "@miden-sdk/miden-sdk";
import {
  parseAccountId,
  parseAddress,
  isFaucetId,
} from "../../utils/accountParsing";

describe("parseAccountId", () => {
  it("strips the 'miden:' URI prefix from a string input", () => {
    parseAccountId("miden:0xabc");
    // Last call should be without the prefix.
    expect(vi.mocked(AccountId.fromHex)).toHaveBeenCalledWith("0xabc");
  });

  it("trims surrounding whitespace from string input", () => {
    parseAccountId("   0xabc   ");
    expect(vi.mocked(AccountId.fromHex)).toHaveBeenCalledWith("0xabc");
  });

  it("normalizes hex without 0x prefix", () => {
    parseAccountId("abc123");
    expect(vi.mocked(AccountId.fromHex)).toHaveBeenCalledWith("0xabc123");
  });

  it("preserves an existing 0x prefix", () => {
    parseAccountId("0xdeadbeef");
    expect(vi.mocked(AccountId.fromHex)).toHaveBeenCalledWith("0xdeadbeef");
  });

  it("preserves an existing 0X prefix (case-insensitive)", () => {
    parseAccountId("0Xdeadbeef");
    expect(vi.mocked(AccountId.fromHex)).toHaveBeenCalledWith("0Xdeadbeef");
  });

  it("dispatches to Address.fromBech32 for inputs starting with 'm'", () => {
    parseAccountId("mxabc123def");
    expect(vi.mocked(Address.fromBech32)).toHaveBeenCalledWith("mxabc123def");
  });

  it("dispatches to Address.fromBech32 for inputs starting with 'M'", () => {
    parseAccountId("Mxabc123def");
    expect(vi.mocked(Address.fromBech32)).toHaveBeenCalledWith("Mxabc123def");
  });

  it("falls back to AccountId.fromBech32 when Address.fromBech32 throws", () => {
    vi.mocked(Address.fromBech32).mockImplementationOnce(() => {
      throw new Error("not an address");
    });
    parseAccountId("mxinvalidaddress");
    expect(vi.mocked(AccountId.fromBech32)).toHaveBeenCalledWith(
      "mxinvalidaddress"
    );
  });

  it("returns the input directly for an Account-like object with id() method", () => {
    const idMock = { toHex: () => "0xfoo", toString: () => "0xfoo" } as never;
    const account = { id: vi.fn(() => idMock) } as never;
    const out = parseAccountId(account);
    expect(account.id).toHaveBeenCalled();
    expect(out).toBe(idMock);
  });

  it("returns the input as-is when it is not a string and has no id()", () => {
    const accountId = { toHex: () => "0xfoo" } as never;
    const out = parseAccountId(accountId);
    expect(out).toBe(accountId);
  });
});

describe("parseAddress", () => {
  it("calls Address.fromAccountId for non-string AccountId-like input", () => {
    const accountId = { toHex: () => "0xfoo" } as never;
    parseAddress(accountId);
    expect(vi.mocked(Address.fromAccountId)).toHaveBeenCalledWith(
      accountId,
      "BasicWallet"
    );
  });

  it("uses the explicit accountId override for a non-string input", () => {
    const account = { id: vi.fn() } as never;
    const override = { toHex: () => "0xoverride" } as never;
    parseAddress(account, override);
    // Should NOT have called account.id() since we passed an override.
    expect(account.id).not.toHaveBeenCalled();
    expect(vi.mocked(Address.fromAccountId)).toHaveBeenCalledWith(
      override,
      "BasicWallet"
    );
  });

  it("dispatches a bech32 string to Address.fromBech32", () => {
    parseAddress("mxabc123");
    expect(vi.mocked(Address.fromBech32)).toHaveBeenCalledWith("mxabc123");
  });

  it("falls back to fromAccountId when Address.fromBech32 throws", () => {
    vi.mocked(Address.fromBech32).mockImplementationOnce(() => {
      throw new Error("not an address");
    });
    parseAddress("mxbadbech32");
    // Should resolve via AccountId.fromBech32 → Address.fromAccountId.
    expect(vi.mocked(AccountId.fromBech32)).toHaveBeenCalledWith("mxbadbech32");
    expect(vi.mocked(Address.fromAccountId)).toHaveBeenCalled();
  });

  it("uses the explicit accountId override for a bech32 string fallback", () => {
    vi.mocked(Address.fromBech32).mockImplementationOnce(() => {
      throw new Error("not an address");
    });
    const override = { toHex: () => "0xoverride" } as never;
    parseAddress("mxbadbech32", override);
    expect(vi.mocked(AccountId.fromBech32)).not.toHaveBeenCalled();
    expect(vi.mocked(Address.fromAccountId)).toHaveBeenCalledWith(
      override,
      "BasicWallet"
    );
  });

  it("dispatches a hex string to AccountId.fromHex + Address.fromAccountId", () => {
    parseAddress("0xabc");
    expect(vi.mocked(AccountId.fromHex)).toHaveBeenCalledWith("0xabc");
    expect(vi.mocked(Address.fromAccountId)).toHaveBeenCalled();
  });

  it("normalizes a bare-hex (no 0x prefix) string", () => {
    parseAddress("deadbeef");
    expect(vi.mocked(AccountId.fromHex)).toHaveBeenCalledWith("0xdeadbeef");
  });

  it("uses the explicit accountId override for a hex string", () => {
    const override = { toHex: () => "0xoverride" } as never;
    parseAddress("0xabc", override);
    expect(vi.mocked(AccountId.fromHex)).not.toHaveBeenCalled();
    expect(vi.mocked(Address.fromAccountId)).toHaveBeenCalledWith(
      override,
      "BasicWallet"
    );
  });
});

describe("isFaucetId", () => {
  // Account-type bits live in nibble (4..7) of the first hex byte:
  //   0b00 = Regular off-chain      (e.g. 0x0...)
  //   0b01 = Regular on-chain       (e.g. 0x1...)
  //   0b10 = Fungible faucet        (e.g. 0x2..., 0xa...)
  //   0b11 = Non-fungible faucet    (e.g. 0x3..., 0xb...)
  // (The shift is `(byte >> 4) & 0b11`, so it keys off the high nibble.)
  it("identifies a fungible faucet from hex", () => {
    expect(isFaucetId({ toHex: () => "0x20abcdef" })).toBe(true);
  });

  it("identifies a non-fungible faucet from hex", () => {
    expect(isFaucetId({ toHex: () => "0x30abcdef" })).toBe(true);
  });

  it("rejects a regular off-chain account", () => {
    expect(isFaucetId({ toHex: () => "0x00abcdef" })).toBe(false);
  });

  it("rejects a regular on-chain account", () => {
    expect(isFaucetId({ toHex: () => "0x10abcdef" })).toBe(false);
  });

  it("accepts an upper-case 0X prefix", () => {
    expect(isFaucetId({ toHex: () => "0X20abcdef" })).toBe(true);
  });

  it("accepts a hex string without an 0x prefix (via String() fallback)", () => {
    expect(isFaucetId("20abcdef")).toBe(true);
  });

  it("returns false when toHex throws", () => {
    expect(
      isFaucetId({
        toHex: () => {
          throw new Error("boom");
        },
      })
    ).toBe(false);
  });

  it("returns false when input has no toHex (and stringifies to non-hex)", () => {
    expect(isFaucetId({ unrelated: 1 } as never)).toBe(false);
  });
});
