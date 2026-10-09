// @ts-nocheck
import { test, expect } from "./test-setup";

// An out-of-range BigInt (negative, or >= 2^64) passed to a bigint parameter
// throws a catchable error on the Node.js build. The browser build receives a
// u64 already reduced by wasm-bindgen, so this spec runs on the napi build only.
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
    expect(result.message).toContain("outside the u64 range");
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
    expect(result.message).toContain("outside the u64 range");
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
    expect(result.message).toContain("outside the u64 range");
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
    expect(result.message).toContain("outside the u64 range");
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
    expect(result.message).toContain("outside the u64 range");
  });
});
