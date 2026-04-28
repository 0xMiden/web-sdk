import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  insertAccountAuth,
  getAccountAuthByPubKeyCommitment,
  removeAccountAuth,
  insertAccountKeyMapping,
  getKeyCommitmentsByAccountId,
  removeAllMappingsForKey,
  getAccountIdByKeyCommitment,
} from "./auth.js";

let dbCounter = 0;
function uniqueDbName(): string {
  return `test-auth-${++dbCounter}-${Date.now()}`;
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

describe("auth", () => {
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

  // ---------------------------------------------------------------------------
  // insertAccountAuth / getAccountAuthByPubKeyCommitment
  // ---------------------------------------------------------------------------

  it("inserts an account auth and retrieves it by pubkey commitment", async () => {
    const dbId = await openTestDb();
    await insertAccountAuth(dbId, "pubkey-abc", "secretkey-xyz");
    const result = await getAccountAuthByPubKeyCommitment(dbId, "pubkey-abc");
    expect(result).toEqual({ secretKey: "secretkey-xyz" });
  });

  it("stores multiple account auths independently", async () => {
    const dbId = await openTestDb();
    await insertAccountAuth(dbId, "pubkey-1", "secret-1");
    await insertAccountAuth(dbId, "pubkey-2", "secret-2");
    const r1 = await getAccountAuthByPubKeyCommitment(dbId, "pubkey-1");
    const r2 = await getAccountAuthByPubKeyCommitment(dbId, "pubkey-2");
    expect(r1).toEqual({ secretKey: "secret-1" });
    expect(r2).toEqual({ secretKey: "secret-2" });
  });

  it("getAccountAuthByPubKeyCommitment throws when record does not exist", async () => {
    const dbId = await openTestDb();
    await expect(
      getAccountAuthByPubKeyCommitment(dbId, "nonexistent-key")
    ).rejects.toThrow("Account auth not found in cache.");
  });

  it("insertAccountAuth throws (via logWebStoreError rethrow) when db is not opened", async () => {
    await expect(
      insertAccountAuth("never-opened", "pubkey-abc", "secretkey-xyz")
    ).rejects.toThrow();
  });

  it("getAccountAuthByPubKeyCommitment throws when db is not opened", async () => {
    // No try/catch in getAccountAuthByPubKeyCommitment — getDatabase throws propagate
    await expect(
      getAccountAuthByPubKeyCommitment("never-opened", "pubkey-abc")
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // removeAccountAuth
  // ---------------------------------------------------------------------------

  it("removes an account auth", async () => {
    const dbId = await openTestDb();
    await insertAccountAuth(dbId, "pubkey-del", "secret-del");
    await removeAccountAuth(dbId, "pubkey-del");
    await expect(
      getAccountAuthByPubKeyCommitment(dbId, "pubkey-del")
    ).rejects.toThrow("Account auth not found in cache.");
  });

  it("removeAccountAuth on a missing key is a no-op", async () => {
    const dbId = await openTestDb();
    // Should not throw
    await removeAccountAuth(dbId, "nonexistent-key");
  });

  it("removeAccountAuth throws (via logWebStoreError rethrow) when db is not opened", async () => {
    await expect(
      removeAccountAuth("never-opened", "pubkey-abc")
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // insertAccountKeyMapping / getKeyCommitmentsByAccountId
  // ---------------------------------------------------------------------------

  it("inserts a key mapping and retrieves commitments by account id", async () => {
    const dbId = await openTestDb();
    await insertAccountKeyMapping(dbId, "account-1", "pubkey-commitment-1");
    const commitments = await getKeyCommitmentsByAccountId(dbId, "account-1");
    expect(commitments).toEqual(["pubkey-commitment-1"]);
  });

  it("inserts multiple mappings for the same account and retrieves all commitments", async () => {
    const dbId = await openTestDb();
    await insertAccountKeyMapping(dbId, "account-multi", "commitment-a");
    await insertAccountKeyMapping(dbId, "account-multi", "commitment-b");
    const commitments = await getKeyCommitmentsByAccountId(
      dbId,
      "account-multi"
    );
    expect(commitments).toHaveLength(2);
    expect(commitments).toEqual(
      expect.arrayContaining(["commitment-a", "commitment-b"])
    );
  });

  it("insertAccountKeyMapping is idempotent (put semantics) for the same pair", async () => {
    const dbId = await openTestDb();
    await insertAccountKeyMapping(dbId, "account-idem", "commitment-idem");
    await insertAccountKeyMapping(dbId, "account-idem", "commitment-idem");
    const commitments = await getKeyCommitmentsByAccountId(
      dbId,
      "account-idem"
    );
    // put semantics: the second call replaces the first — still one entry
    expect(commitments).toHaveLength(1);
  });

  it("getKeyCommitmentsByAccountId returns empty array when no mappings exist", async () => {
    const dbId = await openTestDb();
    const commitments = await getKeyCommitmentsByAccountId(dbId, "no-account");
    expect(commitments).toEqual([]);
  });

  it("insertAccountKeyMapping throws (via logWebStoreError rethrow) when db is not opened", async () => {
    await expect(
      insertAccountKeyMapping("never-opened", "account-1", "commitment-1")
    ).rejects.toThrow();
  });

  it("getKeyCommitmentsByAccountId throws (via logWebStoreError rethrow) when db is not opened", async () => {
    await expect(
      getKeyCommitmentsByAccountId("never-opened", "account-1")
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // removeAllMappingsForKey
  // ---------------------------------------------------------------------------

  it("removes all account key mappings for a given key commitment", async () => {
    const dbId = await openTestDb();
    await insertAccountKeyMapping(dbId, "account-a", "shared-commitment");
    await insertAccountKeyMapping(dbId, "account-b", "shared-commitment");
    await removeAllMappingsForKey(dbId, "shared-commitment");
    // Both accounts should now have no mappings for shared-commitment
    const idResult = await getAccountIdByKeyCommitment(
      dbId,
      "shared-commitment"
    );
    expect(idResult).toBeNull();
  });

  it("removeAllMappingsForKey on a missing key is a no-op", async () => {
    const dbId = await openTestDb();
    await removeAllMappingsForKey(dbId, "nonexistent-commitment");
    // No throw means success
  });

  it("removeAllMappingsForKey throws (via logWebStoreError rethrow) when db is not opened", async () => {
    await expect(
      removeAllMappingsForKey("never-opened", "commitment-x")
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // getAccountIdByKeyCommitment
  // ---------------------------------------------------------------------------

  it("retrieves account id by key commitment", async () => {
    const dbId = await openTestDb();
    await insertAccountKeyMapping(dbId, "account-lookup", "commitment-lookup");
    const accountId = await getAccountIdByKeyCommitment(
      dbId,
      "commitment-lookup"
    );
    expect(accountId).toBe("account-lookup");
  });

  it("getAccountIdByKeyCommitment returns null when commitment is not found", async () => {
    const dbId = await openTestDb();
    const accountId = await getAccountIdByKeyCommitment(
      dbId,
      "nonexistent-commitment"
    );
    expect(accountId).toBeNull();
  });

  it("getAccountIdByKeyCommitment throws (via logWebStoreError rethrow) when db is not opened", async () => {
    await expect(
      getAccountIdByKeyCommitment("never-opened", "commitment-x")
    ).rejects.toThrow();
  });
});
