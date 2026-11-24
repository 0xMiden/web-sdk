// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("tracked account witnesses", () => {
  test("track, list and untrack report whether the registry changed", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const client = await helpers.createMidenMockClient();
      const wallet = await client.accounts.create();
      const id = wallet.id();
      const first = await client.accounts.trackWitness(id);
      const again = await client.accounts.trackWitness(id);
      const tracked = (await client.accounts.trackedWitnesses()).map((a) =>
        a.toString()
      );
      const removed = await client.accounts.untrackWitness(id);
      const removedAgain = await client.accounts.untrackWitness(id);
      const after = await client.accounts.trackedWitnesses();
      return {
        id: id.toString(),
        first,
        again,
        tracked,
        removed,
        removedAgain,
        afterLength: after.length,
      };
    });
    expect(result.first).toBe(true);
    expect(result.again).toBe(false);
    expect(result.tracked).toEqual([result.id]);
    expect(result.removed).toBe(true);
    expect(result.removedAgain).toBe(false);
    expect(result.afterLength).toBe(0);
  });
});

test.describe("storage map witness", () => {
  test("returns the stored value and the map root for a key", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const SLOT_NAME = "test::balances";
      const code = `
        use miden::protocol::active_account
        use miden::core::word
        use miden::core::sys

        const MAP_SLOT = word("${SLOT_NAME}")

        @account_procedure
        pub proc get_balance
          push.MAP_SLOT[0..2] exec.active_account::get_map_item
          exec.sys::truncate_stack
        end
      `;
      const client = await helpers.createMidenMockClient();
      const key = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const value = new sdk.Word(sdk.u64Array([5, 6, 7, 8]));
      const map = new sdk.StorageMap();
      map.insert(key, value);
      const component = await client.compile.component({
        code,
        slots: [sdk.StorageSlot.map(SLOT_NAME, map)],
      });
      const seed = new Uint8Array(32).fill(0x31);
      const account = await client.accounts.create({
        type: "ImmutableContract",
        storage: "public",
        seed,
        auth: sdk.AuthSecretKey.rpoFalconWithRNG(seed),
        components: [component],
      });
      const witness = await client.accounts.getStorageMapWitness(
        account.id(),
        SLOT_NAME,
        key
      );
      return {
        got: witness.get(key).toHex(),
        expected: value.toHex(),
        root: witness.root().toHex(),
      };
    });
    expect(result.got).toBe(result.expected);
    expect(result.root).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

test.describe("watch-only import", () => {
  test("imports without subscribing to the account's note tag", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const integration = await helpers.createIntegrationClient();
      if (!integration) return { skip: true };
      const { client } = integration;
      const faucetId = await client.feeFaucetId();
      const id = sdk.AccountId.fromHex(faucetId.toString());
      const before = (await client.listTags()).length;
      await client.importWatchedAccountById(id);
      const account = await client.getAccount(id);
      const after = (await client.listTags()).length;
      return {
        skip: false,
        imported: account?.id().toString() === id.toString(),
        before,
        after,
      };
    });
    test.skip(result.skip, "no node reachable");
    expect(result.imported).toBe(true);
    expect(result.after).toBe(result.before);
  });
});
