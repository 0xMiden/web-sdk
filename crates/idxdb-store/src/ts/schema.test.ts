import { describe, it, expect, afterEach, vi } from "vitest";
import Dexie from "dexie";
import {
  openDatabase,
  closeDatabase,
  getDatabase,
  MidenDatabase,
  CLIENT_VERSION_SETTING_KEY,
  MIGRATION_BASELINE,
  SETTING_SCOPE_CLIENT,
  SETTING_SCOPE_USER,
  V1_STORES,
} from "./schema.js";
import { uniqueDbName } from "./test-utils.js";

// The schema the version chain reaches at v6 and keeps through v8.
const V6_STORES: Record<string, string> = {
  ...V1_STORES,
  inputNotes:
    "detailsCommitment,noteId,nullifier,scriptRoot,stateDiscriminant,[consumedBlockHeight+consumedTxOrder+detailsCommitment]",
  settings: "[scope+key],scope",
  accountWitnesses: "&accountId",
};

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

afterEach(() => {
  vi.restoreAllMocks();
});

type CutoverReads = Record<
  string,
  (table: Dexie.Table) => PromiseLike<unknown>
>;

// A store that ran the v2, v3 or v4 upgrade lost its client version stamp with the v4 settings
// drop, so the v8 cutover clears it in the same upgrade transaction. This reads each named table
// as the cutover clears it, which is what the earlier upgrades left there.
async function openReadingAtCutover(
  name: string,
  reads: CutoverReads
): Promise<{ mdb: MidenDatabase; seen: Record<string, unknown> }> {
  const mdb = trackMidenDb(new MidenDatabase(name));
  const tablePrototype = Object.getPrototypeOf(mdb.tags) as Dexie.Table;
  const clear = tablePrototype.clear;
  const seen: Record<string, PromiseLike<unknown>> = {};
  const spy = vi.spyOn(tablePrototype, "clear").mockImplementation(function (
    this: Dexie.Table
  ) {
    const read = reads[this.name];
    if (!read) {
      return clear.call(this);
    }
    seen[this.name] = read(this);
    return seen[this.name].then(() => clear.call(this)) as ReturnType<
      Dexie.Table["clear"]
    >;
  });
  try {
    await mdb.dexie.open();
  } finally {
    spy.mockRestore();
  }
  expect(Object.keys(seen).sort()).toEqual(Object.keys(reads).sort());
  const values = await Promise.all(Object.values(seen));
  return {
    mdb,
    seen: Object.fromEntries(Object.keys(seen).map((k, i) => [k, values[i]])),
  };
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
    const { seen } = await openReadingAtCutover(name, {
      tags: (tags) => tags.toArray(),
      outputNotes: (notes) => notes.count(),
      inputNotes: (notes) => notes.count(),
    });

    const remainingTags = (seen.tags as { tag: string }[])
      .map((t) => t.tag)
      .sort();
    expect(remainingTags).toEqual([
      "dGFnMg==",
      "dGFnMw==",
      "dGFnNA==",
      "dGFnNQ==",
    ]);

    // Unrelated tables survive the upgrade untouched.
    expect(seen.outputNotes).toBe(2);
    expect(seen.inputNotes).toBe(2);
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

    const { seen } = await openReadingAtCutover(name, {
      tags: (tags) => tags.count(),
    });

    expect(seen.tags).toBe(1);
  });

  // v3: rekeys the input-note consumption index on detailsCommitment, which is what
  // `Store::get_input_note_after` seeks with. See the version(3) block in schema.ts.
  it("v3 migration rebuilds the consumption index on detailsCommitment", async () => {
    const name = uniqueDbName();
    const lowCommitment = "0x" + "aa".repeat(32);
    const highCommitment = "0x" + "ff".repeat(32);

    const dbV1 = trackDb(new Dexie(name));
    dbV1.version(1).stores(V1_STORES);
    await dbV1.open();

    // noteId order and detailsCommitment order disagree, so reading through the new index
    // yields an order the noteId-keyed one could not produce.
    await dbV1.table("inputNotes").bulkPut([
      {
        detailsCommitment: lowCommitment,
        noteId: "0xff",
        stateDiscriminant: 8,
        consumedBlockHeight: 1,
        consumedTxOrder: 0,
        consumerAccountId: "0xconsumer",
      },
      {
        detailsCommitment: highCommitment,
        noteId: "0xaa",
        stateDiscriminant: 8,
        consumedBlockHeight: 1,
        consumedTxOrder: 0,
        consumerAccountId: "0xconsumer",
      },
    ]);
    dbV1.close();

    const { seen } = await openReadingAtCutover(name, {
      inputNotes: (notes) =>
        notes
          .orderBy("[consumedBlockHeight+consumedTxOrder+detailsCommitment]")
          .toArray(),
    });

    // Rebuilding an index moves no rows.
    expect(
      (seen.inputNotes as { detailsCommitment: string }[]).map(
        (n) => n.detailsCommitment
      )
    ).toEqual([lowCommitment, highCommitment]);
  });

  // v4/v5: `settings` is rekeyed on `[scope+key]`, which Dexie can only do by dropping and
  // recreating the table. See the version(4) and version(5) blocks in schema.ts.
  it("v4/v5 migration rekeys settings by scope and drops the old rows", async () => {
    const name = uniqueDbName();

    const dbV1 = trackDb(new Dexie(name));
    dbV1.version(1).stores(V1_STORES);
    await dbV1.open();
    await dbV1.table("settings").put({
      key: "stale",
      value: new Uint8Array([1]),
    });
    dbV1.close();

    // The pre-scope row cannot be addressed under the new primary key, so it goes.
    const { mdb, seen } = await openReadingAtCutover(name, {
      settings: (settings) => settings.toArray(),
    });
    expect(seen.settings).toEqual([]);

    // The same name in each scope is now a separate row.
    await mdb.settings.bulkPut([
      {
        scope: SETTING_SCOPE_CLIENT,
        key: "shared",
        value: new Uint8Array([1]),
      },
      { scope: SETTING_SCOPE_USER, key: "shared", value: new Uint8Array([2]) },
    ]);
    const clientRow = await mdb.settings.get([SETTING_SCOPE_CLIENT, "shared"]);
    expect(clientRow!.value).toEqual(new Uint8Array([1]));
    const userRow = await mdb.settings.get([SETTING_SCOPE_USER, "shared"]);
    expect(userRow!.value).toEqual(new Uint8Array([2]));
  });

  // v6: account witness registry. A null witness is a registered account the sync has not
  // refreshed yet.
  it("v6 migration adds accountWitnesses", async () => {
    const name = uniqueDbName();

    const dbV1 = trackDb(new Dexie(name));
    dbV1.version(1).stores(V1_STORES);
    await dbV1.open();
    dbV1.close();

    const mdb = trackMidenDb(new MidenDatabase(name));
    await mdb.dexie.open();

    await mdb.accountWitnesses.add({ accountId: "0xacc", witness: null });
    expect(await mdb.accountWitnesses.get("0xacc")).toEqual({
      accountId: "0xacc",
      witness: null,
    });
  });

  // v7: drops the private-note relay queue a 0.17.1 client could leave behind. See the
  // version(7) block in schema.ts.
  it("v7 migration deletes only the client-scope note transport outbox row", async () => {
    const name = uniqueDbName();
    const outboxKey = "note_transport_outbox";

    const dbV6 = trackDb(new Dexie(name));
    dbV6.version(6).stores(V6_STORES);
    await dbV6.open();
    await dbV6.table("settings").bulkPut([
      // At or above MIGRATION_BASELINE, so ensureClientVersion keeps the store.
      {
        scope: SETTING_SCOPE_CLIENT,
        key: CLIENT_VERSION_SETTING_KEY,
        value: new TextEncoder().encode("0.17.1"),
      },
      {
        scope: SETTING_SCOPE_CLIENT,
        key: outboxKey,
        value: new Uint8Array([1]),
      },
      { scope: SETTING_SCOPE_USER, key: outboxKey, value: new Uint8Array([2]) },
      {
        scope: SETTING_SCOPE_CLIENT,
        key: "note_transport_cursors",
        value: new Uint8Array([3]),
      },
    ]);
    dbV6.close();

    const mdb = trackMidenDb(new MidenDatabase(name));
    expect(await mdb.open("0.17.2")).toBe(true);

    expect(await mdb.settings.get([SETTING_SCOPE_CLIENT, outboxKey])).toBe(
      undefined
    );
    expect(
      (await mdb.settings.get([SETTING_SCOPE_USER, outboxKey]))!.value
    ).toEqual(new Uint8Array([2]));
    expect(
      (await mdb.settings.get([
        SETTING_SCOPE_CLIENT,
        "note_transport_cursors",
      ]))!.value
    ).toEqual(new Uint8Array([3]));
    expect(await mdb.settings.count()).toBe(3);
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
    const record = await db.settings.get([
      SETTING_SCOPE_CLIENT,
      CLIENT_VERSION_SETTING_KEY,
    ]);
    expect(record).toBeDefined();
    expect(new TextDecoder().decode(record!.value)).toBe("1.0.0");
  });
});

describe("openDatabase / closeDatabase holders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a database open until its last holder closes it", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "1.0.0");
    await openDatabase(name, "1.0.0");
    const db = trackMidenDb(getDatabase(name));

    closeDatabase(name);
    expect(getDatabase(name)).toBe(db);
    expect(db.dexie.isOpen()).toBe(true);

    closeDatabase(name);
    expect(db.dexie.isOpen()).toBe(false);
    expect(() => getDatabase(name)).toThrow(/Database not found/);
  });

  it("opens one connection for concurrent opens of the same name", async () => {
    const name = uniqueDbName();
    const openSpy = vi.spyOn(MidenDatabase.prototype, "open");

    await Promise.all([
      openDatabase(name, "1.0.0"),
      openDatabase(name, "1.0.0"),
    ]);
    expect(openSpy).toHaveBeenCalledTimes(1);

    const db = trackMidenDb(getDatabase(name));
    closeDatabase(name);
    expect(db.dexie.isOpen()).toBe(true);
    closeDatabase(name);
    expect(db.dexie.isOpen()).toBe(false);
  });

  it("leaves the registered database in place when a reopen fails", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "1.0.0");
    const first = trackMidenDb(getDatabase(name));
    // A connection closed elsewhere makes the next open a real one.
    first.dexie.close();

    let failed: MidenDatabase | undefined;
    vi.spyOn(MidenDatabase.prototype, "open").mockImplementationOnce(
      async function (this: MidenDatabase) {
        failed = this;
        await this.dexie.open();
        throw new Error("open failed");
      }
    );

    await expect(openDatabase(name, "1.0.0")).rejects.toThrow("open failed");
    expect(getDatabase(name)).toBe(first);
    expect(failed).toBeDefined();
    expect(failed!.dexie.isOpen()).toBe(false);
  });

  it("replaces a registered database whose connection was closed elsewhere", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "1.0.0");
    const first = trackMidenDb(getDatabase(name));
    first.dexie.close();

    await openDatabase(name, "1.0.0");
    const second = trackMidenDb(getDatabase(name));
    expect(second).not.toBe(first);
    expect(second.dexie.isOpen()).toBe(true);

    // The first holder still holds the name, so one close keeps it open.
    closeDatabase(name);
    expect(second.dexie.isOpen()).toBe(true);
    closeDatabase(name);
    expect(second.dexie.isOpen()).toBe(false);
  });

  it("closes a replaced connection that reopened while the fresh open was in flight", async () => {
    const name = uniqueDbName();
    await openDatabase(name, "1.0.0");
    const first = trackMidenDb(getDatabase(name));
    first.dexie.close();

    const reopening = openDatabase(name, "1.0.0");
    await first.dexie.open();
    await reopening;

    const second = trackMidenDb(getDatabase(name));
    expect(second).not.toBe(first);
    expect(first.dexie.isOpen()).toBe(false);
  });

  it("ignores a close for a name that was never opened", () => {
    expect(() => closeDatabase(uniqueDbName())).not.toThrow();
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
      scope: SETTING_SCOPE_USER,
      key: "sentinel",
      value: new TextEncoder().encode("alive"),
    });

    // Close and re-open with the same version
    db1.dexie.close();

    const mdb2 = trackMidenDb(new MidenDatabase(name));
    const success = await mdb2.open("2.3.4");
    expect(success).toBe(true);

    // Sentinel must still be there
    const sentinel = await mdb2.settings.get([SETTING_SCOPE_USER, "sentinel"]);
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
      scope: SETTING_SCOPE_USER,
      key: "sentinel",
      value: new TextEncoder().encode("safe"),
    });
    db1.dexie.close();

    // Patch bump: 1.2.0 → 1.2.5
    const mdb2 = trackMidenDb(new MidenDatabase(name));
    const success = await mdb2.open("1.2.5");
    expect(success).toBe(true);

    // Sentinel must survive (no nuke)
    const sentinel = await mdb2.settings.get([SETTING_SCOPE_USER, "sentinel"]);
    expect(sentinel).toBeDefined();

    // Version must be updated
    const versionRecord = await mdb2.settings.get([
      SETTING_SCOPE_CLIENT,
      CLIENT_VERSION_SETTING_KEY,
    ]);
    expect(new TextDecoder().decode(versionRecord!.value)).toBe("1.2.5");
  });
});

const AUTH_SENTINEL = {
  pubKeyCommitmentHex: "0xkey",
  secretKeyHex: "0xsecret",
};
const USER_SENTINEL = {
  scope: SETTING_SCOPE_USER,
  key: "sentinel",
  value: new Uint8Array([1]),
};
// The checkpoint the populate hook seeds a fresh store with.
const FRESH_CHECKPOINT = {
  id: 1,
  blockNum: 0,
  partialBlockchainPeaks: new Uint8Array(),
};

function stampRow(version: string) {
  return {
    scope: SETTING_SCOPE_CLIENT,
    key: CLIENT_VERSION_SETTING_KEY,
    value: new TextEncoder().encode(version),
  };
}

// Creates a store stamped with `version` that holds a key and a user setting.
async function stampedStore(version: string): Promise<string> {
  const name = uniqueDbName();
  const mdb = trackMidenDb(new MidenDatabase(name));
  expect(await mdb.open(version)).toBe(true);
  await mdb.accountAuths.put(AUTH_SENTINEL);
  await mdb.settings.put(USER_SENTINEL);
  mdb.dexie.close();
  return name;
}

// Creates a store as a 0.17 client left it before the cutover: schema version 7, stamped with
// `version` (unstamped for null), holding a key, a user setting, a tag and a synced checkpoint.
async function v7Store(version: string | null): Promise<string> {
  const name = uniqueDbName();
  const db = trackDb(new Dexie(name));
  db.version(7).stores(V6_STORES);
  await db.open();
  await db.table("accountAuth").put(AUTH_SENTINEL);
  await db.table("settings").put(USER_SENTINEL);
  await db.table("tags").put({ tag: "dGFnMQ==", sourceAccountId: "0xacc" });
  await db.table("blockchainCheckpoint").put({
    id: 1,
    blockNum: 42,
    partialBlockchainPeaks: new Uint8Array([7]),
  });
  if (version !== null) {
    await db.table("settings").put(stampRow(version));
  }
  db.close();
  return name;
}

async function reopen(name: string, version: string): Promise<MidenDatabase> {
  const mdb = trackMidenDb(new MidenDatabase(name));
  expect(await mdb.open(version)).toBe(true);
  return mdb;
}

async function storedVersion(mdb: MidenDatabase): Promise<string | undefined> {
  const record = await mdb.settings.get([
    SETTING_SCOPE_CLIENT,
    CLIENT_VERSION_SETTING_KEY,
  ]);
  return record && new TextDecoder().decode(record.value);
}

async function expectKept(mdb: MidenDatabase, version: string) {
  expect(await mdb.accountAuths.toArray()).toEqual([AUTH_SENTINEL]);
  expect(await mdb.settings.get([SETTING_SCOPE_USER, "sentinel"])).toEqual(
    USER_SENTINEL
  );
  expect(await storedVersion(mdb)).toBe(version);
}

// Every table is empty but for what a fresh store holds and the running version's stamp.
async function expectCleared(mdb: MidenDatabase, version: string) {
  for (const table of mdb.dexie.tables) {
    if (table.name !== "blockchainCheckpoint" && table.name !== "settings") {
      expect(await table.count(), table.name).toBe(0);
    }
  }
  expect(await mdb.blockchainCheckpoint.toArray()).toEqual([FRESH_CHECKPOINT]);
  expect(await mdb.settings.toArray()).toEqual([stampRow(version)]);
}

// The notices a clear of the store logs.
function clearNotices(
  warn: { mock: { calls: unknown[][] } },
  name: string
): number {
  return warn.mock.calls.filter((args) =>
    String(args[0]).includes(`IndexedDB store ${name}:`)
  ).length;
}

describe("the v8 cutover", () => {
  it.each(["0.16.2", "0.17.0-rc.5"])(
    "clears a v7 store stamped %s in place, seeds it as a fresh store and keeps it from then on",
    async (stored) => {
      const name = await v7Store(stored);
      const deleteSpy = vi.spyOn(Dexie.prototype, "delete");
      const warn = vi.spyOn(console, "warn");

      const cleared = await reopen(name, "0.17.4");
      await expectCleared(cleared, "0.17.4");
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(clearNotices(warn, name)).toBe(1);

      await cleared.accountAuths.put(AUTH_SENTINEL);
      await cleared.settings.put(USER_SENTINEL);
      cleared.dexie.close();
      await expectKept(await reopen(name, "0.17.5"), "0.17.5");
      expect(clearNotices(warn, name)).toBe(1);
    }
  );

  it("clears a v7 store with no client version stamp", async () => {
    const name = await v7Store(null);
    await expectCleared(await reopen(name, "0.17.4"), "0.17.4");
  });

  it("clears a v1-era store whose stamp the v4 settings drop removed", async () => {
    const name = uniqueDbName();
    const dbV1 = trackDb(new Dexie(name));
    dbV1.version(1).stores(V1_STORES);
    await dbV1.open();
    await dbV1.table("accountAuth").put(AUTH_SENTINEL);
    await dbV1.table("settings").put({
      key: CLIENT_VERSION_SETTING_KEY,
      value: new TextEncoder().encode("0.15.5"),
    });
    dbV1.close();
    const deleteSpy = vi.spyOn(Dexie.prototype, "delete");

    await expectCleared(await reopen(name, "0.17.4"), "0.17.4");
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["0.17.3", "0.17.4"],
    [MIGRATION_BASELINE, "0.17.4"],
    ["0.18.0-rc.1", "0.18.0"],
    ["not-a-version", "0.17.4"],
  ])("keeps a v7 store stamped %s and stamps %s", async (stored, running) => {
    const name = await v7Store(stored);
    const warn = vi.spyOn(console, "warn");

    const kept = await reopen(name, running);
    await expectKept(kept, running);
    expect(await kept.tags.count()).toBe(1);
    expect((await kept.blockchainCheckpoint.get(1))!.blockNum).toBe(42);
    expect(clearNotices(warn, name)).toBe(0);
  });

  it("populates and stamps a fresh store without clearing it", async () => {
    const name = uniqueDbName();
    const deleteSpy = vi.spyOn(Dexie.prototype, "delete");
    const warn = vi.spyOn(console, "warn");

    const mdb = await reopen(name, "0.17.4");
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await mdb.blockchainCheckpoint.toArray()).toEqual([
      FRESH_CHECKPOINT,
    ]);
    expect(await storedVersion(mdb)).toBe("0.17.4");
    expect(clearNotices(warn, name)).toBe(0);
  });

  it("clears a store once when two connections open it concurrently", async () => {
    const name = await v7Store("0.16.2");
    const warn = vi.spyOn(console, "warn");
    const first = trackMidenDb(new MidenDatabase(name));
    const second = trackMidenDb(new MidenDatabase(name));
    const written = { pubKeyCommitmentHex: "0xnew", secretKeyHex: "0xnew" };

    const firstOpenAndWrite = first.open("0.17.4").then(async (opened) => {
      await first.accountAuths.put(written);
      return opened;
    });
    const secondOpen = second.open("0.17.4");
    expect(await Promise.all([firstOpenAndWrite, secondOpen])).toEqual([
      true,
      true,
    ]);

    expect(clearNotices(warn, name)).toBe(1);
    expect(first.dexie.isOpen()).toBe(true);
    expect(second.dexie.isOpen()).toBe(true);
    expect(await second.accountAuths.toArray()).toEqual([written]);
    expect(await storedVersion(second)).toBe("0.17.4");
  });
});

describe("ensureClientVersion: a store that ran the cutover is kept", () => {
  it.each([
    ["a minor upgrade", "0.17.3", "0.18.0"],
    ["a major upgrade", "0.17.3", "1.0.0"],
    ["a downgrade", "0.18.0", "0.17.4"],
    ["an upgrade from the baseline itself", MIGRATION_BASELINE, "0.17.4"],
    ["a prerelease upgrade", "0.18.0-rc.1", "0.18.0"],
  ])(
    "keeps every table across %s (%s to %s) and stamps the running version",
    async (_, stored, running) => {
      const name = await stampedStore(stored);
      await expectKept(await reopen(name, running), running);
    }
  );

  it("keeps it when an older client stamped it below the baseline", async () => {
    const name = await stampedStore("0.17.4");
    const older = trackMidenDb(new MidenDatabase(name));
    await older.dexie.open();
    await older.settings.put(stampRow("0.16.2"));
    older.dexie.close();
    const warn = vi.spyOn(console, "warn");

    await expectKept(await reopen(name, "0.17.5"), "0.17.5");
    expect(clearNotices(warn, name)).toBe(0);
  });

  it("keeps an unstamped store", async () => {
    const name = uniqueDbName();
    const unstamped = trackMidenDb(new MidenDatabase(name));
    await unstamped.dexie.open();
    await unstamped.accountAuths.put(AUTH_SENTINEL);
    await unstamped.settings.put(USER_SENTINEL);
    unstamped.dexie.close();

    await expectKept(await reopen(name, "0.17.4"), "0.17.4");
  });
});

describe("ensureClientVersion: invalid semver strings", () => {
  it.each([
    ["stored", "not-a-version", "0.17.4"],
    ["running", "0.17.3", "not-a-version"],
  ])(
    "keeps every table when the %s version is not valid semver",
    async (_, stored, running) => {
      const name = await stampedStore(stored);
      await expectKept(await reopen(name, running), running);
    }
  );
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
    expect(await storedVersion(mdb)).toBeUndefined();
  });
});

describe("a store written by a newer client", () => {
  const NEWER_CLIENT_ERROR =
    /written by a newer Miden client \(schema version 99; this client reads up to \d+\)\. Nothing was deleted\. Upgrade the Miden SDK/;

  // A newer schema without a table this client declares, which Dexie patches back in, raising
  // the native version, if it opens the store.
  async function newerStore() {
    const name = uniqueDbName();
    const newer = trackDb(new Dexie(name));
    newer.version(99).stores({ ...V6_STORES, accountWitnesses: null });
    await newer.open();
    await newer.table("accountAuth").put(AUTH_SENTINEL);
    newer.close();
    return name;
  }

  async function nativeVersion(name: string) {
    const databases = await Dexie.dependencies.indexedDB.databases();
    return databases.find((info) => info.name === name)?.version;
  }

  async function expectDataInPlace(name: string) {
    expect(await Dexie.exists(name)).toBe(true);
    const raw = trackDb(new Dexie(name));
    await raw.open();
    expect(await raw.table("accountAuth").toArray()).toEqual([AUTH_SENTINEL]);
  }

  it("refuses it before Dexie opens it, leaving its version and rows as they were", async () => {
    const name = await newerStore();

    await expect(openDatabase(name, "0.17.4")).rejects.toThrow(
      NEWER_CLIENT_ERROR
    );
    expect(() => getDatabase(name)).toThrow(/Database not found/);
    expect(await nativeVersion(name)).toBe(990);
    await expectDataInPlace(name);
  });

  it("refuses it through the ready hook where indexedDB.databases() is missing", async () => {
    const name = await newerStore();
    const factory = Dexie.dependencies.indexedDB as { databases?: unknown };
    Object.defineProperty(factory, "databases", {
      value: undefined,
      configurable: true,
    });
    try {
      const mdb = trackMidenDb(new MidenDatabase(name));
      await expect(mdb.open("0.17.4")).rejects.toThrow(NEWER_CLIENT_ERROR);
    } finally {
      delete factory.databases;
    }
    await expectDataInPlace(name);
  });

  async function withDatabases<T>(
    databases: () => Promise<unknown>,
    run: () => Promise<T>
  ): Promise<T> {
    const factory = Dexie.dependencies.indexedDB as { databases?: unknown };
    Object.defineProperty(factory, "databases", {
      value: databases,
      configurable: true,
    });
    try {
      return await run();
    } finally {
      delete factory.databases;
    }
  }

  it("falls back to the ready hook when indexedDB.databases() rejects", async () => {
    const name = await newerStore();
    await withDatabases(
      () => Promise.reject(new Error("databases() unsupported")),
      async () => {
        const mdb = trackMidenDb(new MidenDatabase(name));
        await expect(mdb.open("0.17.4")).rejects.toThrow(NEWER_CLIENT_ERROR);
      }
    );
    await expectDataInPlace(name);
  });

  it("does not wait on an indexedDB.databases() that never answers", async () => {
    // Safari 14 can leave the first databases() call pending forever.
    const name = uniqueDbName();
    const opened = await withDatabases(
      () => new Promise(() => {}),
      () => reopen(name, "0.17.4")
    );
    expect(opened).toBeDefined();
  });

  it("is not confused with a store Dexie patched at this client's own version", async () => {
    const name = uniqueDbName();
    const patched = trackDb(new Dexie(name));
    patched.version(8).stores({ ...V6_STORES, accountWitnesses: null });
    await patched.open();
    patched.close();

    // The missing table makes Dexie patch the store to native version 81.
    expect(await reopen(name, "0.17.4")).toBeDefined();
    expect(await nativeVersion(name)).toBe(81);
  });

  it("refuses it when a newer client upgrades the store under an open connection", async () => {
    const mdb = trackMidenDb(new MidenDatabase(uniqueDbName()));
    expect(await mdb.open("0.17.4")).toBe(true);

    // The upgrade closes this connection, and Dexie reopens it on the next read.
    const newer = trackDb(new Dexie(mdb.dexie.name));
    newer.version(99).stores(V6_STORES);
    await newer.open();
    newer.close();

    await expect(mdb.accountAuths.toArray()).rejects.toThrow(
      NEWER_CLIENT_ERROR
    );
  });
});
