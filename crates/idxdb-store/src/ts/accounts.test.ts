import { describe, it, expect, afterEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  getAccountIds,
  getAllAccountHeaders,
  getAccountHeader,
  getAccountHeaderByCommitment,
  getAccountCode,
  getAccountStorage,
  getAccountStorageMaps,
  getAccountVaultAssets,
  getAccountAddresses,
  getPostUndoAccountStates,
  upsertAccountCode,
  upsertAccountStorage,
  upsertStorageMapEntries,
  upsertVaultAssets,
  applyAccountPatch,
  applyFullAccountState,
  insertAccount,
  upsertAccountRecord,
  insertAccountAddress,
  removeAccountAddress,
  upsertForeignAccountCode,
  getForeignAccountCode,
  lockAccount,
  pruneAccountHistory,
  undoAccountStates,
} from "./accounts.js";
import { ForestUpdate } from "./forest.js";
import { uniqueDbName } from "./test-utils.js";

// Track opened DB IDs for per-test cleanup.
const openDbIds: string[] = [];

afterEach(async () => {
  for (const dbId of openDbIds) {
    const db = getDatabase(dbId);
    db.dexie.close();
    await db.dexie.delete();
  }
  openDbIds.length = 0;
});

async function openTestDb(version = "0.1.0"): Promise<string> {
  const name = uniqueDbName();
  await openDatabase(name, version);
  openDbIds.push(name);
  return name;
}

// ============================================================
// Test data helpers
// ============================================================
const ACC = "0xacc1";
const CODE_ROOT = "0xcode1";
const STORAGE_ROOT = "0xsroot1";
const VAULT_ROOT = "0xvroot1";
const COMMITMENT = "0xcommit1";
const NONCE = "1";

function makeForestUpdate(overrides: Partial<ForestUpdate> = {}): ForestUpdate {
  return {
    expectedTrees: [],
    entryUpserts: [],
    entryDeletes: [],
    subtreeUpserts: [],
    subtreeDeletes: [],
    treeUpserts: [],
    ...overrides,
  };
}

async function seedAccount(
  dbId: string,
  opts: {
    accountId?: string;
    codeRoot?: string;
    storageRoot?: string;
    vaultRoot?: string;
    nonce?: string;
    committed?: boolean;
    commitment?: string;
    seed?: Uint8Array;
  } = {}
) {
  const id = opts.accountId ?? ACC;
  await upsertAccountRecord(
    dbId,
    id,
    opts.codeRoot ?? CODE_ROOT,
    opts.storageRoot ?? STORAGE_ROOT,
    opts.vaultRoot ?? VAULT_ROOT,
    opts.nonce ?? NONCE,
    opts.committed ?? false,
    opts.commitment ?? COMMITMENT,
    opts.seed
  );
  return id;
}

// ============================================================
// getAccountIds
// ============================================================
describe("getAccountIds", () => {
  it("returns empty array when no accounts exist", async () => {
    const dbId = await openTestDb();
    const ids = await getAccountIds(dbId);
    expect(ids).toEqual([]);
  });

  it("returns all account ids", async () => {
    const dbId = await openTestDb();
    await seedAccount(dbId, { accountId: "0xacc1" });
    await seedAccount(dbId, { accountId: "0xacc2", commitment: "0xcommit2" });
    const ids = await getAccountIds(dbId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("0xacc1");
    expect(ids).toContain("0xacc2");
  });
});

// ============================================================
// getAllAccountHeaders
// ============================================================
describe("getAllAccountHeaders", () => {
  it("returns empty array when no accounts", async () => {
    const dbId = await openTestDb();
    const headers = await getAllAccountHeaders(dbId);
    expect(headers).toEqual([]);
  });

  it("returns mapped headers including optional fields", async () => {
    const dbId = await openTestDb();
    await seedAccount(dbId, {
      seed: new Uint8Array([1, 2, 3]),
      committed: true,
    });
    const headers = await getAllAccountHeaders(dbId);
    expect(headers).toHaveLength(1);
    const h = headers![0];
    expect(h.id).toBe(ACC);
    expect(h.codeRoot).toBe(CODE_ROOT);
    expect(h.storageRoot).toBe(STORAGE_ROOT);
    expect(h.vaultRoot).toBe(VAULT_ROOT);
    expect(h.nonce).toBe(NONCE);
    expect(h.committed).toBe(true);
    // seed was provided — should be base64 encoded
    expect(typeof h.accountSeed).toBe("string");
    expect(h.locked).toBe(false);
  });

  it("handles undefined accountSeed gracefully", async () => {
    const dbId = await openTestDb();
    await seedAccount(dbId); // no seed
    const headers = await getAllAccountHeaders(dbId);
    expect(headers![0].accountSeed).toBeUndefined();
  });
});

// ============================================================
// getAccountHeader
// ============================================================
describe("getAccountHeader", () => {
  it("returns null when account does not exist", async () => {
    const dbId = await openTestDb();
    const result = await getAccountHeader(dbId, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns the correct account header", async () => {
    const dbId = await openTestDb();
    await seedAccount(dbId);
    const result = await getAccountHeader(dbId, ACC);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(ACC);
    expect(result!.codeRoot).toBe(CODE_ROOT);
    expect(result!.storageRoot).toBe(STORAGE_ROOT);
    expect(result!.vaultRoot).toBe(VAULT_ROOT);
    expect(result!.nonce).toBe(NONCE);
    expect(result!.locked).toBe(false);
  });
});

// ============================================================
// getAccountHeaderByCommitment
// ============================================================
describe("getAccountHeaderByCommitment", () => {
  it("returns undefined when no matching commitment", async () => {
    const dbId = await openTestDb();
    const result = await getAccountHeaderByCommitment(dbId, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("returns historical header by commitment", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    // Seed a historical record directly
    await db.historicalAccountHeaders.put({
      id: ACC,
      replacedAtNonce: "1",
      codeRoot: CODE_ROOT,
      storageRoot: STORAGE_ROOT,
      vaultRoot: VAULT_ROOT,
      nonce: "0",
      committed: false,
      accountSeed: undefined,
      accountCommitment: "0xoldcommit",
      locked: false,
    });
    const result = await getAccountHeaderByCommitment(dbId, "0xoldcommit");
    expect(result).toBeDefined();
    expect(result!.id).toBe(ACC);
    expect(result!.nonce).toBe("0");
  });
});

// ============================================================
// getAccountCode
// ============================================================
describe("getAccountCode", () => {
  it("returns null when no code found", async () => {
    const dbId = await openTestDb();
    const result = await getAccountCode(dbId, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns base64-encoded code", async () => {
    const dbId = await openTestDb();
    const code = new Uint8Array([10, 20, 30]);
    await upsertAccountCode(dbId, CODE_ROOT, code);
    const result = await getAccountCode(dbId, CODE_ROOT);
    expect(result).not.toBeNull();
    expect(result!.root).toBe(CODE_ROOT);
    // Verify it's base64-encoded
    expect(typeof result!.code).toBe("string");
    const decoded = Uint8Array.from(atob(result!.code), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(code);
  });
});

// ============================================================
// upsertAccountCode
// ============================================================
describe("upsertAccountCode", () => {
  it("inserts code and overwrites on re-insert", async () => {
    const dbId = await openTestDb();
    await upsertAccountCode(dbId, CODE_ROOT, new Uint8Array([1, 2, 3]));
    await upsertAccountCode(dbId, CODE_ROOT, new Uint8Array([4, 5, 6]));
    const db = getDatabase(dbId);
    const record = await db.accountCodes.get(CODE_ROOT);
    expect(record!.code).toEqual(new Uint8Array([4, 5, 6]));
  });
});

// ============================================================
// getAccountStorage / upsertAccountStorage
// ============================================================
describe("getAccountStorage", () => {
  it("returns empty array when no storage", async () => {
    const dbId = await openTestDb();
    const result = await getAccountStorage(dbId, ACC, []);
    expect(result).toEqual([]);
  });

  it("returns all storage slots when no filter", async () => {
    const dbId = await openTestDb();
    await upsertAccountStorage(dbId, ACC, [
      { slotName: "slot1", slotValue: "0xval1", slotType: 0 },
      { slotName: "slot2", slotValue: "0xval2", slotType: 1 },
    ]);
    const result = await getAccountStorage(dbId, ACC, []);
    expect(result).toHaveLength(2);
  });

  it("filters by slotNames when provided", async () => {
    const dbId = await openTestDb();
    await upsertAccountStorage(dbId, ACC, [
      { slotName: "slot1", slotValue: "0xval1", slotType: 0 },
      { slotName: "slot2", slotValue: "0xval2", slotType: 1 },
      { slotName: "slot3", slotValue: "0xval3", slotType: 0 },
    ]);
    const result = await getAccountStorage(dbId, ACC, ["slot1", "slot3"]);
    expect(result).toHaveLength(2);
    const names = result!.map((r) => r.slotName);
    expect(names).toContain("slot1");
    expect(names).toContain("slot3");
  });

  it("replaces existing slots on re-upsert", async () => {
    const dbId = await openTestDb();
    await upsertAccountStorage(dbId, ACC, [
      { slotName: "slot1", slotValue: "0xold", slotType: 0 },
    ]);
    await upsertAccountStorage(dbId, ACC, [
      { slotName: "slot1", slotValue: "0xnew", slotType: 0 },
    ]);
    const result = await getAccountStorage(dbId, ACC, []);
    expect(result![0].slotValue).toBe("0xnew");
  });

  it("handles empty newSlots (clears storage)", async () => {
    const dbId = await openTestDb();
    await upsertAccountStorage(dbId, ACC, [
      { slotName: "slot1", slotValue: "0xval", slotType: 0 },
    ]);
    await upsertAccountStorage(dbId, ACC, []);
    const result = await getAccountStorage(dbId, ACC, []);
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// getAccountStorageMaps / upsertStorageMapEntries
// ============================================================
describe("getAccountStorageMaps", () => {
  it("returns empty when no map entries", async () => {
    const dbId = await openTestDb();
    const result = await getAccountStorageMaps(dbId, ACC);
    expect(result).toEqual([]);
  });

  it("returns all map entries for account", async () => {
    const dbId = await openTestDb();
    await upsertStorageMapEntries(dbId, ACC, [
      { slotName: "map1", key: "k1", value: "v1" },
      { slotName: "map1", key: "k2", value: "v2" },
    ]);
    const result = await getAccountStorageMaps(dbId, ACC);
    expect(result).toHaveLength(2);
  });

  it("replaces entries on re-upsert", async () => {
    const dbId = await openTestDb();
    await upsertStorageMapEntries(dbId, ACC, [
      { slotName: "map1", key: "k1", value: "v1" },
    ]);
    await upsertStorageMapEntries(dbId, ACC, [
      { slotName: "map1", key: "k1", value: "v2" },
    ]);
    const result = await getAccountStorageMaps(dbId, ACC);
    expect(result![0].value).toBe("v2");
  });

  it("handles empty entries (clears maps)", async () => {
    const dbId = await openTestDb();
    await upsertStorageMapEntries(dbId, ACC, [
      { slotName: "map1", key: "k1", value: "v1" },
    ]);
    await upsertStorageMapEntries(dbId, ACC, []);
    const result = await getAccountStorageMaps(dbId, ACC);
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// getAccountVaultAssets / upsertVaultAssets
// ============================================================
describe("getAccountVaultAssets", () => {
  it("returns empty when no assets", async () => {
    const dbId = await openTestDb();
    const result = await getAccountVaultAssets(dbId, ACC, []);
    expect(result).toEqual([]);
  });

  it("returns all assets when no filter", async () => {
    const dbId = await openTestDb();
    await upsertVaultAssets(dbId, ACC, [
      { vaultKey: "vk1", asset: "0xasset1" },
      { vaultKey: "vk2", asset: "0xasset2" },
    ]);
    const result = await getAccountVaultAssets(dbId, ACC, []);
    expect(result).toHaveLength(2);
  });

  it("filters by vaultKeys when provided", async () => {
    const dbId = await openTestDb();
    await upsertVaultAssets(dbId, ACC, [
      { vaultKey: "vk1", asset: "0xasset1" },
      { vaultKey: "vk2", asset: "0xasset2" },
      { vaultKey: "vk3", asset: "0xasset3" },
    ]);
    const result = await getAccountVaultAssets(dbId, ACC, ["vk1", "vk3"]);
    expect(result).toHaveLength(2);
    const keys = result!.map((r) => r.vaultKey);
    expect(keys).toContain("vk1");
    expect(keys).toContain("vk3");
  });

  it("handles empty assets (clears vault)", async () => {
    const dbId = await openTestDb();
    await upsertVaultAssets(dbId, ACC, [
      { vaultKey: "vk1", asset: "0xasset1" },
    ]);
    await upsertVaultAssets(dbId, ACC, []);
    const result = await getAccountVaultAssets(dbId, ACC, []);
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// getAccountAddresses / insertAccountAddress / removeAccountAddress
// ============================================================
describe("addresses", () => {
  it("returns empty array when no addresses", async () => {
    const dbId = await openTestDb();
    const result = await getAccountAddresses(dbId, ACC);
    expect(result).toEqual([]);
  });

  it("inserts and retrieves an address", async () => {
    const dbId = await openTestDb();
    const addr = new Uint8Array([0xaa, 0xbb, 0xcc]);
    await insertAccountAddress(dbId, ACC, addr);
    const result = await getAccountAddresses(dbId, ACC);
    expect(result).toHaveLength(1);
  });

  it("removes an address", async () => {
    const dbId = await openTestDb();
    const addr = new Uint8Array([0xaa, 0xbb]);
    await insertAccountAddress(dbId, ACC, addr);
    await removeAccountAddress(dbId, addr);
    const result = await getAccountAddresses(dbId, ACC);
    expect(result).toEqual([]);
  });
});

// ============================================================
// upsertAccountRecord
// ============================================================
describe("upsertAccountRecord", () => {
  it("inserts account and can be retrieved via getAccountHeader", async () => {
    const dbId = await openTestDb();
    await upsertAccountRecord(
      dbId,
      ACC,
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      NONCE,
      false,
      COMMITMENT,
      undefined
    );
    const header = await getAccountHeader(dbId, ACC);
    expect(header).not.toBeNull();
    expect(header!.id).toBe(ACC);
  });

  it("overwrites existing account on re-upsert", async () => {
    const dbId = await openTestDb();
    await seedAccount(dbId);
    await upsertAccountRecord(
      dbId,
      ACC,
      CODE_ROOT,
      "0xnewsroot",
      VAULT_ROOT,
      "2",
      true,
      "0xnewcommit",
      undefined
    );
    const header = await getAccountHeader(dbId, ACC);
    expect(header!.nonce).toBe("2");
    expect(header!.storageRoot).toBe("0xnewsroot");
  });
});

// ============================================================
// applyAccountPatch
// ============================================================
describe("applyAccountPatch", () => {
  const CLIENT_VERSION = "0.0.1";

  it("creates initial account state when no prior state exists", async () => {
    const dbId = await openTestDb(CLIENT_VERSION);
    const db = getDatabase(dbId);

    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [{ slotName: "slot1", slotValue: "0xval1", slotType: 0 }],
      [{ slotName: "map1", key: "k1", value: "v1" }],
      [{ vaultKey: "vk1", asset: "0xasset1" }],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      COMMITMENT
    );

    const header = await db.latestAccountHeaders
      .where("id")
      .equals(ACC)
      .first();
    expect(header?.nonce).toBe("1");
    expect(header?.storageRoot).toBe(STORAGE_ROOT);

    const slots = await db.latestAccountStorages
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(slots).toHaveLength(1);
    expect(slots[0].slotValue).toBe("0xval1");

    const maps = await db.latestStorageMapEntries
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(maps).toHaveLength(1);
    expect(maps[0].value).toBe("v1");

    const assets = await db.latestAccountAssets
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(assets).toHaveLength(1);
    expect(assets[0].asset).toBe("0xasset1");
  });

  it("archives old state and updates to new state", async () => {
    const dbId = await openTestDb(CLIENT_VERSION);
    const db = getDatabase(dbId);

    // First delta: initial state
    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [{ slotName: "slot1", slotValue: "0xval1", slotType: 0 }],
      [{ slotName: "map1", key: "k1", value: "v1" }],
      [{ vaultKey: "vk1", asset: "0xasset1" }],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      COMMITMENT
    );

    // Second delta: update
    await applyAccountPatch(
      dbId,
      ACC,
      "2",
      [{ slotName: "slot1", slotValue: "0xval2", slotType: 0 }],
      [{ slotName: "map1", key: "k1", value: "" }], // empty string = removal
      [{ vaultKey: "vk1", asset: "" }], // empty string = removal
      CODE_ROOT,
      "0xsroot2",
      "0xvroot2",
      false,
      "0xcommit2"
    );

    // Latest should reflect nonce 2
    const header = await db.latestAccountHeaders
      .where("id")
      .equals(ACC)
      .first();
    expect(header?.nonce).toBe("2");

    // Storage updated
    const slots = await db.latestAccountStorages
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(slots[0].slotValue).toBe("0xval2");

    // Map entry removed (empty string = deletion)
    const maps = await db.latestStorageMapEntries
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(maps).toHaveLength(0);

    // Asset removed
    const assets = await db.latestAccountAssets
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(assets).toHaveLength(0);

    // Historical should have the old state
    const histHeaders = await db.historicalAccountHeaders
      .where("id")
      .equals(ACC)
      .toArray();
    expect(histHeaders.length).toBeGreaterThan(0);
  });

  it("replaces and removes map slots while preserving rollback history", async () => {
    const dbId = await openTestDb(CLIENT_VERSION);
    const db = getDatabase(dbId);

    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [
        {
          slotName: "map1",
          slotValue: "0xroot1",
          slotType: 1,
          patchOperation: 0,
        },
      ],
      [
        { slotName: "map1", key: "k1", value: "old1" },
        { slotName: "map1", key: "k2", value: "old2" },
      ],
      [],
      CODE_ROOT,
      "0xroot1",
      VAULT_ROOT,
      false,
      "0xcommit1"
    );

    // Create replaces the whole map, including entries omitted by the patch.
    await applyAccountPatch(
      dbId,
      ACC,
      "2",
      [
        {
          slotName: "map1",
          slotValue: "0xroot2",
          slotType: 1,
          patchOperation: 0,
        },
      ],
      [
        { slotName: "map1", key: "k1", value: "new1" },
        { slotName: "map1", key: "k3", value: "new3" },
      ],
      [],
      CODE_ROOT,
      "0xroot2",
      VAULT_ROOT,
      false,
      "0xcommit2"
    );

    let entries = await db.latestStorageMapEntries
      .where("[accountId+slotName]")
      .equals([ACC, "map1"])
      .sortBy("key");
    expect(entries.map(({ key, value }) => [key, value])).toEqual([
      ["k1", "new1"],
      ["k3", "new3"],
    ]);

    // Remove drops both the slot metadata and all of its entries.
    await applyAccountPatch(
      dbId,
      ACC,
      "3",
      [
        {
          slotName: "map1",
          slotValue: "",
          slotType: 1,
          patchOperation: 2,
        },
      ],
      [],
      [],
      CODE_ROOT,
      "0xemptyroot",
      VAULT_ROOT,
      false,
      "0xcommit3"
    );

    expect(
      await db.latestAccountStorages
        .where("[accountId+slotName]")
        .equals([ACC, "map1"])
        .count()
    ).toBe(0);
    expect(
      await db.latestStorageMapEntries
        .where("[accountId+slotName]")
        .equals([ACC, "map1"])
        .count()
    ).toBe(0);

    await undoAccountStates(dbId, ["0xcommit3"]);
    entries = await db.latestStorageMapEntries
      .where("[accountId+slotName]")
      .equals([ACC, "map1"])
      .sortBy("key");
    expect(entries.map(({ key, value }) => [key, value])).toEqual([
      ["k1", "new1"],
      ["k3", "new3"],
    ]);

    await undoAccountStates(
      dbId,
      ["0xcommit2"],
      makeForestUpdate({
        expectedTrees: [{ lineage: "undo-lineage" }],
        allocatedRevision: "0000000000000001",
        treeUpserts: [
          {
            lineage: "undo-lineage",
            version: "0000000000000001",
            root: "0xundo-root",
            entryCount: 0,
          },
        ],
      })
    );
    entries = await db.latestStorageMapEntries
      .where("[accountId+slotName]")
      .equals([ACC, "map1"])
      .sortBy("key");
    expect(entries.map(({ key, value }) => [key, value])).toEqual([
      ["k1", "old1"],
      ["k2", "old2"],
    ]);
    await expect(db.forestTrees.get("undo-lineage")).resolves.toBeDefined();
  });

  it("commits the account patch and forest update atomically", async () => {
    const dbId = await openTestDb(CLIENT_VERSION);
    const db = getDatabase(dbId);
    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [],
      [],
      [],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      COMMITMENT,
      makeForestUpdate({
        expectedTrees: [{ lineage: "lineage" }],
        allocatedRevision: "0000000000000001",
        treeUpserts: [
          {
            lineage: "lineage",
            version: "0000000000000001",
            root: "0xroot",
            entryCount: 0,
          },
        ],
      })
    );

    await expect(db.latestAccountHeaders.get(ACC)).resolves.toBeDefined();
    await expect(db.forestTrees.get("lineage")).resolves.toBeDefined();
    await expect(db.forestRevision.get(0)).resolves.toMatchObject({
      nextVersion: "0000000000000002",
    });
  });

  it("rolls back account rows when the forest CAS fails", async () => {
    const dbId = await openTestDb(CLIENT_VERSION);
    const db = getDatabase(dbId);
    await seedAccount(dbId);

    await expect(
      applyAccountPatch(
        dbId,
        ACC,
        "2",
        [{ slotName: "slot", slotValue: "0xnew", slotType: 0 }],
        [],
        [],
        CODE_ROOT,
        "0xnew-storage",
        VAULT_ROOT,
        false,
        "0xnew-commitment",
        makeForestUpdate({ allocatedRevision: "0000000000000009" })
      )
    ).rejects.toMatchObject({ name: "ForestConflictError" });

    await expect(db.latestAccountHeaders.get(ACC)).resolves.toMatchObject({
      nonce: NONCE,
      storageRoot: STORAGE_ROOT,
    });
    await expect(db.latestAccountStorages.count()).resolves.toBe(0);
    await expect(db.historicalAccountHeaders.count()).resolves.toBe(0);
  });
});

// ============================================================
// applyFullAccountState
// ============================================================
describe("applyFullAccountState", () => {
  it("replaces full account state and archives prior", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    // Seed initial state
    await seedAccount(dbId);
    await upsertAccountStorage(dbId, ACC, [
      { slotName: "slot1", slotValue: "0xold", slotType: 0 },
    ]);
    await upsertStorageMapEntries(dbId, ACC, [
      { slotName: "map1", key: "k1", value: "vold" },
    ]);
    await upsertVaultAssets(dbId, ACC, [
      { vaultKey: "vk1", asset: "0xoldasset" },
    ]);

    // Apply full state
    await applyFullAccountState(dbId, {
      accountId: ACC,
      nonce: "2",
      storageSlots: [{ slotName: "slot1", slotValue: "0xnew", slotType: 0 }],
      storageMapEntries: [{ slotName: "map1", key: "k1", value: "vnew" }],
      assets: [{ vaultKey: "vk1", asset: "0xnewasset" }],
      codeRoot: CODE_ROOT,
      storageRoot: "0xsroot2",
      vaultRoot: "0xvroot2",
      committed: true,
      accountCommitment: "0xnewcommit",
      accountSeed: undefined,
    });

    const header = await db.latestAccountHeaders
      .where("id")
      .equals(ACC)
      .first();
    expect(header?.nonce).toBe("2");
    expect(header?.committed).toBe(true);

    const slots = await db.latestAccountStorages
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(slots[0].slotValue).toBe("0xnew");

    const maps = await db.latestStorageMapEntries
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(maps[0].value).toBe("vnew");

    const assets = await db.latestAccountAssets
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(assets[0].asset).toBe("0xnewasset");
  });

  it("applies full state when no existing header (no-history branch)", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    // No prior state for account
    await applyFullAccountState(dbId, {
      accountId: "0xbrand-new",
      nonce: "1",
      storageSlots: [],
      storageMapEntries: [],
      assets: [],
      codeRoot: "0xcodeNew",
      storageRoot: "0xsrootNew",
      vaultRoot: "0xvrootNew",
      committed: false,
      accountCommitment: "0xcommitNew",
      accountSeed: new Uint8Array([5, 6, 7]),
    });

    const header = await db.latestAccountHeaders
      .where("id")
      .equals("0xbrand-new")
      .first();
    expect(header?.nonce).toBe("1");
  });

  it("archives new slots as null-old-value when new slot has no old counterpart", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    // Start with an existing account but NO storage
    await seedAccount(dbId);

    await applyFullAccountState(dbId, {
      accountId: ACC,
      nonce: "2",
      storageSlots: [
        { slotName: "brand-new-slot", slotValue: "0xv", slotType: 0 },
      ],
      storageMapEntries: [{ slotName: "brand-new-map", key: "k", value: "v" }],
      assets: [{ vaultKey: "brand-new-key", asset: "0xa" }],
      codeRoot: CODE_ROOT,
      storageRoot: STORAGE_ROOT,
      vaultRoot: VAULT_ROOT,
      committed: false,
      accountCommitment: "0xcommit2",
      accountSeed: undefined,
    });

    // Historical should have null old values for all brand-new entries
    const histSlots = await db.historicalAccountStorages
      .where("[accountId+replacedAtNonce]")
      .equals([ACC, "2"])
      .toArray();
    expect(histSlots.length).toBeGreaterThan(0);
    expect(histSlots[0].oldSlotValue).toBeNull();

    const histMaps = await db.historicalStorageMapEntries
      .where("[accountId+replacedAtNonce]")
      .equals([ACC, "2"])
      .toArray();
    expect(histMaps.length).toBeGreaterThan(0);
    expect(histMaps[0].oldValue).toBeNull();

    const histAssets = await db.historicalAccountAssets
      .where("[accountId+replacedAtNonce]")
      .equals([ACC, "2"])
      .toArray();
    expect(histAssets.length).toBeGreaterThan(0);
    expect(histAssets[0].oldAsset).toBeNull();
  });

  it("rolls back a full replacement when the forest CAS fails", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await seedAccount(dbId);

    await expect(
      applyFullAccountState(
        dbId,
        {
          accountId: ACC,
          nonce: "2",
          storageSlots: [{ slotName: "slot", slotValue: "0xnew", slotType: 0 }],
          storageMapEntries: [],
          assets: [],
          codeRoot: "0xnew-code",
          storageRoot: "0xnew-storage",
          vaultRoot: "0xnew-vault",
          committed: true,
          accountCommitment: "0xnew-commitment",
          accountSeed: undefined,
        },
        makeForestUpdate({ allocatedRevision: "0000000000000009" })
      )
    ).rejects.toMatchObject({ name: "ForestConflictError" });

    await expect(db.latestAccountHeaders.get(ACC)).resolves.toMatchObject({
      nonce: NONCE,
      codeRoot: CODE_ROOT,
    });
    await expect(db.latestAccountStorages.count()).resolves.toBe(0);
    await expect(db.historicalAccountHeaders.count()).resolves.toBe(0);
  });
});

describe("insertAccount", () => {
  it("writes the complete account and forest state in one transaction", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    const address = new Uint8Array([1, 2, 3]);
    await insertAccount(
      dbId,
      {
        accountId: ACC,
        nonce: "1",
        storageSlots: [{ slotName: "slot", slotValue: "0xvalue", slotType: 0 }],
        storageMapEntries: [
          { slotName: "map", key: "0xkey", value: "0xvalue" },
        ],
        assets: [{ vaultKey: "vault-key", asset: "0xasset" }],
        codeRoot: CODE_ROOT,
        storageRoot: STORAGE_ROOT,
        vaultRoot: VAULT_ROOT,
        committed: false,
        accountCommitment: COMMITMENT,
        accountSeed: new Uint8Array([9, 8]),
      },
      new Uint8Array([4, 5, 6]),
      CODE_ROOT,
      address,
      true,
      makeForestUpdate({
        expectedTrees: [{ lineage: "lineage" }],
        allocatedRevision: "0000000000000001",
        entryUpserts: [
          {
            lineage: "lineage",
            key: "0xkey",
            value: "0xvalue",
            leafPosition: "0000000000000001",
          },
        ],
        treeUpserts: [
          {
            lineage: "lineage",
            version: "0000000000000001",
            root: "0xroot",
            entryCount: 1,
          },
        ],
      })
    );

    await expect(db.accountCodes.get(CODE_ROOT)).resolves.toEqual({
      root: CODE_ROOT,
      code: new Uint8Array([4, 5, 6]),
    });
    await expect(db.latestAccountHeaders.get(ACC)).resolves.toMatchObject({
      id: ACC,
      watched: true,
      locked: false,
      accountCommitment: COMMITMENT,
    });
    await expect(
      db.latestAccountStorages.where("accountId").equals(ACC).count()
    ).resolves.toBe(1);
    await expect(
      db.latestStorageMapEntries.where("accountId").equals(ACC).count()
    ).resolves.toBe(1);
    await expect(
      db.latestAccountAssets.where("accountId").equals(ACC).count()
    ).resolves.toBe(1);
    await expect(db.addresses.where("id").equals(ACC).first()).resolves.toEqual(
      {
        id: ACC,
        address,
      }
    );
    await expect(
      db.forestEntries.get(["lineage", "0xkey"])
    ).resolves.toBeDefined();
    await expect(db.forestRevision.get(0)).resolves.toMatchObject({
      nextVersion: "0000000000000002",
    });

    await expect(
      insertAccount(
        dbId,
        {
          accountId: ACC,
          nonce: "2",
          storageSlots: [],
          storageMapEntries: [],
          assets: [],
          codeRoot: "other-code",
          storageRoot: "other-storage",
          vaultRoot: "other-vault",
          committed: true,
          accountCommitment: "other-commitment",
          accountSeed: undefined,
        },
        new Uint8Array([7]),
        "other-code",
        new Uint8Array([7]),
        false,
        makeForestUpdate()
      )
    ).rejects.toMatchObject({ name: "ForestConflictError" });

    await expect(db.accountCodes.get("other-code")).resolves.toBeUndefined();
    await expect(db.latestAccountHeaders.get(ACC)).resolves.toMatchObject({
      nonce: "1",
      watched: true,
    });
    await expect(db.addresses.where("id").equals(ACC).count()).resolves.toBe(1);
  });

  it("supports accounts with empty child collections", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await insertAccount(
      dbId,
      {
        accountId: "empty-account",
        nonce: "0",
        storageSlots: [],
        storageMapEntries: [],
        assets: [],
        codeRoot: "empty-code",
        storageRoot: "empty-storage",
        vaultRoot: "empty-vault",
        committed: false,
        accountCommitment: "empty-commitment",
        accountSeed: undefined,
      },
      new Uint8Array(),
      "empty-code",
      new Uint8Array([0]),
      false,
      undefined
    );

    await expect(
      db.latestAccountHeaders.get("empty-account")
    ).resolves.toMatchObject({
      watched: false,
    });
    await expect(db.latestAccountStorages.count()).resolves.toBe(0);
    await expect(db.latestStorageMapEntries.count()).resolves.toBe(0);
    await expect(db.latestAccountAssets.count()).resolves.toBe(0);
  });
});

// ============================================================
// upsertForeignAccountCode / getForeignAccountCode
// ============================================================
describe("getForeignAccountCode", () => {
  it("returns null when no records found", async () => {
    const dbId = await openTestDb();
    const result = await getForeignAccountCode(dbId, ["0xacc-foreign"]);
    expect(result).toBeNull();
  });

  it("returns code for foreign accounts", async () => {
    const dbId = await openTestDb();
    const code = new Uint8Array([11, 22, 33]);
    await upsertForeignAccountCode(dbId, "0xforeign1", code, "0xfcoderoot");
    const result = await getForeignAccountCode(dbId, ["0xforeign1"]);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].accountId).toBe("0xforeign1");
    expect(typeof result![0].code).toBe("string"); // base64
  });

  it("handles missing code record gracefully (undefined filtered out)", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    // Insert foreign account reference without actual code record
    await db.foreignAccountCode.put({
      accountId: "0xbroken",
      codeRoot: "0xmissingcode",
    });
    const result = await getForeignAccountCode(dbId, ["0xbroken"]);
    // Should return empty array (undefined entries filtered)
    expect(result).toBeDefined();
    expect((result as unknown[]).length).toBe(0);
  });
});

// ============================================================
// lockAccount
// ============================================================
describe("lockAccount", () => {
  it("locks the latest account header", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);
    await seedAccount(dbId);

    const before = await db.latestAccountHeaders
      .where("id")
      .equals(ACC)
      .first();
    expect(before?.locked).toBe(false);

    await lockAccount(dbId, ACC);

    const after = await db.latestAccountHeaders.where("id").equals(ACC).first();
    expect(after?.locked).toBe(true);
  });

  it("locks historical account headers for the same account", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    await seedAccount(dbId);
    // Create a historical record
    await db.historicalAccountHeaders.put({
      id: ACC,
      replacedAtNonce: "1",
      codeRoot: CODE_ROOT,
      storageRoot: STORAGE_ROOT,
      vaultRoot: VAULT_ROOT,
      nonce: "0",
      committed: false,
      accountSeed: undefined,
      accountCommitment: "0xoldcommit",
      locked: false,
    });

    await lockAccount(dbId, ACC);

    const histHeaders = await db.historicalAccountHeaders
      .where("id")
      .equals(ACC)
      .toArray();
    expect(histHeaders.every((h) => h.locked === true)).toBe(true);
  });
});

// ============================================================
// pruneAccountHistory
// ============================================================
describe("pruneAccountHistory", () => {
  it("returns 0 when there is no history to prune", async () => {
    const dbId = await openTestDb();
    await seedAccount(dbId);
    const deleted = await pruneAccountHistory(dbId, ACC, "10");
    expect(deleted).toBe(0);
  });

  it("prunes historical records at or below the given nonce", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    // Build up history via applyAccountPatch (nonce 1 → 2 → 3)
    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [{ slotName: "s1", slotValue: "v1", slotType: 0 }],
      [],
      [],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      "0xc1"
    );
    await applyAccountPatch(
      dbId,
      ACC,
      "2",
      [{ slotName: "s1", slotValue: "v2", slotType: 0 }],
      [],
      [],
      CODE_ROOT,
      "0xsr2",
      VAULT_ROOT,
      false,
      "0xc2"
    );
    await applyAccountPatch(
      dbId,
      ACC,
      "3",
      [{ slotName: "s1", slotValue: "v3", slotType: 0 }],
      [],
      [],
      CODE_ROOT,
      "0xsr3",
      VAULT_ROOT,
      false,
      "0xc3"
    );

    // Prune up to and including nonce 2
    const deleted = await pruneAccountHistory(dbId, ACC, "2");
    expect(deleted).toBeGreaterThan(0);

    // Historical headers at nonce <= 2 should be gone
    const remaining = await db.historicalAccountHeaders
      .where("id")
      .equals(ACC)
      .toArray();
    const remainingNonces = remaining.map((h) => Number(h.replacedAtNonce));
    expect(remainingNonces.every((n) => n > 2)).toBe(true);
  });

  it("also prunes orphaned account code", async () => {
    const dbId = await openTestDb();
    const db = getDatabase(dbId);

    const OLD_CODE = "0xoldcode";
    const NEW_CODE = "0xnewcode";
    await upsertAccountCode(dbId, OLD_CODE, new Uint8Array([1]));
    await upsertAccountCode(dbId, NEW_CODE, new Uint8Array([2]));

    // Manually build a historical header with replacedAtNonce = "1" and OLD_CODE.
    // This simulates a state archived when nonce "1" replaced the prior nonce.
    // The latest header uses NEW_CODE so OLD_CODE has no remaining references.
    await db.historicalAccountHeaders.put({
      id: ACC,
      replacedAtNonce: "1",
      codeRoot: OLD_CODE,
      storageRoot: STORAGE_ROOT,
      vaultRoot: VAULT_ROOT,
      nonce: "0",
      committed: false,
      accountSeed: undefined,
      accountCommitment: "0xc0",
      locked: false,
    });

    // Latest account uses NEW_CODE
    await upsertAccountRecord(
      dbId,
      ACC,
      NEW_CODE,
      STORAGE_ROOT,
      VAULT_ROOT,
      "2",
      false,
      "0xc2",
      undefined
    );

    // Prune up to nonce "1" — removes the historical header (replacedAtNonce=1),
    // leaving OLD_CODE unreferenced → should delete it from accountCodes.
    await pruneAccountHistory(dbId, ACC, "1");

    const oldCodeRecord = await db.accountCodes.get(OLD_CODE);
    expect(oldCodeRecord).toBeUndefined();

    // NEW_CODE should still be there (referenced by latest header)
    const newCodeRecord = await db.accountCodes.get(NEW_CODE);
    expect(newCodeRecord).toBeDefined();
  });
});

// ============================================================
// undoAccountStates
// ============================================================
describe("undoAccountStates", () => {
  const CV = "0.0.1";

  it("undo restores previous account state", async () => {
    const dbId = await openTestDb(CV);
    const db = getDatabase(dbId);

    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [{ slotName: "slot1", slotValue: "0xval1", slotType: 0 }],
      [{ slotName: "map1", key: "k1", value: "v1" }],
      [{ vaultKey: "vk1", asset: "0xasset1" }],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      COMMITMENT
    );

    await applyAccountPatch(
      dbId,
      ACC,
      "2",
      [{ slotName: "slot1", slotValue: "0xval2", slotType: 0 }],
      [{ slotName: "map1", key: "k1", value: "v2" }],
      [{ vaultKey: "vk1", asset: "0xasset2" }],
      CODE_ROOT,
      "0xsroot2",
      "0xvroot2",
      false,
      "0xcommit2"
    );

    await undoAccountStates(dbId, ["0xcommit2"]);

    const header = await db.latestAccountHeaders
      .where("id")
      .equals(ACC)
      .first();
    expect(header?.nonce).toBe("1");
    expect(header?.storageRoot).toBe(STORAGE_ROOT);

    const slots = await db.latestAccountStorages
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(slots[0].slotValue).toBe("0xval1");

    const maps = await db.latestStorageMapEntries
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(maps[0].value).toBe("v1");

    const assets = await db.latestAccountAssets
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(assets[0].asset).toBe("0xasset1");
  });

  it("deletes the account entirely when no previous header exists", async () => {
    const dbId = await openTestDb(CV);
    const db = getDatabase(dbId);

    // Insert account directly (no prior history)
    await upsertAccountRecord(
      dbId,
      "0xnewaccount",
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      "1",
      false,
      "0xcommitNew",
      undefined
    );
    await upsertAccountStorage(dbId, "0xnewaccount", [
      { slotName: "slot1", slotValue: "0xval1", slotType: 0 },
    ]);

    // Undo the commitment that corresponds to this account's current state
    await undoAccountStates(dbId, ["0xcommitNew"]);

    // Account should be deleted from latest (commitment found in latest header)
    const header = await db.latestAccountHeaders
      .where("id")
      .equals("0xnewaccount")
      .first();
    expect(header).toBeUndefined();
  });

  it("resolves commitment from historical headers when not in latest", async () => {
    const dbId = await openTestDb(CV);
    const db = getDatabase(dbId);

    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [],
      [],
      [],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      "0xc1"
    );
    await applyAccountPatch(
      dbId,
      ACC,
      "2",
      [],
      [],
      [],
      CODE_ROOT,
      "0xsr2",
      VAULT_ROOT,
      false,
      "0xc2"
    );

    // "0xc1" is now in historical (archived when nonce 2 applied)
    // undoAccountStates("0xc1") should find it in historical and restore
    await undoAccountStates(dbId, ["0xc1"]);

    // Latest header should now be at nonce "0" (before nonce "1" was applied)
    // — no prior historical means account deleted
    const header = await db.latestAccountHeaders
      .where("id")
      .equals(ACC)
      .first();
    expect(header).toBeUndefined();
  });

  it("no-ops when commitment does not exist anywhere", async () => {
    const dbId = await openTestDb(CV);
    const db = getDatabase(dbId);
    await seedAccount(dbId);

    // Should not throw
    await expect(
      undoAccountStates(dbId, ["0xnonexistent"])
    ).resolves.not.toThrow();

    // Account should still be there
    const header = await db.latestAccountHeaders
      .where("id")
      .equals(ACC)
      .first();
    expect(header).toBeDefined();
  });

  it("restores null old values by deleting from latest (slot null branch)", async () => {
    const dbId = await openTestDb(CV);
    const db = getDatabase(dbId);

    // Apply nonce "1" adding a brand-new slot/map/asset (no prior state)
    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [{ slotName: "newslot", slotValue: "0xv", slotType: 0 }],
      [{ slotName: "newmap", key: "k", value: "v" }],
      [{ vaultKey: "newkey", asset: "0xa" }],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      COMMITMENT
    );

    // Historical entries for nonce "1" have null old values (brand-new)
    const histSlots = await db.historicalAccountStorages
      .where("[accountId+replacedAtNonce]")
      .equals([ACC, "1"])
      .toArray();
    expect(histSlots[0].oldSlotValue).toBeNull();

    // Undo nonce "1" — null old values should cause deletion from latest
    await undoAccountStates(dbId, [COMMITMENT]);

    const slots = await db.latestAccountStorages
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(slots).toHaveLength(0);

    const maps = await db.latestStorageMapEntries
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(maps).toHaveLength(0);

    const assets = await db.latestAccountAssets
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(assets).toHaveLength(0);
  });

  it("rolls back undo when the forest CAS fails", async () => {
    const dbId = await openTestDb(CV);
    const db = getDatabase(dbId);
    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [{ slotName: "slot", slotValue: "0xold", slotType: 0 }],
      [],
      [],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      "0xcommit1"
    );
    await applyAccountPatch(
      dbId,
      ACC,
      "2",
      [{ slotName: "slot", slotValue: "0xnew", slotType: 0 }],
      [],
      [],
      CODE_ROOT,
      "0xstorage2",
      VAULT_ROOT,
      false,
      "0xcommit2"
    );

    await expect(
      undoAccountStates(
        dbId,
        ["0xcommit2"],
        makeForestUpdate({ allocatedRevision: "0000000000000009" })
      )
    ).rejects.toMatchObject({ name: "ForestConflictError" });

    await expect(db.latestAccountHeaders.get(ACC)).resolves.toMatchObject({
      nonce: "2",
    });
    await expect(
      db.latestAccountStorages.get([ACC, "slot"])
    ).resolves.toMatchObject({ slotValue: "0xnew" });
    await expect(
      db.historicalAccountHeaders.where("id").equals(ACC).count()
    ).resolves.toBe(1);
  });
});

describe("getPostUndoAccountStates", () => {
  it("matches the state produced by undo without modifying the database", async () => {
    const dbId = await openTestDb("0.0.1");
    const db = getDatabase(dbId);
    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [{ slotName: "slot1", slotValue: "0xold", slotType: 0 }],
      [{ slotName: "map1", key: "key1", value: "old" }],
      [{ vaultKey: "asset1", asset: "0xold" }],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      "0xcommit1"
    );
    await applyAccountPatch(
      dbId,
      ACC,
      "2",
      [
        { slotName: "slot1", slotValue: "0xnew", slotType: 0 },
        { slotName: "slot2", slotValue: "0xadded", slotType: 0 },
      ],
      [
        { slotName: "map1", key: "key1", value: "new" },
        { slotName: "map1", key: "key2", value: "added" },
      ],
      [
        { vaultKey: "asset1", asset: "0xnew" },
        { vaultKey: "asset2", asset: "0xadded" },
      ],
      CODE_ROOT,
      "0xstorage2",
      "0xvault2",
      false,
      "0xcommit2"
    );

    const planned = await getPostUndoAccountStates(dbId, ["0xcommit2"]);
    expect(planned).toEqual([
      {
        accountId: ACC,
        storageSlots: [{ slotName: "slot1", slotValue: "0xold", slotType: 0 }],
        storageMapEntries: [{ slotName: "map1", key: "key1", value: "old" }],
        vaultAssets: [{ vaultKey: "asset1", asset: "0xold" }],
      },
    ]);
    await expect(db.latestAccountHeaders.get(ACC)).resolves.toMatchObject({
      nonce: "2",
    });
    await expect(
      db.latestAccountStorages.where("accountId").equals(ACC).count()
    ).resolves.toBe(2);

    await undoAccountStates(dbId, ["0xcommit2"]);

    const actual = {
      accountId: ACC,
      storageSlots: (
        await db.latestAccountStorages
          .where("accountId")
          .equals(ACC)
          .sortBy("slotName")
      ).map(({ slotName, slotValue, slotType }) => ({
        slotName,
        slotValue,
        slotType,
      })),
      storageMapEntries: (
        await db.latestStorageMapEntries
          .where("accountId")
          .equals(ACC)
          .sortBy("key")
      ).map(({ slotName, key, value }) => ({ slotName, key, value })),
      vaultAssets: (
        await db.latestAccountAssets
          .where("accountId")
          .equals(ACC)
          .sortBy("vaultKey")
      ).map(({ vaultKey, asset }) => ({ vaultKey, asset })),
    };
    expect(actual).toEqual(planned[0]);
  });

  it("returns empty rows when undo would delete the account", async () => {
    const dbId = await openTestDb();
    await seedAccount(dbId, {
      accountId: "new-account",
      commitment: "new-commitment",
    });
    await upsertAccountStorage(dbId, "new-account", [
      { slotName: "slot", slotValue: "0xvalue", slotType: 0 },
    ]);

    await expect(
      getPostUndoAccountStates(dbId, ["new-commitment"])
    ).resolves.toEqual([
      {
        accountId: "new-account",
        storageSlots: [],
        storageMapEntries: [],
        vaultAssets: [],
      },
    ]);
    await expect(
      getPostUndoAccountStates(dbId, ["missing-commitment"])
    ).resolves.toEqual([]);
  });
});

// ============================================================
// Error-path coverage: catch blocks call logWebStoreError (re-throws)
// Passing an unregistered dbId causes getDatabase() to throw, which
// exercises the catch body in every function.
// ============================================================
const BAD_DB = "does-not-exist-db";

describe("error paths: unregistered dbId re-throws", () => {
  it("getAccountIds rejects on bad dbId", async () => {
    await expect(getAccountIds(BAD_DB)).rejects.toThrow();
  });

  it("getAllAccountHeaders rejects on bad dbId", async () => {
    await expect(getAllAccountHeaders(BAD_DB)).rejects.toThrow();
  });

  it("getAccountHeader rejects on bad dbId", async () => {
    await expect(getAccountHeader(BAD_DB, "0xacc")).rejects.toThrow();
  });

  it("getAccountHeaderByCommitment rejects on bad dbId", async () => {
    await expect(
      getAccountHeaderByCommitment(BAD_DB, "0xcommit")
    ).rejects.toThrow();
  });

  it("getAccountCode rejects on bad dbId", async () => {
    await expect(getAccountCode(BAD_DB, "0xroot")).rejects.toThrow();
  });

  it("getAccountStorage rejects on bad dbId", async () => {
    await expect(getAccountStorage(BAD_DB, "0xacc", [])).rejects.toThrow();
  });

  it("getAccountStorageMaps rejects on bad dbId", async () => {
    await expect(getAccountStorageMaps(BAD_DB, "0xacc")).rejects.toThrow();
  });

  it("getAccountVaultAssets rejects on bad dbId", async () => {
    await expect(getAccountVaultAssets(BAD_DB, "0xacc", [])).rejects.toThrow();
  });

  it("getAccountAddresses rejects on bad dbId", async () => {
    await expect(getAccountAddresses(BAD_DB, "0xacc")).rejects.toThrow();
  });

  it("getPostUndoAccountStates rejects on bad dbId", async () => {
    await expect(
      getPostUndoAccountStates(BAD_DB, ["0xcommit"])
    ).rejects.toThrow();
  });

  it("upsertAccountCode rejects on bad dbId", async () => {
    await expect(
      upsertAccountCode(BAD_DB, "0xroot", new Uint8Array([1]))
    ).rejects.toThrow();
  });

  it("upsertAccountStorage rejects on bad dbId", async () => {
    await expect(upsertAccountStorage(BAD_DB, "0xacc", [])).rejects.toThrow();
  });

  it("upsertStorageMapEntries rejects on bad dbId", async () => {
    await expect(
      upsertStorageMapEntries(BAD_DB, "0xacc", [])
    ).rejects.toThrow();
  });

  it("upsertVaultAssets rejects on bad dbId", async () => {
    await expect(upsertVaultAssets(BAD_DB, "0xacc", [])).rejects.toThrow();
  });

  it("upsertAccountRecord rejects on bad dbId", async () => {
    await expect(
      upsertAccountRecord(
        BAD_DB,
        "0xacc",
        "0xcode",
        "0xsroot",
        "0xvroot",
        "1",
        false,
        "0xcommit",
        undefined
      )
    ).rejects.toThrow();
  });

  it("insertAccountAddress rejects on bad dbId", async () => {
    await expect(
      insertAccountAddress(BAD_DB, "0xacc", new Uint8Array([1]))
    ).rejects.toThrow();
  });

  it("insertAccount rejects on bad dbId", async () => {
    await expect(
      insertAccount(
        BAD_DB,
        {
          accountId: "0xacc",
          nonce: "1",
          storageSlots: [],
          storageMapEntries: [],
          assets: [],
          codeRoot: "0xcode",
          storageRoot: "0xstorage",
          vaultRoot: "0xvault",
          committed: false,
          accountCommitment: "0xcommit",
          accountSeed: undefined,
        },
        new Uint8Array([1]),
        "0xcode",
        new Uint8Array([2]),
        false
      )
    ).rejects.toThrow();
  });

  it("removeAccountAddress rejects on bad dbId", async () => {
    await expect(
      removeAccountAddress(BAD_DB, new Uint8Array([1]))
    ).rejects.toThrow();
  });

  it("upsertForeignAccountCode rejects on bad dbId", async () => {
    await expect(
      upsertForeignAccountCode(BAD_DB, "0xacc", new Uint8Array([1]), "0xroot")
    ).rejects.toThrow();
  });

  it("getForeignAccountCode rejects on bad dbId", async () => {
    await expect(getForeignAccountCode(BAD_DB, ["0xacc"])).rejects.toThrow();
  });

  it("lockAccount rejects on bad dbId", async () => {
    await expect(lockAccount(BAD_DB, "0xacc")).rejects.toThrow();
  });

  it("applyAccountPatch rejects on bad dbId", async () => {
    await expect(
      applyAccountPatch(
        BAD_DB,
        "0xacc",
        "1",
        [],
        [],
        [],
        "0xcode",
        "0xsr",
        "0xvr",
        false,
        "0xcommit"
      )
    ).rejects.toThrow();
  });

  it("applyFullAccountState rejects on bad dbId", async () => {
    await expect(
      applyFullAccountState(BAD_DB, {
        accountId: "0xacc",
        nonce: "1",
        storageSlots: [],
        storageMapEntries: [],
        assets: [],
        codeRoot: "0xcode",
        storageRoot: "0xsr",
        vaultRoot: "0xvr",
        committed: false,
        accountCommitment: "0xcommit",
        accountSeed: undefined,
      })
    ).rejects.toThrow();
  });

  it("undoAccountStates rejects on bad dbId", async () => {
    await expect(undoAccountStates(BAD_DB, ["0xcommit"])).rejects.toThrow();
  });

  it("pruneAccountHistory rejects on bad dbId", async () => {
    await expect(pruneAccountHistory(BAD_DB, "0xacc", "10")).rejects.toThrow();
  });
});

// ============================================================
// Additional coverage: line 1119 — sort comparator (multiple nonces same account)
// ============================================================
describe("undoAccountStates: multiple nonces for same account (sort comparator)", () => {
  it("undoes multiple nonces for the same account in descending order", async () => {
    const dbId = await openTestDb("0.0.1");
    const db = getDatabase(dbId);

    // Build 3 deltas for the same account to exercise the sort comparator at 1119
    await applyAccountPatch(
      dbId,
      ACC,
      "1",
      [{ slotName: "slot1", slotValue: "0xv1", slotType: 0 }],
      [],
      [],
      CODE_ROOT,
      STORAGE_ROOT,
      VAULT_ROOT,
      false,
      "0xc1"
    );
    await applyAccountPatch(
      dbId,
      ACC,
      "2",
      [{ slotName: "slot1", slotValue: "0xv2", slotType: 0 }],
      [],
      [],
      CODE_ROOT,
      "0xsr2",
      VAULT_ROOT,
      false,
      "0xc2"
    );
    await applyAccountPatch(
      dbId,
      ACC,
      "3",
      [{ slotName: "slot1", slotValue: "0xv3", slotType: 0 }],
      [],
      [],
      CODE_ROOT,
      "0xsr3",
      VAULT_ROOT,
      false,
      "0xc3"
    );

    // Undo both nonce 2 and 3 at once — they have the same accountId,
    // so accountNonces will have one entry with {2, 3}, triggering the sort.
    await undoAccountStates(dbId, ["0xc2", "0xc3"]);

    // After undoing nonces 2 and 3, the slot value should be back to nonce "1" state
    const slots = await db.latestAccountStorages
      .where("accountId")
      .equals(ACC)
      .toArray();
    expect(slots[0].slotValue).toBe("0xv1");
  });
});
