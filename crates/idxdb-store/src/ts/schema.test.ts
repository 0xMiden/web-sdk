import { describe, it, expect, afterEach } from "vitest";
import Dexie from "dexie";
import {
  openDatabase,
  getDatabase,
  MidenDatabase,
  CLIENT_VERSION_SETTING_KEY,
} from "./schema.js";
import { uniqueDbName } from "./test-utils.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Track DBs for cleanup.
const openDbs: Dexie[] = [];

afterEach(async () => {
  for (const db of openDbs) {
    db.close();
    await db.delete();
  }
  openDbs.length = 0;
});

function trackDb(db: Dexie): Dexie {
  openDbs.push(db);
  return db;
}

// Track MidenDatabase instances separately (they wrap a Dexie under .dexie)
const openMidenDbs: MidenDatabase[] = [];

afterEach(async () => {
  for (const mdb of openMidenDbs) {
    mdb.dexie.close();
    await mdb.dexie.delete();
  }
  openMidenDbs.length = 0;
});

function trackMidenDb(mdb: MidenDatabase): MidenDatabase {
  openMidenDbs.push(mdb);
  return mdb;
}

describe("MidenDatabase migrations", () => {
  // Placeholder for the actual v1→v2 migration test. When the first real
  // migration is introduced, replace the dummy schema and upgrade logic below
  // with the production V1_STORES → V2 change. The test structure (create v1
  // DB, insert data, reopen as v2, verify data survived) stays the same.
  //
  // This uses a raw Dexie instance with a toy schema because there's no real
  // migration yet — the purpose is to validate the vitest + fake-indexeddb
  // test setup and provide a working template for future migration tests.
  it("v1 → v2 migration preserves data", async () => {
    const name = uniqueDbName();

    const testV1 = {
      items: "id,category",
      settings: "key",
    };

    // Step 1: Create a v1 database and insert test data
    const dbV1 = trackDb(new Dexie(name));
    dbV1.version(1).stores(testV1);
    await dbV1.open();

    await dbV1
      .table("items")
      .put({ id: "item-1", category: "a", name: "Alice" });
    await dbV1.table("items").put({ id: "item-2", category: "b", name: "Bob" });
    await dbV1
      .table("settings")
      .put({ key: "color", value: encoder.encode("blue") });

    dbV1.close();

    // Step 2: Open with v1 + v2 (v2 adds an index and a data transform)
    const dbV2 = trackDb(new Dexie(name));
    dbV2.version(1).stores(testV1);
    dbV2
      .version(2)
      .stores({ items: "id,category,name" })
      .upgrade((tx) => {
        return tx
          .table("items")
          .toCollection()
          .modify((record: Record<string, unknown>) => {
            if (!record.name) {
              record.name = "unknown";
            }
          });
      });
    await dbV2.open();

    // Verify data survived migration
    const item1 = await dbV2.table("items").get("item-1");
    expect(item1).toBeDefined();
    expect(item1.name).toBe("Alice");
    expect(item1.category).toBe("a");

    const item2 = await dbV2.table("items").get("item-2");
    expect(item2).toBeDefined();
    expect(item2.name).toBe("Bob");

    const setting = await dbV2.table("settings").get("color");
    expect(decoder.decode(setting.value)).toBe("blue");
  });
});

// ============================================================
// openDatabase
// ============================================================
describe("openDatabase", () => {
  it("opens a fresh database and registers it in the registry", async () => {
    const name = uniqueDbName();
    const dbId = await openDatabase(name, "1.0.0");
    openMidenDbs.push(getDatabase(dbId));
    expect(dbId).toBe(name);
    const db = getDatabase(dbId);
    expect(db).toBeDefined();
  });

  it("persists the client version on first open", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "1.0.0");
    const db = getDatabase(name);
    openMidenDbs.push(db);
    const record = await db.settings.get(CLIENT_VERSION_SETTING_KEY);
    expect(record).toBeDefined();
    expect(new TextDecoder().decode(record!.value)).toBe("1.0.0");
  });
});

// ============================================================
// ensureClientVersion — same version (no-op)
// ============================================================
describe("ensureClientVersion: same version already stored", () => {
  it("re-opening with the same version is a no-op", async () => {
    const name = uniqueDbName();
    // First open
    await openDatabase(name, "2.3.4");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);

    // Insert a sentinel row that should survive if the DB is NOT nuked
    await db1.settings.put({
      key: "sentinel",
      value: new TextEncoder().encode("alive"),
    });

    // Close and re-open with the same version
    db1.dexie.close();

    const mdb2 = trackMidenDb(new MidenDatabase(name));
    const success = await mdb2.open("2.3.4");
    expect(success).toBe(true);

    // Sentinel must still be there
    const sentinel = await mdb2.settings.get("sentinel");
    expect(sentinel).toBeDefined();
    expect(new TextDecoder().decode(sentinel!.value)).toBe("alive");
  });
});

// ============================================================
// ensureClientVersion — same major.minor, patch bump (update only)
// ============================================================
describe("ensureClientVersion: same major.minor, new patch", () => {
  it("updates persisted version without nuking the store", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "1.2.0");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);
    await db1.settings.put({
      key: "sentinel",
      value: new TextEncoder().encode("safe"),
    });
    db1.dexie.close();

    // Patch bump: 1.2.0 → 1.2.5
    const mdb2 = trackMidenDb(new MidenDatabase(name));
    const success = await mdb2.open("1.2.5");
    expect(success).toBe(true);

    // Sentinel must survive (no nuke)
    const sentinel = await mdb2.settings.get("sentinel");
    expect(sentinel).toBeDefined();

    // Version must be updated
    const versionRecord = await mdb2.settings.get(CLIENT_VERSION_SETTING_KEY);
    expect(new TextDecoder().decode(versionRecord!.value)).toBe("1.2.5");
  });
});

// ============================================================
// ensureClientVersion — stored version is newer than requested (downgrade path)
// ============================================================
describe("ensureClientVersion: stored version is newer (downgrade path)", () => {
  it("does not nuke on downgrade — updates persisted version only", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "2.0.0");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);
    await db1.settings.put({
      key: "sentinel",
      value: new TextEncoder().encode("present"),
    });
    db1.dexie.close();

    // Open with an older version (1.9.0 < 2.0.0)
    const mdb2 = trackMidenDb(new MidenDatabase(name));
    await mdb2.open("1.9.0");

    // The non-gt branch just persists the new version without nuking
    const sentinel = await mdb2.settings.get("sentinel");
    expect(sentinel).toBeDefined();
  });
});

// ============================================================
// ensureClientVersion — major version bump (nuke path)
// ============================================================
describe("ensureClientVersion: major version bump triggers nuke", () => {
  it("nukes the database and persists the new version", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "1.0.0");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);
    // Insert a sentinel row that should be GONE after nuke
    await db1.settings.put({
      key: "sentinel",
      value: new TextEncoder().encode("gone-after-nuke"),
    });
    db1.dexie.close();

    // Open with a new major version (2.0.0 > 1.0.0, different minor)
    const mdb2 = trackMidenDb(new MidenDatabase(name));
    const success = await mdb2.open("2.0.0");
    expect(success).toBe(true);

    // Sentinel should be gone (DB was nuked)
    const sentinel = await mdb2.settings.get("sentinel");
    expect(sentinel).toBeUndefined();

    // New version should be persisted
    const versionRecord = await mdb2.settings.get(CLIENT_VERSION_SETTING_KEY);
    expect(new TextDecoder().decode(versionRecord!.value)).toBe("2.0.0");
  });
});

// ============================================================
// ensureClientVersion — invalid semver strings (warn + nuke path)
// ============================================================
describe("ensureClientVersion: invalid semver strings", () => {
  it("falls through to nuke when stored version is not valid semver", async () => {
    const name = uniqueDbName();
    // First open with a non-semver string
    await openDatabase(name, "not-a-version");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);
    await db1.settings.put({
      key: "sentinel",
      value: new TextEncoder().encode("will-be-nuked"),
    });
    db1.dexie.close();

    // Re-open with a different non-semver string — triggers the else branch
    const mdb2 = trackMidenDb(new MidenDatabase(name));
    const success = await mdb2.open("also-not-a-version");
    expect(success).toBe(true);

    // After the nuke the sentinel is gone
    const sentinel = await mdb2.settings.get("sentinel");
    expect(sentinel).toBeUndefined();
  });
});

// ============================================================
// ensureClientVersion — empty clientVersion (warn + skip)
// ============================================================
describe("ensureClientVersion: empty clientVersion", () => {
  it("skips version enforcement when clientVersion is empty string", async () => {
    const name = uniqueDbName();
    const mdb = trackMidenDb(new MidenDatabase(name));
    // Pass empty string — should open successfully and skip enforcement
    const success = await mdb.open("");
    expect(success).toBe(true);

    // No version record should be stored
    const versionRecord = await mdb.settings.get(CLIENT_VERSION_SETTING_KEY);
    expect(versionRecord).toBeUndefined();
  });
});
