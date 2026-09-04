import { describe, it, expect, afterEach, vi } from "vitest";
import Dexie from "dexie";
import {
  openDatabase,
  getDatabase,
  MidenDatabase,
  CLIENT_VERSION_SETTING_KEY,
  V1_STORES,
} from "./schema.js";
import { uniqueDbName } from "./test-utils.js";

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
  // v1 → v2: prunes note tags leaked by output-note registration
  // (miden-client < 0.15.4). See the version(2) block in schema.ts.
  it("v1 → v2 migration prunes leaked output-note tags", async () => {
    const name = uniqueDbName();

    // Step 1: seed a physical v1 database with the production v1 schema.
    const dbV1 = trackDb(new Dexie(name));
    dbV1.version(1).stores(V1_STORES);
    await dbV1.open();

    const leakedCommitment = "0x" + "aa".repeat(32);
    const pendingCommitment = "0x" + "bb".repeat(32);
    const inputOnlyCommitment = "0x" + "cc".repeat(32);

    await dbV1.table("outputNotes").bulkPut([
      // Consumed output note whose tag was leaked.
      {
        detailsCommitment: leakedCommitment,
        noteId: "0x1",
        stateDiscriminant: 3,
      },
      // Output note that is also a still-pending input note (self-transfer).
      {
        detailsCommitment: pendingCommitment,
        noteId: "0x2",
        stateDiscriminant: 0,
      },
    ]);
    await dbV1.table("inputNotes").bulkPut([
      // Expected (0) — inclusion-pending, its tags must survive.
      {
        detailsCommitment: pendingCommitment,
        noteId: "0x2",
        stateDiscriminant: 0,
      },
      // Expected input-only note — no output note matches, tag must survive.
      {
        detailsCommitment: inputOnlyCommitment,
        noteId: "0x3",
        stateDiscriminant: 0,
      },
    ]);
    await dbV1.table("tags").bulkPut([
      // Leaked: matches an output note, no pending input note needs it.
      { tag: "dGFnMQ==", sourceNoteId: leakedCommitment, sourceAccountId: "" },
      // Kept: matches an output note but a pending input note still needs it.
      { tag: "dGFnMg==", sourceNoteId: pendingCommitment, sourceAccountId: "" },
      // Kept: note-sourced but no output note matches.
      {
        tag: "dGFnMw==",
        sourceNoteId: inputOnlyCommitment,
        sourceAccountId: "",
      },
      // Kept: account-sourced tag.
      { tag: "dGFnNA==", sourceNoteId: "", sourceAccountId: "0xdeadbeef" },
      // Kept: user-sourced tag.
      { tag: "dGFnNQ==", sourceNoteId: "", sourceAccountId: "" },
    ]);

    dbV1.close();

    // Step 2: reopen through MidenDatabase, whose version chain includes v2.
    const mdb = trackMidenDb(new MidenDatabase(name));
    const success = await mdb.open("0.15.5");
    expect(success).toBe(true);

    const remaining = await mdb.tags.toArray();
    const remainingTags = remaining.map((t) => t.tag).sort();
    expect(remainingTags).toEqual([
      "dGFnMg==",
      "dGFnMw==",
      "dGFnNA==",
      "dGFnNQ==",
    ]);

    // Unrelated tables survive the upgrade untouched.
    expect(await mdb.outputNotes.count()).toBe(2);
    expect(await mdb.inputNotes.count()).toBe(2);
  });

  it("v2 upgrade is a no-op when there are no output notes", async () => {
    const name = uniqueDbName();

    const dbV1 = trackDb(new Dexie(name));
    dbV1.version(1).stores(V1_STORES);
    await dbV1.open();
    await dbV1.table("tags").put({
      tag: "dGFnMQ==",
      sourceNoteId: "0x" + "aa".repeat(32),
      sourceAccountId: "",
    });
    dbV1.close();

    const mdb = trackMidenDb(new MidenDatabase(name));
    await mdb.open("0.15.5");

    expect(await mdb.tags.count()).toBe(1);
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

  it("keeps the store on a same major.minor patch pin-back (0.15.9 → 0.15.8)", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "0.15.9");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);
    await db1.settings.put({
      key: "sentinel",
      value: new TextEncoder().encode("patch-keep"),
    });
    db1.dexie.close();

    const mdb2 = trackMidenDb(new MidenDatabase(name));
    const success = await mdb2.open("0.15.8");
    expect(success).toBe(true);

    const sentinel = await mdb2.settings.get("sentinel");
    expect(sentinel).toBeDefined();

    const versionRecord = await mdb2.settings.get(CLIENT_VERSION_SETTING_KEY);
    expect(new TextDecoder().decode(versionRecord!.value)).toBe("0.15.8");
  });
});

// ============================================================
// ensureClientVersion — stored version is newer than requested (downgrade path)
// ============================================================
describe("ensureClientVersion: stored version is newer (downgrade path)", () => {
  it("resets the store when downgrading across major.minor (2.0.0 → 1.9.0)", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "2.0.0");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);
    await db1.settings.put({
      key: "sentinel",
      value: new TextEncoder().encode("present"),
    });
    db1.dexie.close();

    const mdb2 = trackMidenDb(new MidenDatabase(name));
    await mdb2.open("1.9.0");

    const sentinel = await mdb2.settings.get("sentinel");
    expect(sentinel).toBeUndefined();
  });

  it("resets the store when downgrading from a prerelease to an older stable (0.16.0-rc.3 → 0.15.9)", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "0.16.0-rc.3");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);
    await db1.settings.put({
      key: "sentinel",
      value: new TextEncoder().encode("rc-data"),
    });
    db1.dexie.close();

    const mdb2 = trackMidenDb(new MidenDatabase(name));
    await mdb2.open("0.15.9");

    const sentinel = await mdb2.settings.get("sentinel");
    expect(sentinel).toBeUndefined();
  });

  it("wipes and reopens when dexie.open throws VersionError (newer on-disk schema)", async () => {
    const name = uniqueDbName();
    const mdb = trackMidenDb(new MidenDatabase(name));

    // fake-indexeddb softens schema downgrades; drive the real-browser path
    // Mustdzyl reported (RC Dexie v5 → 0.15.x v2) with an explicit VersionError.
    let openCalls = 0;
    const nativeOpen = mdb.dexie.open.bind(mdb.dexie);
    const openSpy = vi.spyOn(mdb.dexie, "open").mockImplementation(async () => {
      openCalls += 1;
      if (openCalls === 1) {
        const err = new Error(
          "The requested version (2) is less than the existing version (5)."
        );
        err.name = "VersionError";
        throw err;
      }
      return nativeOpen();
    });
    const deleteSpy = vi.spyOn(mdb.dexie, "delete");

    const success = await mdb.open("0.15.9");
    expect(success).toBe(true);
    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(openCalls).toBe(2);

    const versionRecord = await mdb.settings.get(CLIENT_VERSION_SETTING_KEY);
    expect(new TextDecoder().decode(versionRecord!.value)).toBe("0.15.9");

    openSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  it("resets when account headers exist but no clientVersion was stored", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "0.15.9");
    const db1 = getDatabase(name);
    openMidenDbs.push(db1);
    await db1.settings.delete(CLIENT_VERSION_SETTING_KEY);
    await db1.latestAccountHeaders.put({
      id: "0xabc",
      codeRoot: "c",
      storageRoot: "s",
      vaultRoot: "v",
      nonce: "0",
      committed: true,
      accountCommitment: "commit",
      locked: false,
      watched: false,
    });
    db1.dexie.close();

    const mdb2 = trackMidenDb(new MidenDatabase(name));
    const success = await mdb2.open("0.16.0-rc.7");
    expect(success).toBe(true);

    expect(await mdb2.latestAccountHeaders.count()).toBe(0);
    const versionRecord = await mdb2.settings.get(CLIENT_VERSION_SETTING_KEY);
    expect(new TextDecoder().decode(versionRecord!.value)).toBe("0.16.0-rc.7");
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
