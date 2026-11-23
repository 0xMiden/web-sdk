// @ts-nocheck
import { test, expect } from "./test-setup";

// U64 ARGUMENT RANGE
// =======================================================================================================
//
// A BigInt argument outside 0..2^64 must throw a catchable error on both builds. The browser used to
// reduce it modulo 2^64 and Node aborted the process. See issue #466.

test.describe("u64 argument range", () => {
  test("out-of-range BigInt arguments throw and in-range ones are unchanged", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const faucetId = sdk.AccountId.fromHex(
        "0x4cbdcaffe75f0a317482224dae6436"
      );
      const attempt = (build) => {
        try {
          build();
          return "no error";
        } catch (error) {
          return String(error?.message ?? error);
        }
      };

      const tooBig = 2n ** 64n;
      const wraps = 2n ** 64n + 5n;
      return {
        feltNegative: attempt(() => new sdk.Felt(-1n)),
        feltTooBig: attempt(() => new sdk.Felt(tooBig)),
        feltWraps: attempt(() => new sdk.Felt(wraps)),
        assetWraps: attempt(() => new sdk.FungibleAsset(faucetId, wraps)),
        assetNegative: attempt(() => new sdk.FungibleAsset(faucetId, -1n)),
        feltInRange: new sdk.Felt(5n).asInt().toString(),
        assetInRange: new sdk.FungibleAsset(faucetId, 10n).amount().toString(),
      };
    });

    for (const key of [
      "feltNegative",
      "feltTooBig",
      "feltWraps",
      "assetWraps",
      "assetNegative",
    ]) {
      expect(result[key], key).toContain("outside the u64 range");
    }
    expect(result.feltInRange).toBe("5");
    expect(result.assetInRange).toBe("10");
  });
});
