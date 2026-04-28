import { describe, it, expect } from "vitest";
import { formatAssetAmount, parseAssetAmount } from "../../utils/amounts";

describe("formatAssetAmount", () => {
  it("should return raw number as string when no decimals given", () => {
    expect(formatAssetAmount(1000n)).toBe("1000");
  });

  it("should return raw number as string when decimals is 0", () => {
    expect(formatAssetAmount(500n, 0)).toBe("500");
  });

  it("should return raw number as string when decimals is negative", () => {
    expect(formatAssetAmount(500n, -1)).toBe("500");
  });

  it("should accept a plain number as amount", () => {
    expect(formatAssetAmount(42, 0)).toBe("42");
  });

  it("should format whole number with decimals (no fractional part)", () => {
    // 1_0000_0000 with 8 decimals → 1
    expect(formatAssetAmount(100_000_000n, 8)).toBe("1");
  });

  it("should format with fractional part", () => {
    // 150_000_000 with 8 decimals → 1.5
    expect(formatAssetAmount(150_000_000n, 8)).toBe("1.5");
  });

  it("should strip trailing zeros from fractional part", () => {
    // 1_010_000_00 with 8 decimals → 1.01
    expect(formatAssetAmount(101_000_000n, 8)).toBe("1.01");
  });

  it("should handle zero amount", () => {
    expect(formatAssetAmount(0n, 8)).toBe("0");
  });

  it("should handle 2-decimal format", () => {
    // 150 with 2 decimals → 1.5
    expect(formatAssetAmount(150n, 2)).toBe("1.5");
  });

  it("should pad fraction correctly", () => {
    // 1_000_001 with 6 decimals → 1.000001
    expect(formatAssetAmount(1_000_001n, 6)).toBe("1.000001");
  });

  it("should handle sub-unit amounts (less than 1 whole unit)", () => {
    // 500_000 with 8 decimals → 0.005
    expect(formatAssetAmount(500_000n, 8)).toBe("0.005");
  });
});

describe("parseAssetAmount", () => {
  it("should parse whole number with no decimals", () => {
    expect(parseAssetAmount("1000")).toBe(1000n);
  });

  it("should parse whole number with decimals=0", () => {
    expect(parseAssetAmount("42", 0)).toBe(42n);
  });

  it("should throw when input is empty", () => {
    expect(() => parseAssetAmount("")).toThrow("Amount is required");
    expect(() => parseAssetAmount("   ")).toThrow("Amount is required");
  });

  it("should throw when decimal point in no-decimals mode", () => {
    expect(() => parseAssetAmount("1.5", 0)).toThrow(
      "Amount must be a whole number"
    );
    expect(() => parseAssetAmount("1.5")).toThrow(
      "Amount must be a whole number"
    );
  });

  it("should parse decimal amount", () => {
    // "1.5" with 8 decimals → 150_000_000
    expect(parseAssetAmount("1.5", 8)).toBe(150_000_000n);
  });

  it("should parse amount with no fractional part when decimals given", () => {
    expect(parseAssetAmount("1", 8)).toBe(100_000_000n);
  });

  it("should parse '.5' (empty whole part) with decimals", () => {
    expect(parseAssetAmount(".5", 2)).toBe(50n);
  });

  it("should throw for too many decimal points", () => {
    expect(() => parseAssetAmount("1.2.3", 8)).toThrow(
      "Amount has too many decimal points"
    );
  });

  it("should throw when fraction exceeds decimals precision", () => {
    // 3 decimal places but only 2 allowed
    expect(() => parseAssetAmount("1.123", 2)).toThrow(
      "Amount has too many decimal places"
    );
  });

  it("should handle trailing zeros in fraction", () => {
    // "1.50" with 2 decimals → 150
    expect(parseAssetAmount("1.50", 2)).toBe(150n);
  });

  it("should handle fractional part shorter than decimals (right-pad)", () => {
    // "1.5" with 6 decimals → 1_500_000
    expect(parseAssetAmount("1.5", 6)).toBe(1_500_000n);
  });

  it("should trim whitespace from input", () => {
    expect(parseAssetAmount("  100  ", 0)).toBe(100n);
  });

  it("should round-trip with formatAssetAmount", () => {
    const original = 123_456_789n;
    const formatted = formatAssetAmount(original, 8);
    const parsed = parseAssetAmount(formatted, 8);
    expect(parsed).toBe(original);
  });
});
