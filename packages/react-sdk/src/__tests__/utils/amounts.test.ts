import { describe, it, expect } from "vitest";
import { formatAssetAmount, parseAssetAmount } from "../../utils/amounts";

describe("formatAssetAmount", () => {
  it("returns the bigint as string when decimals is omitted", () => {
    expect(formatAssetAmount(12345n)).toBe("12345");
  });

  it("returns the bigint as string when decimals is 0", () => {
    expect(formatAssetAmount(12345n, 0)).toBe("12345");
  });

  it("returns the bigint as string when decimals is negative", () => {
    expect(formatAssetAmount(12345n, -1)).toBe("12345");
  });

  it("converts a number argument to bigint", () => {
    expect(formatAssetAmount(42)).toBe("42");
  });

  it("formats with no fractional part as whole number", () => {
    // 100 with 2 decimals = 1.00 → "1"
    expect(formatAssetAmount(100n, 2)).toBe("1");
  });

  it("formats with fractional part", () => {
    // 12345 with 2 decimals = 123.45
    expect(formatAssetAmount(12345n, 2)).toBe("123.45");
  });

  it("strips trailing zeros from fractional part", () => {
    // 12300 with 2 decimals = 123.00 → "123"
    expect(formatAssetAmount(12300n, 2)).toBe("123");
    // 12340 with 2 decimals = 123.40 → "123.4"
    expect(formatAssetAmount(12340n, 2)).toBe("123.4");
  });

  it("pads short fractional with leading zeros", () => {
    // 105 with 4 decimals = 0.0105
    expect(formatAssetAmount(105n, 4)).toBe("0.0105");
  });

  it("handles very large bigint", () => {
    expect(formatAssetAmount(1_000_000_000_000n, 6)).toBe("1000000");
  });

  it("handles zero", () => {
    expect(formatAssetAmount(0n, 6)).toBe("0");
    expect(formatAssetAmount(0n)).toBe("0");
  });
});

describe("parseAssetAmount", () => {
  it("throws on empty input", () => {
    expect(() => parseAssetAmount("")).toThrow("Amount is required");
    expect(() => parseAssetAmount("   ")).toThrow("Amount is required");
  });

  it("parses whole number when decimals is omitted", () => {
    expect(parseAssetAmount("123")).toBe(123n);
  });

  it("parses whole number when decimals is 0", () => {
    expect(parseAssetAmount("123", 0)).toBe(123n);
  });

  it("rejects fractional input when decimals is omitted", () => {
    expect(() => parseAssetAmount("1.5")).toThrow("must be a whole number");
  });

  it("rejects fractional input when decimals is 0", () => {
    expect(() => parseAssetAmount("1.5", 0)).toThrow("must be a whole number");
  });

  it("rejects more than one decimal point", () => {
    expect(() => parseAssetAmount("1.2.3", 2)).toThrow("too many decimal points");
  });

  it("rejects fractional with too many decimals", () => {
    expect(() => parseAssetAmount("1.234", 2)).toThrow("too many decimal places");
  });

  it("parses whole-only with explicit decimals", () => {
    expect(parseAssetAmount("123", 2)).toBe(12300n);
  });

  it("parses whole.fraction with full decimals", () => {
    // 123.45 with 2 decimals → 12345
    expect(parseAssetAmount("123.45", 2)).toBe(12345n);
  });

  it("parses fractional with fewer decimals than allowed (right-pads)", () => {
    // 1.5 with 4 decimals → 15000
    expect(parseAssetAmount("1.5", 4)).toBe(15000n);
  });

  it("parses .5 (no whole part)", () => {
    expect(parseAssetAmount(".5", 2)).toBe(50n);
  });

  it("parses 5. (no fractional part after dot)", () => {
    expect(parseAssetAmount("5.", 2)).toBe(500n);
  });

  it("trims surrounding whitespace", () => {
    expect(parseAssetAmount("  42  ", 0)).toBe(42n);
  });

  it("round-trips with formatAssetAmount", () => {
    const cases: Array<[string, number]> = [
      ["123.45", 2],
      ["1000000", 6],
      ["0.0001", 4],
      ["999", 0],
    ];
    for (const [input, decimals] of cases) {
      const parsed = parseAssetAmount(input, decimals);
      expect(formatAssetAmount(parsed, decimals)).toBe(input);
    }
  });
});
