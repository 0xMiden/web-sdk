import { describe, it, expect, vi } from "vitest";
import {
  resolveAccountRef,
  resolveAddress,
  resolveNoteType,
  resolveStorageMode,
  resolveAuthScheme,
  resolveAccountMutability,
  resolveNoteIdHex,
  resolveTransactionIdHex,
  hashSeed,
} from "../utils.js";

// ── WASM mock helpers ──────────────────────────────────────────────────────────

function makeWasm(overrides = {}) {
  return {
    AccountId: {
      fromHex: vi.fn((hex) => ({ _type: "AccountId", hex })),
      fromBech32: vi.fn((b) => ({ _type: "AccountId", bech32: b })),
    },
    Address: {
      fromBech32: vi.fn((b) => ({ _type: "Address", bech32: b })),
      fromAccountId: vi.fn((id, extra) => ({ _type: "Address", id })),
    },
    NoteType: {
      Public: "Public",
      Private: "Private",
    },
    AccountStorageMode: {
      public: vi.fn().mockReturnValue("StorageModePublic"),
      private: vi.fn().mockReturnValue("StorageModePrivate"),
      network: vi.fn().mockReturnValue("StorageModeNetwork"),
    },
    AuthScheme: {
      AuthEcdsaK256Keccak: 1,
      AuthRpoFalcon512: 2,
    },
    ...overrides,
  };
}

// ── resolveAccountRef ─────────────────────────────────────────────────────────

describe("resolveAccountRef", () => {
  const wasm = makeWasm();

  it("throws for null", () => {
    expect(() => resolveAccountRef(null, wasm)).toThrow(
      "Account reference cannot be null or undefined"
    );
  });

  it("throws for undefined", () => {
    expect(() => resolveAccountRef(undefined, wasm)).toThrow(
      "Account reference cannot be null or undefined"
    );
  });

  it("parses hex string via fromHex", () => {
    const result = resolveAccountRef("0xabc123", wasm);
    expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0xabc123");
    expect(result._type).toBe("AccountId");
  });

  it("parses uppercase hex prefix via fromHex", () => {
    resolveAccountRef("0Xdeadbeef", wasm);
    expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0Xdeadbeef");
  });

  it("parses bech32 string via fromBech32", () => {
    const result = resolveAccountRef("mSomeBech32", wasm);
    expect(wasm.AccountId.fromBech32).toHaveBeenCalledWith("mSomeBech32");
    expect(result._type).toBe("AccountId");
  });

  it("calls .id() for Account objects", () => {
    const mockId = { _type: "AccountId" };
    const account = { id: vi.fn().mockReturnValue(mockId) };
    const result = resolveAccountRef(account, wasm);
    expect(account.id).toHaveBeenCalledOnce();
    expect(result).toBe(mockId);
  });

  it("passes through AccountId objects (no id() method)", () => {
    const accountId = { _type: "AccountId" };
    const result = resolveAccountRef(accountId, wasm);
    expect(result).toBe(accountId);
  });
});

// ── resolveAddress ─────────────────────────────────────────────────────────────

describe("resolveAddress", () => {
  const wasm = makeWasm();

  it("throws for null", () => {
    expect(() => resolveAddress(null, wasm)).toThrow(
      "Address reference cannot be null or undefined"
    );
  });

  it("throws for undefined", () => {
    expect(() => resolveAddress(undefined, wasm)).toThrow(
      "Address reference cannot be null or undefined"
    );
  });

  it("parses hex string: calls fromHex then fromAccountId", () => {
    const result = resolveAddress("0xabc", wasm);
    expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0xabc");
    expect(wasm.Address.fromAccountId).toHaveBeenCalled();
    expect(result._type).toBe("Address");
  });

  it("parses uppercase hex prefix via fromAccountId path", () => {
    resolveAddress("0Xdeadbeef", wasm);
    expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0Xdeadbeef");
    expect(wasm.Address.fromAccountId).toHaveBeenCalled();
  });

  it("parses non-hex string via fromBech32", () => {
    const result = resolveAddress("mBech32Addr", wasm);
    expect(wasm.Address.fromBech32).toHaveBeenCalledWith("mBech32Addr");
    expect(result._type).toBe("Address");
  });

  it("resolves Account object (has .id()) to Address", () => {
    const mockId = { _type: "AccountId" };
    const account = { id: vi.fn().mockReturnValue(mockId) };
    const result = resolveAddress(account, wasm);
    expect(account.id).toHaveBeenCalledOnce();
    expect(wasm.Address.fromAccountId).toHaveBeenCalledWith(mockId, undefined);
    expect(result._type).toBe("Address");
  });

  it("wraps plain AccountId (no id() method) in Address", () => {
    const accountId = { _type: "AccountId" };
    const result = resolveAddress(accountId, wasm);
    expect(wasm.Address.fromAccountId).toHaveBeenCalledWith(
      accountId,
      undefined
    );
    expect(result._type).toBe("Address");
  });
});

// ── resolveNoteType ────────────────────────────────────────────────────────────

describe("resolveNoteType", () => {
  const wasm = makeWasm();

  it("returns Public for type='public'", () => {
    expect(resolveNoteType("public", wasm)).toBe("Public");
  });

  it("returns Public for type=undefined", () => {
    expect(resolveNoteType(undefined, wasm)).toBe("Public");
  });

  it("returns Public for type=null", () => {
    expect(resolveNoteType(null, wasm)).toBe("Public");
  });

  it("returns Private for type='private'", () => {
    expect(resolveNoteType("private", wasm)).toBe("Private");
  });

  it("throws for unknown type", () => {
    expect(() => resolveNoteType("encrypted", wasm)).toThrow(
      'Unknown note type: "encrypted"'
    );
  });
});

// ── resolveStorageMode ─────────────────────────────────────────────────────────

describe("resolveStorageMode", () => {
  const wasm = makeWasm();

  it("returns public storage mode", () => {
    expect(resolveStorageMode("public", wasm)).toBe("StorageModePublic");
    expect(wasm.AccountStorageMode.public).toHaveBeenCalled();
  });

  it("returns network storage mode", () => {
    expect(resolveStorageMode("network", wasm)).toBe("StorageModeNetwork");
    expect(wasm.AccountStorageMode.network).toHaveBeenCalled();
  });

  it("returns private storage mode for 'private'", () => {
    expect(resolveStorageMode("private", wasm)).toBe("StorageModePrivate");
    expect(wasm.AccountStorageMode.private).toHaveBeenCalled();
  });

  it("returns private storage mode for undefined", () => {
    expect(resolveStorageMode(undefined, wasm)).toBe("StorageModePrivate");
  });

  it("returns private storage mode for null", () => {
    expect(resolveStorageMode(null, wasm)).toBe("StorageModePrivate");
  });

  it("throws for unknown mode", () => {
    expect(() => resolveStorageMode("cloud", wasm)).toThrow(
      'Unknown storage mode: "cloud"'
    );
  });
});

// ── resolveAuthScheme ─────────────────────────────────────────────────────────

describe("resolveAuthScheme", () => {
  const wasm = makeWasm();

  it("returns ECDSA auth scheme numeric value", () => {
    expect(resolveAuthScheme("ecdsa", wasm)).toBe(1);
  });

  it("returns falcon auth scheme numeric value", () => {
    expect(resolveAuthScheme("falcon", wasm)).toBe(2);
  });

  it("defaults to falcon for null", () => {
    expect(resolveAuthScheme(null, wasm)).toBe(2);
  });

  it("defaults to falcon for undefined", () => {
    expect(resolveAuthScheme(undefined, wasm)).toBe(2);
  });

  it("uses hardcoded fallback when wasm not provided (ecdsa)", () => {
    expect(resolveAuthScheme("ecdsa")).toBe(1);
  });

  it("uses hardcoded fallback when wasm not provided (falcon)", () => {
    expect(resolveAuthScheme("falcon")).toBe(2);
  });

  it("throws for unknown scheme", () => {
    expect(() => resolveAuthScheme("rsa", wasm)).toThrow(
      'Unknown auth scheme: "rsa"'
    );
  });
});

// ── resolveAccountMutability ──────────────────────────────────────────────────

describe("resolveAccountMutability", () => {
  it("returns true (mutable) for null", () => {
    expect(resolveAccountMutability(null)).toBe(true);
  });

  it("returns true (mutable) for undefined", () => {
    expect(resolveAccountMutability(undefined)).toBe(true);
  });

  it("returns true for 'MutableWallet'", () => {
    expect(resolveAccountMutability("MutableWallet")).toBe(true);
  });

  it("returns true for numeric 3", () => {
    expect(resolveAccountMutability(3)).toBe(true);
  });

  it("returns false (immutable) for 'ImmutableWallet'", () => {
    expect(resolveAccountMutability("ImmutableWallet")).toBe(false);
  });

  it("returns false for numeric 2", () => {
    expect(resolveAccountMutability(2)).toBe(false);
  });

  it("throws for unknown type", () => {
    expect(() => resolveAccountMutability("OtherType")).toThrow(
      'Unknown wallet account type: "OtherType"'
    );
  });
});

// ── resolveNoteIdHex ──────────────────────────────────────────────────────────

describe("resolveNoteIdHex", () => {
  it("throws for null", () => {
    expect(() => resolveNoteIdHex(null)).toThrow(
      "Note ID cannot be null or undefined"
    );
  });

  it("throws for undefined", () => {
    expect(() => resolveNoteIdHex(undefined)).toThrow(
      "Note ID cannot be null or undefined"
    );
  });

  it("passes through string unchanged", () => {
    expect(resolveNoteIdHex("0xnoteHex")).toBe("0xnoteHex");
  });

  it("resolves NoteId object with constructor.fromHex via toString()", () => {
    const noteId = {
      toString: vi.fn().mockReturnValue("0xnoteId"),
      constructor: { fromHex: vi.fn() },
    };
    expect(resolveNoteIdHex(noteId)).toBe("0xnoteId");
  });

  it("resolves InputNoteRecord / Note objects with .id() method", () => {
    const noteRecord = {
      id: vi.fn().mockReturnValue({ toString: () => "0xrecordId" }),
    };
    expect(resolveNoteIdHex(noteRecord)).toBe("0xrecordId");
  });

  it("throws TypeError for unrecognized input", () => {
    expect(() => resolveNoteIdHex({ notAnId: true })).toThrow(TypeError);
  });
});

// ── resolveTransactionIdHex ───────────────────────────────────────────────────

describe("resolveTransactionIdHex", () => {
  it("throws for null", () => {
    expect(() => resolveTransactionIdHex(null)).toThrow(
      "Transaction ID cannot be null or undefined"
    );
  });

  it("throws for undefined", () => {
    expect(() => resolveTransactionIdHex(undefined)).toThrow(
      "Transaction ID cannot be null or undefined"
    );
  });

  it("passes through string unchanged", () => {
    expect(resolveTransactionIdHex("0xtxHex")).toBe("0xtxHex");
  });

  it("resolves TransactionId object with toHex()", () => {
    const txId = { toHex: vi.fn().mockReturnValue("0xtxHex") };
    expect(resolveTransactionIdHex(txId)).toBe("0xtxHex");
  });

  it("throws TypeError for unrecognized input", () => {
    expect(() => resolveTransactionIdHex({ notAHex: true })).toThrow(TypeError);
  });
});

// ── hashSeed ──────────────────────────────────────────────────────────────────

describe("hashSeed", () => {
  it("returns Uint8Array unchanged", async () => {
    const seed = new Uint8Array([1, 2, 3]);
    const result = await hashSeed(seed);
    expect(result).toBe(seed);
  });

  it("hashes string to 32-byte Uint8Array", async () => {
    const result = await hashSeed("my-seed");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toHaveLength(32);
  });

  it("produces different hashes for different strings", async () => {
    const h1 = await hashSeed("seed1");
    const h2 = await hashSeed("seed2");
    expect(h1).not.toEqual(h2);
  });

  it("produces consistent hash for same string", async () => {
    const h1 = await hashSeed("consistent");
    const h2 = await hashSeed("consistent");
    expect(h1).toEqual(h2);
  });

  it("throws TypeError for non-string non-Uint8Array input", async () => {
    await expect(hashSeed(12345)).rejects.toThrow(TypeError);
  });

  it("throws TypeError for object input", async () => {
    await expect(hashSeed({ seed: "bad" })).rejects.toThrow(TypeError);
  });
});
