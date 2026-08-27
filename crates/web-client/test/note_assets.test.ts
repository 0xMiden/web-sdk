// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("new note assets", () => {
  test("creates an asset list from valid, distinct assets", async ({
    run,
  }) => {
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
      const asset = new sdk.FungibleAsset(faucet.id(), sdk.u64(10));
      const assets = new sdk.NoteAssets([asset]);
      return { threw: false, count: assets.fungibleAssets().length };
    });
    expect(result.threw).toBe(false);
    expect(result.count).toBe(1);
  });

  test("throws instead of panicking when constructed with a duplicate asset", async ({
    run,
  }) => {
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
      const assetA = new sdk.FungibleAsset(faucet.id(), sdk.u64(10));
      const assetB = new sdk.FungibleAsset(faucet.id(), sdk.u64(20));
      try {
        new sdk.NoteAssets([assetA, assetB]);
        return { threw: false, message: "" };
      } catch (e) {
        return { threw: true, message: String(e) };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain("invalid note assets");
  });

  test("push throws instead of panicking when adding a duplicate asset", async ({
    run,
  }) => {
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
      const assetA = new sdk.FungibleAsset(faucet.id(), sdk.u64(10));
      const assetB = new sdk.FungibleAsset(faucet.id(), sdk.u64(20));
      const assets = new sdk.NoteAssets([assetA]);
      try {
        assets.push(assetB);
        return { threw: false, message: "" };
      } catch (e) {
        return { threw: true, message: String(e) };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain("invalid note assets");
  });
});
