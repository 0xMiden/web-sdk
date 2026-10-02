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

export const parseAssetAmount = (input: string, decimals?: number): bigint => {
  const value = input.trim();
  if (!value) {
    throw new Error("Amount is required");
  }

  // Handle the sign separately so it applies to the full magnitude
  // (whole + fraction) rather than only the integer part. Splitting
  // "-5.25" into whole="-5" and fraction="25" and combining them with
  // `whole * factor + fraction` silently produces the wrong value
  // (-475 instead of -525), and drops the sign entirely when the whole
  // part is "-0" (e.g. "-0.5" would parse as +50).
  const isNegative = value.startsWith("-");
  const unsigned = isNegative ? value.slice(1) : value;

  if (!decimals || decimals <= 0) {
    if (unsigned.includes(".")) {
      throw new Error("Amount must be a whole number");
    }
    const magnitude = BigInt(unsigned);
    return isNegative ? -magnitude : magnitude;
  }

  const [wholeText, fractionText = ""] = unsigned.split(".");
  if (unsigned.split(".").length > 2) {
    throw new Error("Amount has too many decimal points");
  }

  const normalizedWhole = wholeText.length ? wholeText : "0";
  if (fractionText.length > decimals) {
    throw new Error("Amount has too many decimal places");
  }

  const paddedFraction = fractionText.padEnd(decimals, "0");
  const factor = 10n ** BigInt(decimals);

  const magnitude =
    BigInt(normalizedWhole) * factor + BigInt(paddedFraction || "0");
  return isNegative ? -magnitude : magnitude;
};
