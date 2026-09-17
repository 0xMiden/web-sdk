import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import {
  openDatabase,
  getDatabase,
  SETTING_SCOPE_CLIENT,
  SETTING_SCOPE_USER,
} from "./schema.js";
import {
  getSetting,
  insertSetting,
  removeSetting,
  listSettingKeys,
  applySettingsMutations,
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

const USER = SETTING_SCOPE_USER;
const CLIENT = SETTING_SCOPE_CLIENT;

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
    const result = await getSetting(dbId, USER, "nope");
    expect(result).toBeNull();
  });

  it("inserts and retrieves a setting", async () => {
    const dbId = await openTestDb();
    const value = new Uint8Array([1, 2, 3]);
    await insertSetting(dbId, USER, "k1", value);
    const got = await getSetting(dbId, USER, "k1");
    expect(got).toEqual({ key: "k1", value: "AQID" });
  });

  it("upserts on duplicate key", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, USER, "k1", new Uint8Array([1]));
    await insertSetting(dbId, USER, "k1", new Uint8Array([2]));
    const got = await getSetting(dbId, USER, "k1");
    expect(got!.value).toBe("Ag==");
  });

  it("removes a setting, reporting that the key was present", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, USER, "k1", new Uint8Array([1]));
    expect(await removeSetting(dbId, USER, "k1")).toBe(true);
    expect(await getSetting(dbId, USER, "k1")).toBeNull();
  });

  it("removeSetting on a missing key is a no-op, and says so", async () => {
    const dbId = await openTestDb();
    // `Store::remove_setting` returns this verbatim, and callers distinguish
    // "deleted something" from "there was nothing to delete" by it — so a
    // no-op has to answer false rather than merely not throwing.
    expect(await removeSetting(dbId, USER, "nope")).toBe(false);
  });

  it("reports false on a second removal of the same key", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, USER, "k1", new Uint8Array([1]));
    expect(await removeSetting(dbId, USER, "k1")).toBe(true);
    expect(await removeSetting(dbId, USER, "k1")).toBe(false);
  });

  it("getSetting throws on Dexie error (e.g., db not opened)", async () => {
    await expect(getSetting("never-opened", USER, "k")).rejects.toThrow();
  });

  it("insertSetting throws on Dexie error", async () => {
    await expect(
      insertSetting("never-opened", USER, "k", new Uint8Array([1]))
    ).rejects.toThrow();
  });

  it("removeSetting throws on Dexie error", async () => {
    await expect(removeSetting("never-opened", USER, "k")).rejects.toThrow();
  });

  it("listSettingKeys throws on Dexie error", async () => {
    await expect(listSettingKeys("never-opened", USER)).rejects.toThrow();
  });

  // SCOPE ISOLATION
  // ==============================================================================================

  describe("scope isolation", () => {
    it("holds the same key in both scopes as two rows", async () => {
      const dbId = await openTestDb();
      await insertSetting(dbId, USER, "shared", new Uint8Array([1]));
      await insertSetting(dbId, CLIENT, "shared", new Uint8Array([2]));

      expect((await getSetting(dbId, USER, "shared"))!.value).toBe("AQ==");
      expect((await getSetting(dbId, CLIENT, "shared"))!.value).toBe("Ag==");
    });

    it("does not read across scopes", async () => {
      const dbId = await openTestDb();
      await insertSetting(dbId, CLIENT, "client-only", new Uint8Array([1]));
      expect(await getSetting(dbId, USER, "client-only")).toBeNull();
    });

    it("removes only the row in the scope asked for", async () => {
      const dbId = await openTestDb();
      await insertSetting(dbId, USER, "shared", new Uint8Array([1]));
      await insertSetting(dbId, CLIENT, "shared", new Uint8Array([2]));

      expect(await removeSetting(dbId, USER, "shared")).toBe(true);
      expect(await getSetting(dbId, USER, "shared")).toBeNull();
      expect((await getSetting(dbId, CLIENT, "shared"))!.value).toBe("Ag==");
    });

    it("lists only the keys of the scope asked for", async () => {
      const dbId = await openTestDb();
      await insertSetting(dbId, USER, "user-a", new Uint8Array([1]));
      await insertSetting(dbId, USER, "user-b", new Uint8Array([2]));
      await insertSetting(dbId, CLIENT, "client-a", new Uint8Array([3]));

      expect((await listSettingKeys(dbId, USER))!.sort()).toEqual([
        "user-a",
        "user-b",
      ]);

      // The client scope also holds this store's own `clientVersion` row.
      const clientKeys = await listSettingKeys(dbId, CLIENT);
      expect(clientKeys).toContain("client-a");
      expect(clientKeys).not.toContain("user-a");
      expect(clientKeys).not.toContain("user-b");
    });

    it("listSettingKeys returns an empty list for an empty scope", async () => {
      const dbId = await openTestDb();
      await insertSetting(dbId, CLIENT, "client-a", new Uint8Array([1]));
      expect(await listSettingKeys(dbId, USER)).toEqual([]);
    });
  });

  describe("applySettingsMutations", () => {
    it("applies a batch of set and remove mutations", async () => {
      const dbId = await openTestDb();
      await insertSetting(dbId, USER, "to-remove", new Uint8Array([9]));

      await applySettingsMutations(dbId, USER, [
        { kind: "set", key: "k1", value: new Uint8Array([1]) },
        { kind: "set", key: "k2", value: new Uint8Array([2]) },
        { kind: "remove", key: "to-remove" },
      ]);

      expect(await getSetting(dbId, USER, "k1")).toEqual({
        key: "k1",
        value: "AQ==",
      });
      expect(await getSetting(dbId, USER, "k2")).toEqual({
        key: "k2",
        value: "Ag==",
      });
      expect(await getSetting(dbId, USER, "to-remove")).toBeNull();
    });

    it("applies the batch inside the scope it was given", async () => {
      const dbId = await openTestDb();
      await insertSetting(dbId, CLIENT, "k1", new Uint8Array([9]));

      await applySettingsMutations(dbId, USER, [
        { kind: "set", key: "k1", value: new Uint8Array([1]) },
        { kind: "remove", key: "k1" },
      ]);

      // The client-scoped row of the same name is untouched by either mutation.
      expect((await getSetting(dbId, CLIENT, "k1"))!.value).toBe("CQ==");
    });

    it("overwrites an existing key via a set mutation", async () => {
      const dbId = await openTestDb();
      await insertSetting(dbId, USER, "k1", new Uint8Array([1]));

      await applySettingsMutations(dbId, USER, [
        { kind: "set", key: "k1", value: new Uint8Array([2]) },
      ]);

      const got = await getSetting(dbId, USER, "k1");
      expect(got!.value).toBe("Ag==");
    });

    it("removing a missing key is a no-op", async () => {
      const dbId = await openTestDb();
      await applySettingsMutations(dbId, USER, [
        { kind: "remove", key: "nope" },
      ]);
      expect(await getSetting(dbId, USER, "nope")).toBeNull();
    });

    it("is atomic: a failing mutation rolls back earlier ones in the batch", async () => {
      const dbId = await openTestDb();

      await expect(
        applySettingsMutations(dbId, USER, [
          { kind: "set", key: "k1", value: new Uint8Array([1]) },
          { kind: "bogus", key: "k2" },
        ])
      ).rejects.toThrow();

      expect(await getSetting(dbId, USER, "k1")).toBeNull();
    });

    it("throws when a set mutation is missing a value", async () => {
      const dbId = await openTestDb();
      await expect(
        applySettingsMutations(dbId, USER, [{ kind: "set", key: "k1" }])
      ).rejects.toThrow();
      expect(await getSetting(dbId, USER, "k1")).toBeNull();
    });

    it("throws on Dexie error (e.g., db not opened)", async () => {
      await expect(
        applySettingsMutations("never-opened", USER, [
          { kind: "set", key: "k", value: new Uint8Array([1]) },
        ])
      ).rejects.toThrow();
    });
  });
});
