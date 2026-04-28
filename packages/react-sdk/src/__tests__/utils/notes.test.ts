import { describe, it, expect, vi } from "vitest";
import { getNoteSummary, formatNoteSummary } from "../../utils/notes";
import type { NoteSummary } from "../../types";

const makeAsset = (faucetHex: string, amount: bigint) => ({
  faucetId: vi.fn(() => ({ toString: () => faucetHex })),
  amount: vi.fn(() => amount),
});

const makeInputNoteRecord = (opts: {
  id?: string;
  assets?: Array<{ faucetHex: string; amount: bigint }>;
  senderHex?: string;
  detailsThrows?: boolean;
}) => {
  const { id = "0xnote1", assets = [], senderHex, detailsThrows } = opts;
  return {
    id: vi.fn(() => ({ toString: () => id })),
    details: vi.fn(() => {
      if (detailsThrows) throw new Error("details unavailable");
      return {
        assets: () => ({
          fungibleAssets: () =>
            assets.map((a) => makeAsset(a.faucetHex, a.amount)),
        }),
      };
    }),
    metadata: senderHex
      ? vi.fn(() => ({ sender: () => ({ toString: () => senderHex }) }))
      : undefined,
  };
};

describe("getNoteSummary", () => {
  it("returns null when reading id() throws", () => {
    const note = {
      id: () => {
        throw new Error("boom");
      },
    } as never;
    expect(getNoteSummary(note)).toBeNull();
  });

  it("unwraps a ConsumableNoteRecord via inputNoteRecord()", () => {
    const inner = makeInputNoteRecord({ id: "0xinner", assets: [] });
    const consumable = {
      inputNoteRecord: vi.fn(() => inner),
    } as never;
    const summary = getNoteSummary(consumable);
    expect(summary?.id).toBe("0xinner");
  });

  it("returns id with empty assets list when no fungible assets", () => {
    const note = makeInputNoteRecord({ id: "0xnote_empty", assets: [] });
    const summary = getNoteSummary(note as never);
    expect(summary).toEqual({
      id: "0xnote_empty",
      assets: [],
      sender: undefined,
    });
  });

  it("populates assets from details().assets().fungibleAssets()", () => {
    const note = makeInputNoteRecord({
      id: "0xnote_with_assets",
      assets: [{ faucetHex: "0xfaucet1", amount: 100n }],
    });
    const summary = getNoteSummary(note as never);
    expect(summary?.assets).toHaveLength(1);
    expect(summary?.assets[0]).toMatchObject({
      assetId: "0xfaucet1",
      amount: 100n,
    });
  });

  it("annotates assets with metadata when getAssetMetadata returns a match", () => {
    const note = makeInputNoteRecord({
      id: "0xnote_meta",
      assets: [{ faucetHex: "0xfaucet1", amount: 100n }],
    });
    const lookup = vi.fn((id: string) =>
      id === "0xfaucet1" ? { symbol: "TKN", decimals: 6 } : undefined
    );
    const summary = getNoteSummary(note as never, lookup);
    expect(summary?.assets[0]).toMatchObject({
      symbol: "TKN",
      decimals: 6,
    });
  });

  it("leaves assets empty when details() throws", () => {
    const note = makeInputNoteRecord({
      id: "0xnote_no_details",
      detailsThrows: true,
    });
    const summary = getNoteSummary(note as never);
    expect(summary?.id).toBe("0xnote_no_details");
    expect(summary?.assets).toEqual([]);
  });

  it("extracts sender from metadata().sender()", () => {
    const note = makeInputNoteRecord({
      id: "0xnote_with_sender",
      senderHex: "0xsender_hex",
    });
    const summary = getNoteSummary(note as never);
    expect(summary?.sender).toBeDefined();
    expect(typeof summary?.sender).toBe("string");
  });

  it("leaves sender undefined when metadata() is missing", () => {
    const note = makeInputNoteRecord({ id: "0xnote_no_meta" });
    const summary = getNoteSummary(note as never);
    expect(summary?.sender).toBeUndefined();
  });
});

describe("formatNoteSummary", () => {
  const baseSummary: NoteSummary = {
    id: "0xnote",
    assets: [],
    sender: undefined,
  };

  it("returns just the id when there are no assets", () => {
    expect(formatNoteSummary(baseSummary)).toBe("0xnote");
  });

  it("uses the default formatter for a single asset (with symbol)", () => {
    const summary: NoteSummary = {
      id: "0xnote",
      assets: [
        { assetId: "0xfaucet", amount: 100n, symbol: "TKN", decimals: 0 },
      ],
      sender: undefined,
    };
    expect(formatNoteSummary(summary)).toBe("100 TKN");
  });

  it("falls back to assetId when symbol is missing", () => {
    const summary: NoteSummary = {
      id: "0xnote",
      assets: [{ assetId: "0xfaucet_only", amount: 100n }],
      sender: undefined,
    };
    expect(formatNoteSummary(summary)).toBe("100 0xfaucet_only");
  });

  it("joins multiple assets with ' + '", () => {
    const summary: NoteSummary = {
      id: "0xnote",
      assets: [
        { assetId: "0xfaucet1", amount: 1n, symbol: "A", decimals: 0 },
        { assetId: "0xfaucet2", amount: 2n, symbol: "B", decimals: 0 },
      ],
      sender: undefined,
    };
    expect(formatNoteSummary(summary)).toBe("1 A + 2 B");
  });

  it("appends sender when present", () => {
    const summary: NoteSummary = {
      id: "0xnote",
      assets: [{ assetId: "0xfaucet", amount: 1n, symbol: "A", decimals: 0 }],
      sender: "mid:abc",
    };
    expect(formatNoteSummary(summary)).toBe("1 A from mid:abc");
  });

  it("uses a custom formatter when provided", () => {
    const summary: NoteSummary = {
      id: "0xnote",
      assets: [{ assetId: "0xfaucet", amount: 5n }],
      sender: undefined,
    };
    const out = formatNoteSummary(summary, (a) => `<${a.amount}>`);
    expect(out).toBe("<5>");
  });
});
