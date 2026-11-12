import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  _setWasm,
  _setWebClient,
  createP2IDNote,
  createP2IDENote,
  buildSwapTag,
  isStandardPayment,
  domainSeparatedSignCommitment,
} from "../standalone.js";

// ── WASM mock ─────────────────────────────────────────────────────────────────

function makeWasm() {
  return {
    AccountId: {
      fromHex: vi.fn((h) => ({ hex: h, toString: () => h })),
      fromBech32: vi.fn((b) => ({ bech32: b, toString: () => b })),
    },
    NoteType: { Public: "Public", Private: "Private" },
    Note: {
      createP2IDNote: vi.fn().mockReturnValue("p2idNote"),
      createP2IDENote: vi.fn().mockReturnValue("p2ideNote"),
    },
    NoteAttachment: vi.fn().mockImplementation((data) => ({ data })),
    NoteAssets: vi.fn().mockImplementation(() => "noteAssets"),
    FungibleAsset: vi.fn().mockImplementation(() => "fungibleAsset"),
  };
}

// ── createP2IDNote ─────────────────────────────────────────────────────────────

describe("createP2IDNote", () => {
  let wasm;

  beforeEach(() => {
    wasm = makeWasm();
    _setWasm(wasm);
  });

  afterEach(() => {
    _setWasm(null);
  });

  it("throws when WASM is not initialized", () => {
    _setWasm(null);
    expect(() =>
      createP2IDNote({ from: "0xsender", to: "0xrecipient", assets: [] })
    ).toThrow("WASM not initialized");
  });

  it("creates a P2ID note with a single asset", () => {
    const result = createP2IDNote({
      from: "0xsender",
      to: "0xrecipient",
      assets: { token: "0xfaucet", amount: 100 },
      type: "public",
    });
    expect(wasm.Note.createP2IDNote).toHaveBeenCalledWith(
      expect.anything(), // sender AccountId
      expect.anything(), // recipient AccountId
      expect.anything(), // NoteAssets instance
      "Public",
      expect.anything() // NoteAttachment
    );
    // Verify NoteAssets was constructed (not just the return value)
    expect(wasm.NoteAssets).toHaveBeenCalledOnce();
    expect(result).toBe("p2idNote");
  });

  it("creates a P2ID note with an array of assets", () => {
    createP2IDNote({
      from: "0xsender",
      to: "0xrecipient",
      assets: [
        { token: "0xfaucet1", amount: 50 },
        { token: "0xfaucet2", amount: 75 },
      ],
      type: "public",
    });
    expect(wasm.FungibleAsset).toHaveBeenCalledTimes(2);
    expect(wasm.NoteAssets).toHaveBeenCalledOnce();
  });

  it("rejects an empty asset array", () => {
    expect(() =>
      createP2IDNote({ from: "0xsender", to: "0xrecipient", assets: [] })
    ).toThrow("P2ID and P2IDE notes require at least one asset");
  });

  it("uses provided attachment data", () => {
    createP2IDNote({
      from: "0xsender",
      to: "0xrecipient",
      assets: { token: "0xfaucet", amount: 1 },
      attachment: "attachData",
    });
    expect(wasm.NoteAttachment).toHaveBeenCalledWith("attachData");
  });

  it("defaults attachment to empty array when not provided", () => {
    createP2IDNote({
      from: "0xsender",
      to: "0xrecipient",
      assets: { token: "0xfaucet", amount: 1 },
    });
    expect(wasm.NoteAttachment).toHaveBeenCalledWith([]);
  });

  it("resolves bech32 from/to addresses", () => {
    createP2IDNote({
      from: "mSenderBech32",
      to: "mRecipientBech32",
      assets: { token: "0xfaucet", amount: 1 },
    });
    expect(wasm.AccountId.fromBech32).toHaveBeenCalledWith("mSenderBech32");
    expect(wasm.AccountId.fromBech32).toHaveBeenCalledWith("mRecipientBech32");
  });

  it("defaults to public note type", () => {
    createP2IDNote({
      from: "0xsender",
      to: "0xrecipient",
      assets: { token: "0xfaucet", amount: 1 },
    });
    expect(wasm.Note.createP2IDNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "Public",
      expect.anything()
    );
  });
});

// ── createP2IDENote ────────────────────────────────────────────────────────────

describe("createP2IDENote", () => {
  let wasm;

  beforeEach(() => {
    wasm = makeWasm();
    _setWasm(wasm);
  });

  afterEach(() => {
    _setWasm(null);
  });

  it("throws when WASM is not initialized", () => {
    _setWasm(null);
    expect(() =>
      createP2IDENote({
        from: "0xsender",
        to: "0xrecipient",
        assets: [],
        reclaimAfter: 100,
        timelockUntil: 200,
      })
    ).toThrow("WASM not initialized");
  });

  it("creates a P2IDE note with reclaim and timelock options", () => {
    const result = createP2IDENote({
      from: "0xsender",
      to: "0xrecipient",
      assets: { token: "0xfaucet", amount: 10 },
      reclaimAfter: 1000,
      timelockUntil: 2000,
      type: "public",
    });
    expect(wasm.Note.createP2IDENote).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(), // NoteAssets instance
      1000,
      2000,
      "Public",
      expect.anything()
    );
    expect(wasm.NoteAssets).toHaveBeenCalledOnce();
    expect(result).toBe("p2ideNote");
  });

  it("uses attachment data when provided", () => {
    createP2IDENote({
      from: "0xsender",
      to: "0xrecipient",
      assets: { token: "0xfaucet", amount: 1 },
      reclaimAfter: 100,
      timelockUntil: 200,
      attachment: "myAttachment",
    });
    expect(wasm.NoteAttachment).toHaveBeenCalledWith("myAttachment");
  });

  it("defaults attachment to empty array when not provided", () => {
    createP2IDENote({
      from: "0xsender",
      to: "0xrecipient",
      assets: { token: "0xfaucet", amount: 1 },
      reclaimAfter: 100,
      timelockUntil: 200,
    });
    expect(wasm.NoteAttachment).toHaveBeenCalledWith([]);
  });
});

// ── buildSwapTag ──────────────────────────────────────────────────────────────

describe("buildSwapTag", () => {
  let wasm;

  beforeEach(() => {
    wasm = makeWasm();
    _setWasm(wasm);
  });

  afterEach(() => {
    _setWasm(null);
    _setWebClient(null);
  });

  it("throws when WASM is not initialized", () => {
    _setWasm(null);
    expect(() =>
      buildSwapTag({
        type: "public",
        offer: { token: "0xa", amount: 1 },
        request: { token: "0xb", amount: 2 },
      })
    ).toThrow("WASM not initialized");
  });

  it("throws when WebClient is not available", () => {
    _setWebClient(null);
    expect(() =>
      buildSwapTag({
        type: "public",
        offer: { token: "0xa", amount: 1 },
        request: { token: "0xb", amount: 2 },
      })
    ).toThrow("WebClient.buildSwapTag is not available");
  });

  it("throws when WebClient.buildSwapTag is not a function", () => {
    _setWebClient({ buildSwapTag: "not a function" });
    expect(() =>
      buildSwapTag({
        type: "public",
        offer: { token: "0xa", amount: 1 },
        request: { token: "0xb", amount: 2 },
      })
    ).toThrow("WebClient.buildSwapTag is not available");
  });

  it("calls WebClient.buildSwapTag with resolved params and returns result", () => {
    const mockBuildSwapTag = vi.fn().mockReturnValue("swapTag");
    _setWebClient({ buildSwapTag: mockBuildSwapTag });

    const result = buildSwapTag({
      type: "public",
      offer: { token: "0xofferedFaucet", amount: 10 },
      request: { token: "0xwantedFaucet", amount: 5 },
    });

    expect(mockBuildSwapTag).toHaveBeenCalledWith(
      "Public",
      expect.anything(), // offeredFaucetId
      BigInt(10),
      expect.anything(), // requestedFaucetId
      BigInt(5)
    );
    expect(result).toBe("swapTag");
  });
});

// ── isStandardPayment ─────────────────────────────────────────────────────────

describe("isStandardPayment", () => {
  const scriptWithRoot = (root) => ({ root: () => ({ toHex: () => root }) });
  const record = (root) => ({
    inputNoteRecord: () => ({
      details: () => ({
        recipient: () => ({ script: () => scriptWithRoot(root) }),
      }),
    }),
  });

  afterEach(() => {
    _setWasm(null);
  });

  it("checks the note against the loaded module's P2ID and P2IDE scripts", () => {
    _setWasm({
      NoteScript: {
        p2id: () => scriptWithRoot("0xp2id"),
        p2ide: () => scriptWithRoot("0xp2ide"),
      },
    });
    expect(isStandardPayment(record("0xp2id"))).toBe(true);
    expect(isStandardPayment(record("0xp2ide"))).toBe(true);
    expect(isStandardPayment(record("0xpswap"))).toBe(false);
  });

  it("throws when WASM is not initialized", () => {
    expect(() => isStandardPayment(record("0xp2id"))).toThrow(
      "WASM not initialized"
    );
  });
});

// ── domainSeparatedSignCommitment ─────────────────────────────────────────────

const TAG_U64S = [11n, 22n, 33n, 44n];

function makeSignWasm({ variant, blind, arbitrary, summary } = {}) {
  const calls = { hashed: [], arbitrary: [] };
  class Felt {
    constructor(v) {
      this.v = BigInt(v);
    }
    asInt() {
      return this.v;
    }
  }
  class FeltArray {
    constructor(items) {
      this.items = items;
    }
    length() {
      return this.items.length;
    }
    get(i) {
      return this.items[i];
    }
  }
  const wordOf = (u64s) => ({
    toFelts: () => u64s.map((u) => new Felt(u)),
  });
  const wasm = {
    Felt,
    FeltArray,
    Poseidon2: {
      hashElements: vi.fn((arr) => {
        calls.hashed.push(arr.items.map((f) => f.v));
        return wordOf(TAG_U64S);
      }),
    },
    Word: { deserialize: vi.fn(() => wordOf([1n, 2n, 3n, 4n])) },
    SigningInputsType: { TransactionSummary: 0, Arbitrary: 1, Blind: 2 },
    SigningInputs: {
      newArbitrary: vi.fn((felts) => {
        calls.arbitrary.push(felts.map((f) => f.v));
        return { toCommitment: () => ({ committed: calls.arbitrary.at(-1) }) };
      }),
      deserialize: vi.fn(() => ({
        variantType: variant,
        blindPayload: () => blind,
        arbitraryPayload: () => arbitrary,
        toCommitment: () => summary,
      })),
    },
  };
  return { wasm, calls };
}

describe("domainSeparatedSignCommitment", () => {
  afterEach(() => {
    _setWasm(null);
  });

  it("hashes the tag then the word for kind word", () => {
    const { wasm, calls } = makeSignWasm();
    _setWasm(wasm);
    const out = domainSeparatedSignCommitment(new Uint8Array([1]), "word");
    expect(calls.hashed[0]).toEqual(
      [..."miden-wallet/sign-bytes/v1"].map((c) => BigInt(c.charCodeAt(0)))
    );
    expect(calls.arbitrary[0]).toEqual([...TAG_U64S, 1n, 2n, 3n, 4n]);
    expect(out).toEqual({ committed: calls.arbitrary[0] });
  });

  it("returns a transaction summary's own commitment", () => {
    const summary = { summaryCommitment: true };
    const { wasm, calls } = makeSignWasm({ variant: 0, summary });
    _setWasm(wasm);
    expect(
      domainSeparatedSignCommitment(new Uint8Array([1]), "signingInputs")
    ).toBe(summary);
    expect(calls.arbitrary).toHaveLength(0);
  });

  it("domain-separates a Blind payload", () => {
    const { wasm, calls } = makeSignWasm({
      variant: 2,
      blind: { toFelts: () => [5n, 6n, 7n, 8n].map((v) => new wasmFelt(v)) },
    });
    function wasmFelt(v) {
      return new wasm.Felt(v);
    }
    _setWasm(wasm);
    domainSeparatedSignCommitment(new Uint8Array([1]), "signingInputs");
    expect(calls.arbitrary[0]).toEqual([...TAG_U64S, 5n, 6n, 7n, 8n]);
  });

  it("reads an Arbitrary payload from a browser FeltArray and from a Node array", () => {
    for (const asNode of [false, true]) {
      const { wasm, calls } = makeSignWasm({ variant: 1 });
      const felts = [5n, 6n, 7n].map((v) => new wasm.Felt(v));
      const payload = asNode ? felts : new wasm.FeltArray(felts);
      wasm.SigningInputs.deserialize = vi.fn(() => ({
        variantType: 1,
        arbitraryPayload: () => payload,
      }));
      _setWasm(wasm);
      domainSeparatedSignCommitment(new Uint8Array([1]), "signingInputs");
      expect(calls.arbitrary[0]).toEqual([...TAG_U64S, 5n, 6n, 7n]);
    }
  });

  it("builds fresh felts per call", () => {
    const { wasm } = makeSignWasm({ variant: 1 });
    const payload = [new wasm.Felt(5n)];
    wasm.SigningInputs.deserialize = vi.fn(() => ({
      variantType: 1,
      arbitraryPayload: () => payload,
    }));
    const seen = [];
    wasm.SigningInputs.newArbitrary = vi.fn((felts) => {
      seen.push(...felts);
      return { toCommitment: () => null };
    });
    _setWasm(wasm);
    domainSeparatedSignCommitment(new Uint8Array([1]), "signingInputs");
    expect(seen).not.toContain(payload[0]);
  });

  it("commits to the tag alone for an empty Arbitrary payload", () => {
    const { wasm, calls } = makeSignWasm({
      variant: 1,
      arbitrary: [],
    });
    _setWasm(wasm);
    domainSeparatedSignCommitment(new Uint8Array([1]), "signingInputs");
    expect(calls.arbitrary[0]).toEqual(TAG_U64S);
  });

  it("throws for an unknown kind or variant", () => {
    const { wasm } = makeSignWasm({ variant: 99 });
    _setWasm(wasm);
    expect(() =>
      domainSeparatedSignCommitment(new Uint8Array([1]), "raw")
    ).toThrow(/kind/);
    expect(() =>
      domainSeparatedSignCommitment(new Uint8Array([1]), "signingInputs")
    ).toThrow(/variant/);
  });

  it("throws when WASM is not initialized", () => {
    _setWasm(null);
    expect(() =>
      domainSeparatedSignCommitment(new Uint8Array([1]), "word")
    ).toThrow("WASM not initialized");
  });
});
