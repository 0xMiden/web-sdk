import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  getSetting,
  insertSetting,
  removeSetting,
  listSettingKeys,
  getClientConfig,
  insertClientConfig,
  removeClientConfig,
} from "./settings.js";

let dbCounter = 0;
function uniqueDbName(): string {
  return `test-settings-${++dbCounter}-${Date.now()}`;
}

const openDbIds: string[] = [];

afterEach(async () => {
  for (const dbId of openDbIds) {
    const db = getDatabase(dbId);
    db.dexie.close();
    await db.dexie.delete();
  }
  openDbIds.length = 0;
});

async function openTestDb(): Promise<string> {
  const name = uniqueDbName();
  await openDatabase(name, "0.1.0");
  openDbIds.push(name);
  return name;
}

describe("settings", () => {
  let errorSpy: any;
  let logSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("stores, reads, lists and removes a user setting", async () => {
    const dbId = await openTestDb();
    expect(await getSetting(dbId, "k")).toBeNull();

    await insertSetting(dbId, "k", new Uint8Array([1]));
    await insertSetting(dbId, "k", new Uint8Array([2]));
    expect(await getSetting(dbId, "k")).toEqual({ key: "k", value: "Ag==" });
    expect(await listSettingKeys(dbId)).toEqual(["k"]);

    expect(await removeSetting(dbId, "k")).toBe(true);
    expect(await removeSetting(dbId, "k")).toBe(false);
    expect(await listSettingKeys(dbId)).toEqual([]);
  });

  it("stores, reads and removes a client value", async () => {
    const dbId = await openTestDb();
    expect(await getClientConfig(dbId, "rpc_limits")).toBeNull();

    await insertClientConfig(dbId, "rpc_limits", new Uint8Array([1]));
    expect(await getClientConfig(dbId, "rpc_limits")).toEqual({
      key: "rpc_limits",
      value: "AQ==",
    });

    expect(await removeClientConfig(dbId, "rpc_limits")).toBe(true);
    expect(await removeClientConfig(dbId, "rpc_limits")).toBe(false);
  });

  it("keeps the user settings apart from the client values", async () => {
    const dbId = await openTestDb();
    await insertClientConfig(dbId, "shared", new Uint8Array([1]));
    await insertSetting(dbId, "shared", new Uint8Array([2]));

    expect(await removeSetting(dbId, "shared")).toBe(true);
    expect(await getClientConfig(dbId, "shared")).toEqual({
      key: "shared",
      value: "AQ==",
    });
    // The client version that `openDatabase` stored stays out of the user settings.
    expect(await listSettingKeys(dbId)).toEqual([]);
  });

  it("rejects every operation on a database that was never opened", async () => {
    const value = new Uint8Array([1]);
    await expect(getSetting("never-opened", "k")).rejects.toThrow();
    await expect(insertSetting("never-opened", "k", value)).rejects.toThrow();
    await expect(removeSetting("never-opened", "k")).rejects.toThrow();
    await expect(listSettingKeys("never-opened")).rejects.toThrow();
    await expect(getClientConfig("never-opened", "k")).rejects.toThrow();
    await expect(
      insertClientConfig("never-opened", "k", value)
    ).rejects.toThrow();
    await expect(removeClientConfig("never-opened", "k")).rejects.toThrow();
  });
});
