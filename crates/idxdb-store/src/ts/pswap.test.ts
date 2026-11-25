import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { openDatabase, getDatabase, PSWAP_STATE_ACTIVE } from "./schema.js";
import {
  getPswapLineage,
  getPswapLineages,
  getPswapOrderIdByTip,
  upsertPswapLineage,
} from "./pswap.js";

let dbCounter = 0;
function uniqueDbName(): string {
  return `test-pswap-${++dbCounter}-${Date.now()}`;
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

const FULLY_FILLED = 1;

/** Stores the lineage of `orderId` with a one-byte record that names the order. */
function upsert(
  dbId: string,
  orderId: string,
  creator: string,
  tip: string,
  state: number
) {
  return upsertPswapLineage(
    dbId,
    orderId,
    creator,
    tip,
    state,
    new Uint8Array([Number.parseInt(orderId, 16)])
  );
}

describe("pswap lineages", () => {
  let errorSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("follows the latest tip of a lineage and drops it when the lineage ends", async () => {
    const dbId = await openTestDb();
    expect(await getPswapLineage(dbId, "01")).toBeNull();

    await upsert(dbId, "01", "0xa", "0xt1", PSWAP_STATE_ACTIVE);
    expect(await getPswapLineage(dbId, "01")).toBe("AQ==");
    expect(await getPswapOrderIdByTip(dbId, "0xt1")).toBe("01");

    await upsert(dbId, "01", "0xa", "0xt2", PSWAP_STATE_ACTIVE);
    expect(await getPswapOrderIdByTip(dbId, "0xt1")).toBeNull();
    expect(await getPswapOrderIdByTip(dbId, "0xt2")).toBe("01");

    await upsert(dbId, "01", "0xa", "0xt2", FULLY_FILLED);
    expect(await getPswapOrderIdByTip(dbId, "0xt2")).toBeNull();
  });

  it("rejects a second active lineage on the same tip", async () => {
    const dbId = await openTestDb();
    await upsert(dbId, "01", "0xa", "0xt", PSWAP_STATE_ACTIVE);

    await expect(
      upsert(dbId, "02", "0xa", "0xt", PSWAP_STATE_ACTIVE)
    ).rejects.toThrow("already has tip");
    expect(await getPswapLineage(dbId, "02")).toBeNull();
    expect(await getPswapOrderIdByTip(dbId, "0xt")).toBe("01");
  });

  it("selects the lineages of each filter", async () => {
    const dbId = await openTestDb();
    await upsert(dbId, "01", "0xa", "0xt1", PSWAP_STATE_ACTIVE);
    await upsert(dbId, "02", "0xa", "0xt2", FULLY_FILLED);
    await upsert(dbId, "03", "0xb", "0xt3", PSWAP_STATE_ACTIVE);

    expect((await getPswapLineages(dbId, false))?.sort()).toEqual([
      "AQ==",
      "Ag==",
      "Aw==",
    ]);
    expect((await getPswapLineages(dbId, true))?.sort()).toEqual([
      "AQ==",
      "Aw==",
    ]);
    expect((await getPswapLineages(dbId, false, "0xa"))?.sort()).toEqual([
      "AQ==",
      "Ag==",
    ]);
  });

  it("rejects every operation on a database that was never opened", async () => {
    await expect(getPswapLineage("never-opened", "01")).rejects.toThrow();
    await expect(getPswapOrderIdByTip("never-opened", "0xt")).rejects.toThrow();
    await expect(getPswapLineages("never-opened", false)).rejects.toThrow();
    await expect(
      upsert("never-opened", "01", "0xa", "0xt", PSWAP_STATE_ACTIVE)
    ).rejects.toThrow();
  });
});
