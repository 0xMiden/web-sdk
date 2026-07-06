import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _setWasm, buildNetworkNote } from "../standalone.js";

function makeWasm() {
  const target = {
    targetId: vi.fn(() => "targetIdObj"),
    toAttachment: vi.fn(() => "targetAttachment"),
  };
  return {
    AccountId: {
      fromHex: vi.fn((h) => ({ hex: h })),
      fromBech32: vi.fn((b) => ({ bech32: b })),
    },
    NoteType: { Public: "Public", Private: "Private" },
    NetworkAccountTarget: vi.fn().mockImplementation(() => target),
    NoteTag: { withAccountTarget: vi.fn(() => "networkTag") },
    NoteMetadata: vi.fn().mockImplementation(() => "metadata"),
    NoteStorage: vi.fn().mockImplementation(() => "storage"),
    FeltArray: vi.fn().mockImplementation((items) => ({ feltArray: items })),
    NoteRecipient: { fromScript: vi.fn(() => "recipientFromScript") },
    NoteAttachment: vi.fn().mockImplementation((v) => ({ attachment: v })),
    NoteAssets: vi.fn().mockImplementation(() => "noteAssets"),
    FungibleAsset: vi.fn().mockImplementation(() => "fungibleAsset"),
    Note: { withAttachments: vi.fn(() => "networkNote") },
    __target: target,
  };
}

describe("buildNetworkNote", () => {
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
      buildNetworkNote({ account: "0xs", target: "0xt", script: "s" })
    ).toThrow("WASM not initialized");
  });

  it("throws when neither recipient nor script is provided", () => {
    expect(() => buildNetworkNote({ account: "0xs", target: "0xt" })).toThrow(
      /recipient.*script/i
    );
  });

  it("throws when both recipient and script are provided", () => {
    expect(() =>
      buildNetworkNote({
        account: "0xs",
        target: "0xt",
        recipient: "customRecipient",
        script: "myScript",
      })
    ).toThrow(/recipient.*script.*not both/i);
  });

  it("builds a network note from a script (fresh recipient, Public, target tag)", () => {
    const executionHint = "onBlockSlot";
    const note = buildNetworkNote({
      account: "0xs",
      target: "0xt",
      executionHint,
      script: "myScript",
      inputs: [1n],
    });
    expect(wasm.NetworkAccountTarget).toHaveBeenCalledWith(
      expect.anything(), // resolved account ref for "0xt"
      executionHint
    );
    expect(wasm.NoteTag.withAccountTarget).toHaveBeenCalledWith("targetIdObj");
    expect(wasm.NoteMetadata).toHaveBeenCalledWith(
      expect.anything(),
      "Public",
      "networkTag"
    );
    expect(wasm.NoteRecipient.fromScript).toHaveBeenCalledWith(
      "myScript",
      expect.anything() // NoteStorage instance
    );
    expect(wasm.Note.withAttachments).toHaveBeenCalledWith(
      expect.anything(), // NoteAssets instance
      expect.anything(), // NoteMetadata instance
      "recipientFromScript",
      ["targetAttachment"]
    );
    expect(note).toBe("networkNote");
  });

  it("uses a pre-built recipient and appends an extra attachment", () => {
    buildNetworkNote({
      account: "0xs",
      target: "0xt",
      recipient: "customRecipient",
      attachment: [9n],
    });
    expect(wasm.Note.withAttachments).toHaveBeenCalledWith(
      expect.anything(), // NoteAssets instance
      expect.anything(), // NoteMetadata instance
      "customRecipient",
      ["targetAttachment", { attachment: [9n] }]
    );
  });

  it("defaults to empty assets when none provided", () => {
    buildNetworkNote({ account: "0xs", target: "0xt", script: "s" });
    expect(wasm.NoteAssets).toHaveBeenCalledWith(); // no args -> empty
  });

  it("threads provided assets into the note instead of an empty NoteAssets", () => {
    buildNetworkNote({
      account: "0xs",
      target: "0xt",
      script: "s",
      assets: { token: "0xtoken", amount: 5 },
    });
    expect(wasm.FungibleAsset).toHaveBeenCalledWith(
      expect.anything(), // resolved faucet AccountId
      BigInt(5)
    );
    expect(wasm.NoteAssets).toHaveBeenCalledWith([expect.anything()]); // one FungibleAsset, not empty
  });

  it("uses a pre-built NetworkAccountTarget directly without reconstructing it", () => {
    const preBuilt = Object.create(wasm.NetworkAccountTarget.prototype);
    preBuilt.targetId = vi.fn(() => "preBuiltTargetId");
    preBuilt.toAttachment = vi.fn(() => "preBuiltAttachment");

    buildNetworkNote({
      account: "0xs",
      target: preBuilt,
      script: "s",
    });

    expect(wasm.NetworkAccountTarget).not.toHaveBeenCalled();
    expect(wasm.NoteTag.withAccountTarget).toHaveBeenCalledWith(
      "preBuiltTargetId"
    );
    expect(wasm.Note.withAttachments).toHaveBeenCalledWith(
      expect.anything(), // NoteAssets instance
      expect.anything(), // NoteMetadata instance
      expect.anything(), // recipient
      ["preBuiltAttachment"]
    );
  });
});
