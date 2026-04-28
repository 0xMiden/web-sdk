import { describe, it, expect, vi } from "vitest";
import { getNoteSummary, formatNoteSummary } from "../../utils/notes";
import type { NoteSummary, NoteAsset } from "../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeInputNoteRecord = ({
  id = "0xnote1",
  assets = [] as Array<{ faucetId: string; amount: bigint }>,
  sender = undefined as string | undefined,
} = {}) => ({
  id: vi.fn(() => ({ toString: () => id })),
  details: vi.fn(() => ({
    assets: vi.fn(() => ({
      fungibleAssets: vi.fn(() =>
        assets.map((a) => ({
          faucetId: vi.fn(() => ({ toString: () => a.faucetId })),
          amount: vi.fn(() => a.amount),
        }))
      ),
    })),
  })),
  metadata: vi.fn(() =>
    sender
      ? {
          sender: vi.fn(() => ({ toString: vi.fn(() => sender) })),
        }
      : {}
  ),
});

const makeConsumableNoteRecord = (
  inner: ReturnType<typeof makeInputNoteRecord>
) => ({
  inputNoteRecord: vi.fn(() => inner),
});

// ---------------------------------------------------------------------------
// getNoteSummary
// ---------------------------------------------------------------------------

describe("getNoteSummary", () => {
  it("should return a summary with id and empty assets for bare note", () => {
    const note = makeInputNoteRecord({ id: "0xabc" });
    const summary = getNoteSummary(note as any);
    expect(summary).not.toBeNull();
    expect(summary!.id).toBe("0xabc");
    expect(summary!.assets).toEqual([]);
  });

  it("should unwrap ConsumableNoteRecord via inputNoteRecord()", () => {
    const inner = makeInputNoteRecord({ id: "0xinner" });
    const consumable = makeConsumableNoteRecord(inner);
    const summary = getNoteSummary(consumable as any);
    expect(summary!.id).toBe("0xinner");
  });

  it("should collect fungible assets with metadata", () => {
    const note = makeInputNoteRecord({
      id: "0xnote",
      assets: [{ faucetId: "0xfaucet", amount: 100n }],
    });
    const getAssetMetadata = vi.fn(() => ({
      symbol: "TKN",
      decimals: 8,
    }));
    const summary = getNoteSummary(note as any, getAssetMetadata as any);
    expect(summary!.assets).toHaveLength(1);
    expect(summary!.assets[0]).toMatchObject({
      assetId: "0xfaucet",
      amount: 100n,
      symbol: "TKN",
      decimals: 8,
    });
  });

  it("should collect assets without metadata (symbol/decimals undefined)", () => {
    const note = makeInputNoteRecord({
      assets: [{ faucetId: "0xfaucet2", amount: 50n }],
    });
    const summary = getNoteSummary(note as any);
    expect(summary!.assets[0].symbol).toBeUndefined();
    expect(summary!.assets[0].decimals).toBeUndefined();
  });

  it("should include sender from metadata", () => {
    const note = makeInputNoteRecord({ sender: "0xsender123" });
    const summary = getNoteSummary(note as any);
    // sender goes through toBech32AccountId which returns the string on error
    expect(summary!.sender).toBeDefined();
  });

  it("should return null when note.id throws", () => {
    const badNote = {
      id: vi.fn(() => {
        throw new Error("bad id");
      }),
      details: vi.fn(() => ({})),
      metadata: vi.fn(() => ({})),
    };
    expect(getNoteSummary(badNote as any)).toBeNull();
  });

  it("should handle details throwing — keep assets empty", () => {
    const note = {
      id: vi.fn(() => ({ toString: () => "0xid" })),
      details: vi.fn(() => {
        throw new Error("details error");
      }),
      metadata: vi.fn(() => ({})),
    };
    const summary = getNoteSummary(note as any);
    expect(summary).not.toBeNull();
    expect(summary!.assets).toEqual([]);
  });

  it("should handle missing metadata gracefully", () => {
    const note = {
      id: vi.fn(() => ({ toString: () => "0xid" })),
      details: vi.fn(() => ({
        assets: vi.fn(() => ({
          fungibleAssets: vi.fn(() => []),
        })),
      })),
      metadata: undefined,
    };
    const summary = getNoteSummary(note as any);
    expect(summary!.sender).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatNoteSummary
// ---------------------------------------------------------------------------

describe("formatNoteSummary", () => {
  it("should return the id when there are no assets", () => {
    const summary: NoteSummary = { id: "0xnote1", assets: [] };
    expect(formatNoteSummary(summary)).toBe("0xnote1");
  });

  it("should format single asset with symbol", () => {
    const asset: NoteAsset = {
      assetId: "0xfaucet",
      amount: 150_000_000n,
      symbol: "TKN",
      decimals: 8,
    };
    const summary: NoteSummary = { id: "0xnote1", assets: [asset] };
    // formatAssetAmount(150_000_000n, 8) === "1.5"
    expect(formatNoteSummary(summary)).toBe("1.5 TKN");
  });

  it("should fall back to assetId when no symbol", () => {
    const asset: NoteAsset = {
      assetId: "0xfaucetXYZ",
      amount: 100n,
    };
    const summary: NoteSummary = { id: "0xnote1", assets: [asset] };
    expect(formatNoteSummary(summary)).toBe("100 0xfaucetXYZ");
  });

  it("should append sender when present", () => {
    const asset: NoteAsset = {
      assetId: "0xfaucet",
      amount: 100n,
      symbol: "TKN",
    };
    const summary: NoteSummary = {
      id: "0xnote1",
      assets: [asset],
      sender: "miden1sender",
    };
    expect(formatNoteSummary(summary)).toBe("100 TKN from miden1sender");
  });

  it("should join multiple assets with +", () => {
    const assets: NoteAsset[] = [
      { assetId: "0xf1", amount: 50n, symbol: "AAA" },
      { assetId: "0xf2", amount: 25n, symbol: "BBB" },
    ];
    const summary: NoteSummary = { id: "0xnote1", assets };
    expect(formatNoteSummary(summary)).toBe("50 AAA + 25 BBB");
  });

  it("should use custom formatAsset when provided", () => {
    const asset: NoteAsset = { assetId: "0xfaucet", amount: 100n };
    const summary: NoteSummary = { id: "0xnote1", assets: [asset] };
    const custom = (a: NoteAsset) => `custom:${a.amount.toString()}`;
    expect(formatNoteSummary(summary, custom)).toBe("custom:100");
  });
});
