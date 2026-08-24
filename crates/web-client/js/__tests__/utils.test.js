import { describe, it, expect, vi } from "vitest";
import {
  resolveAccountRef,
  resolveAddress,
  resolveNoteType,
  resolveStorageMode,
  resolveAuthScheme,
  resolveNoteIdHex,
  resolveTransactionIdHex,
  hashSeed,
  normalizeSerializedRequests,
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

  it("throws for the removed network mode", () => {
    expect(() => resolveStorageMode("network", wasm)).toThrow(
      'Unknown storage mode: "network"'
    );
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

  // NOTE: main exposes a hardcoded-discriminant fallback when `wasm` is
  // omitted (1 for ecdsa, 2 for falcon); next dropped that and now
  // requires the WASM module to read enum values from
  // `wasm.AuthScheme.*` directly. The two "hardcoded fallback" tests
  // from main don't apply here. Test the new contract instead:
  it("throws (via TypeError) when wasm is not provided", () => {
    expect(() => resolveAuthScheme("falcon")).toThrow(TypeError);
  });

  it("throws for unknown scheme", () => {
    expect(() => resolveAuthScheme("rsa", wasm)).toThrow(
      'Unknown auth scheme: "rsa"'
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

describe("normalizeSerializedRequests", () => {
  it("passes through a Uint8Array that owns its buffer, without copying", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const [out] = normalizeSerializedRequests([bytes]);
    expect(out).toBe(bytes);
  });

  it("preserves order and contents across several requests", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    expect(normalizeSerializedRequests([a, b])).toEqual([a, b]);
  });

  it("returns an empty array for empty input", () => {
    expect(normalizeSerializedRequests([])).toEqual([]);
  });

  it("rejects a non-array argument", () => {
    expect(() => normalizeSerializedRequests(null)).toThrow(TypeError);
    expect(() => normalizeSerializedRequests(new Uint8Array([1]))).toThrow(
      /expected an array/
    );
    expect(() => normalizeSerializedRequests({ length: 1, 0: null })).toThrow(
      TypeError
    );
  });

  it("names the offending index when an element is not a byte view", () => {
    const good = new Uint8Array([1]);
    expect(() => normalizeSerializedRequests([good, null])).toThrow(/index 1/);
    expect(() => normalizeSerializedRequests([good, [1, 2, 3]])).toThrow(
      /index 1/
    );
    expect(() =>
      normalizeSerializedRequests([{ serialize: () => new Uint8Array() }])
    ).toThrow(/index 0/);
  });

  it("rejects a bare ArrayBuffer, which carries no view", () => {
    expect(() => normalizeSerializedRequests([new ArrayBuffer(4)])).toThrow(
      /index 0/
    );
  });

  it("rejects views whose elements are not single bytes", () => {
    // A wider typed array's lanes would be reinterpreted as raw bytes. A
    // DataView's bytes would be fine; it is excluded to keep the contract to
    // a single accepted shape.
    expect(() => normalizeSerializedRequests([new Float64Array([1])])).toThrow(
      /index 0/
    );
    expect(() =>
      normalizeSerializedRequests([new DataView(new ArrayBuffer(8))])
    ).toThrow(/index 0/);
    expect(() => normalizeSerializedRequests([new Uint16Array([1])])).toThrow(
      /index 0/
    );
  });

  it("rejects a hole in a sparse array rather than skipping it", () => {
    const sparse = new Array(2);
    sparse[0] = new Uint8Array([1]);
    expect(() => normalizeSerializedRequests(sparse)).toThrow(/index 1/);
  });

  it("rejects an empty request", () => {
    expect(() => normalizeSerializedRequests([new Uint8Array(0)])).toThrow(
      /index 0 is empty/
    );
  });

  it("copies a view that does not span its buffer, so postMessage cannot ship the whole buffer", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = backing.subarray(2, 5);
    const [out] = normalizeSerializedRequests([view]);

    expect(out).not.toBe(view);
    expect(Array.from(out)).toEqual([3, 4, 5]);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(3);
  });

  it("accepts a byte view from another realm, which wasm-bindgen would refuse", async () => {
    const vm = await import("node:vm");
    const foreign = vm.runInNewContext("new Uint8Array([7, 8, 9])");
    expect(foreign instanceof Uint8Array).toBe(false);

    const [out] = normalizeSerializedRequests([foreign]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([7, 8, 9]);
  });

  it("converts a single-byte view of another type to a Uint8Array", () => {
    const [out] = normalizeSerializedRequests([new Int8Array([1, -1])]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([1, 255]);
  });
});
