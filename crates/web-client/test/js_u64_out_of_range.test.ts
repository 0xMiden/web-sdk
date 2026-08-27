// @ts-nocheck
import { test, expect } from "./test-setup";

// Regression coverage for the js_u64_to_u64 fix: an out-of-range BigInt
// (negative, or >= 2^64) reaching any JsU64-typed parameter used to panic
// the WASM/native module. It must now throw a catchable JS error instead.
test.describe("out-of-range BigInt inputs throw instead of panicking", () => {
  test("Felt.new rejects a negative BigInt", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      try {
        new sdk.Felt(-1n);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: String(e) };
      }
    });
    expect(result.threw).toBe(true);
  });

  test("Felt.new rejects a BigInt >= 2^64", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      try {
        new sdk.Felt(1n << 64n);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: String(e) };
      }
    });
    expect(result.threw).toBe(true);
  });

  test("Felt.new still accepts a valid u64 BigInt", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      const felt = new sdk.Felt(sdk.u64(42));
      return { value: felt.asInt().toString() };
    });
    expect(result.value).toBe("42");
  });

  test("Word.new rejects an out-of-range element among otherwise valid ones", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      try {
        new sdk.Word([sdk.u64(1), sdk.u64(2), -1n, sdk.u64(4)]);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: String(e) };
      }
    });
    expect(result.threw).toBe(true);
  });

  test("FungibleAsset.new rejects an out-of-range amount", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.tryFromStr("public"),
        false,
        "DAG Token",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      try {
        new sdk.FungibleAsset(faucet.id(), -1n);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: String(e) };
      }
    });
    expect(result.threw).toBe(true);
  });

  test("TransactionStatus.committed rejects an out-of-range timestamp", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      try {
        sdk.TransactionStatus.committed(1, 1n << 64n);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: String(e) };
      }
    });
    expect(result.threw).toBe(true);
  });
});
