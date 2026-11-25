// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("settings tests", () => {
  test("set and get setting", async ({ run }) => {
    const result = await run(async ({ client }) => {
      const testValue = [1, 2, 3, 4];
      await client.setSetting("test", testValue);
      const value = await client.getSetting("test");
      return {
        value: JSON.stringify(value),
        expected: JSON.stringify(testValue),
      };
    });
    expect(result.value).toEqual(result.expected);
  });

  test("set and list settings", async ({ run }) => {
    const result = await run(async ({ client }) => {
      const testKey = "test";
      await client.setSetting(testKey, [1, 2, 3, 4]);
      const keys = await client.listSettingKeys();
      return keys.includes(testKey);
    });
    expect(result).toBe(true);
  });

  test("remove setting", async ({ run }) => {
    const result = await run(async ({ client }) => {
      const testValue = [5, 6, 7, 8];
      await client.setSetting("test", testValue);
      await client.removeSetting("test");

      const resultAfterDelete = await client.getSetting("test");
      const listAfterDelete = await client.listSettingKeys();

      return {
        isUndefined: resultAfterDelete === undefined,
        includesTest: listAfterDelete.includes("test"),
      };
    });
    expect(result.isUndefined).toBe(true);
    expect(result.includesTest).toBe(false);
  });

  test("uninitialized WebClient browser errors are Error instances", async ({
    run,
  }, testInfo) => {
    test.skip(testInfo.project.name === "nodejs", "browser WASM error objects");

    const results = await run(async ({ sdk }) => {
      const wasm = await sdk.getWasmOrThrow();
      const uninit = new wasm.WebClient();
      const captureError = async (fn) => {
        try {
          await fn();
          return null;
        } catch (error) {
          return {
            isError: error instanceof Error,
            message: error?.message,
          };
        }
      };

      try {
        const getSetting = await captureError(() => uninit.getSetting("k"));
        const setSetting = await captureError(() =>
          uninit.setSetting("k", [1, 2, 3])
        );
        const keystore = await captureError(() => {
          void uninit.keystore;
        });
        return { getSetting, setSetting, keystore };
      } finally {
        uninit.free();
      }
    });

    expect(results.getSetting).toEqual({
      isError: true,
      message: "Client not initialized",
    });
    expect(results.setSetting).toEqual({
      isError: true,
      message: "Client not initialized",
    });
    expect(results.keystore).toEqual({
      isError: true,
      message: "Client not initialized",
    });
  });
});
