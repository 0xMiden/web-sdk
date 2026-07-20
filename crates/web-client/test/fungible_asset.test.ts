// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("fungible asset callbacks", () => {
  test("defaults to disabled and round-trips through withCallbacks", async ({
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
      const faucetId = faucet.id();

      const asset = new sdk.FungibleAsset(faucetId, sdk.u64(10));
      const enabled = asset.withCallbacks(sdk.AssetCallbackFlag.Enabled);

      return {
        // The constructor never enables callbacks.
        defaultDisabled: asset.callbacks() === sdk.AssetCallbackFlag.Disabled,
        // withCallbacks reflects the requested flag.
        enabledFlag: enabled.callbacks() === sdk.AssetCallbackFlag.Enabled,
        // withCallbacks returns a copy — the original is unchanged.
        originalUntouched: asset.callbacks() === sdk.AssetCallbackFlag.Disabled,
        // The flag is the only thing that changes; faucet and amount survive.
        faucetPreserved: enabled.faucetId().toString() === faucetId.toString(),
        amountPreserved: enabled.amount() === asset.amount(),
      };
    });

    expect(result.defaultDisabled).toBe(true);
    expect(result.enabledFlag).toBe(true);
    expect(result.originalUntouched).toBe(true);
    expect(result.faucetPreserved).toBe(true);
    expect(result.amountPreserved).toBe(true);
  });
});
