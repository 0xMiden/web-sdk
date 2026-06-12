import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  _setWasm,
  _setWebClient,
  createP2IDNote,
  createP2IDENote,
  buildSwapTag,
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
