import { describe, it, expect, afterEach } from "vitest";
import { openDatabase, getDatabase } from "./schema.js";
import {
  trackAccountWitness,
  untrackAccountWitness,
  trackedAccountWitnesses,
  getAccountWitness,
  updateAccountWitness,
} from "./witnesses.js";
import { uniqueDbName } from "./test-utils.js";

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

describe("account witnesses", () => {
  it("tracks once, caches only through update, and drops the row on untrack", async () => {
    const dbId = await openTestDb();
    const witness = new Uint8Array([1, 2, 3]);

    expect(await trackAccountWitness(dbId, "0xacc")).toBe(true);
    expect(await trackAccountWitness(dbId, "0xacc")).toBe(false);
    expect(await getAccountWitness(dbId, "0xacc")).toBeNull();
    expect(await trackedAccountWitnesses(dbId)).toEqual(["0xacc"]);

    expect(await updateAccountWitness(dbId, "0xmissing", witness)).toBe(false);
    expect(await updateAccountWitness(dbId, "0xacc", witness)).toBe(true);
    expect(await getAccountWitness(dbId, "0xacc")).toEqual(witness);
    // Re-tracking must not drop the cached witness.
    expect(await trackAccountWitness(dbId, "0xacc")).toBe(false);
    expect(await getAccountWitness(dbId, "0xacc")).toEqual(witness);

    expect(await untrackAccountWitness(dbId, "0xacc")).toBe(true);
    expect(await untrackAccountWitness(dbId, "0xacc")).toBe(false);
    expect(await getAccountWitness(dbId, "0xacc")).toBeNull();
    expect(await trackedAccountWitnesses(dbId)).toEqual([]);
  });
});
