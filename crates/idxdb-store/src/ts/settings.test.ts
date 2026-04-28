import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase, CLIENT_VERSION_SETTING_KEY } from "./schema.js";
import {
  getSetting,
  insertSetting,
  removeSetting,
  listSettingKeys,
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

  it("returns null when key is missing", async () => {
    const dbId = await openTestDb();
    const result = await getSetting(dbId, "nope");
    expect(result).toBeNull();
  });

  it("inserts and retrieves a setting", async () => {
    const dbId = await openTestDb();
    const value = new Uint8Array([1, 2, 3]);
    await insertSetting(dbId, "k1", value);
    const got = await getSetting(dbId, "k1");
    expect(got).toEqual({ key: "k1", value: "AQID" });
  });

  it("upserts on duplicate key", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, "k1", new Uint8Array([1]));
    await insertSetting(dbId, "k1", new Uint8Array([2]));
    const got = await getSetting(dbId, "k1");
    expect(got!.value).toBe("Ag==");
  });

  it("removes a setting", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, "k1", new Uint8Array([1]));
    await removeSetting(dbId, "k1");
    expect(await getSetting(dbId, "k1")).toBeNull();
  });

  it("removeSetting on a missing key is a no-op", async () => {
    const dbId = await openTestDb();
    await removeSetting(dbId, "nope");
    // No throw means success.
  });

  it("listSettingKeys excludes internal keys", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, "user-a", new Uint8Array([1]));
    await insertSetting(dbId, "user-b", new Uint8Array([2]));
    await insertSetting(
      dbId,
      CLIENT_VERSION_SETTING_KEY,
      new Uint8Array([3])
    );
    const keys = await listSettingKeys(dbId);
    expect(keys).toEqual(expect.arrayContaining(["user-a", "user-b"]));
    expect(keys).not.toContain(CLIENT_VERSION_SETTING_KEY);
  });

  it("listSettingKeys returns empty list when no user keys are present", async () => {
    const dbId = await openTestDb();
    const keys = await listSettingKeys(dbId);
    expect(keys).toEqual([]);
  });

  it("getSetting throws on Dexie error (e.g., db not opened)", async () => {
    await expect(getSetting("never-opened", "k")).rejects.toThrow();
  });

  it("insertSetting throws on Dexie error", async () => {
    await expect(
      insertSetting("never-opened", "k", new Uint8Array([1]))
    ).rejects.toThrow();
  });

  it("removeSetting throws on Dexie error", async () => {
    await expect(removeSetting("never-opened", "k")).rejects.toThrow();
  });

  it("listSettingKeys throws on Dexie error", async () => {
    await expect(listSettingKeys("never-opened")).rejects.toThrow();
  });
});
