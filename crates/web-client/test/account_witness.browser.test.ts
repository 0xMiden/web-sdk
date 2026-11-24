// @ts-nocheck
import { test, expect } from "./test-setup";

// Node mock clients keep no named store, so reopening is browser-only.
test.describe("tracked account witnesses", () => {
  test("a tracked account survives reopening the store", async ({ run }) => {
    const result = await run(async ({ helpers }) => {
      const storeName = `witness_reopen_${Date.now()}`;
      const first = await helpers.createMidenMockClient({ storeName });
      const wallet = await first.accounts.create();
      await first.accounts.trackWitness(wallet.id());
      await first.terminate();
      const reopened = await helpers.createMidenMockClient({ storeName });
      const tracked = (await reopened.accounts.trackedWitnesses()).map((a) =>
        a.toString()
      );
      return { id: wallet.id().toString(), tracked };
    });
    expect(result.tracked).toEqual([result.id]);
  });
});
