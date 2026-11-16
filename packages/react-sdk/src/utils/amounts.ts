export const formatAssetAmount = (
  amount: bigint | number,
  decimals?: number
): string => {
  const amt = BigInt(amount);
  if (!decimals || decimals <= 0) {
    return amt.toString();
  }

  const isNegative = amt < 0n;
  const absAmt = isNegative ? -amt : amt;
  const sign = isNegative ? "-" : "";

  const factor = 10n ** BigInt(decimals);
  const whole = absAmt / factor;
  const fraction = absAmt % factor;

  if (fraction === 0n) {
    return `${sign}${whole.toString()}`;
  }

  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return `${sign}${whole.toString()}.${fractionText}`;
};

/**
 * Parses a user-entered amount into base units. Accepts an unsigned decimal
 * string: digits with at most one ".", and at most `decimals` digits after
 * it. Throws for an empty, negative or otherwise malformed amount.
 */
export const parseAssetAmount = (input: string, decimals?: number): bigint => {
  const value = input.trim();
  if (!value) {
    throw new Error("Amount is required");
  }
  if (value.startsWith("-")) {
    throw new Error("Amount must not be negative");
  }

  if (!decimals || decimals <= 0) {
    if (value.includes(".")) {
      throw new Error("Amount must be a whole number");
    }
    if (!/^\d+$/.test(value)) {
      throw new Error("Amount is not a valid number");
    }
    return BigInt(value);
  }

  const [wholeText, fractionText = ""] = value.split(".");
  if (value.split(".").length > 2) {
    throw new Error("Amount has too many decimal points");
  }

  const normalizedWhole = wholeText.length ? wholeText : "0";
  if (fractionText.length > decimals) {
    throw new Error("Amount has too many decimal places");
  }
  if (
    !/^\d*$/.test(wholeText) ||
    !/^\d*$/.test(fractionText) ||
    (!wholeText && !fractionText)
  ) {
    throw new Error("Amount is not a valid number");
  }

  const paddedFraction = fractionText.padEnd(decimals, "0");
  const factor = 10n ** BigInt(decimals);

  return BigInt(normalizedWhole) * factor + BigInt(paddedFraction || "0");
};
