// @ts-nocheck
import { test, expect } from "./test-setup";

// Building a client stores the transaction kernel and the libraries it is built
// with in the code registry of the IndexedDB store. Building another client on
// the same store adds no rows.
test.describe("code registry", () => {
  test("a client build stores the known packages once", async ({ run }) => {
    const result = await run(async ({ helpers }) => {
      const request = (idbRequest) =>
        new Promise((resolve, reject) => {
          idbRequest.onsuccess = () => resolve(idbRequest.result);
          idbRequest.onerror = () => reject(idbRequest.error);
        });
      const counts = async () => {
        const db = await request(indexedDB.open("mock_client_db"));
        const count = (storeName) =>
          request(db.transaction(storeName).objectStore(storeName).count());
        const result = {
          forests: await count("codeMastForests"),
          procedures: await count("codeProcedures"),
        };
        db.close();
        return result;
      };

      const afterFirstBuild = await counts();
      await helpers.createFreshMockClient();
      const afterSecondBuild = await counts();
      return { afterFirstBuild, afterSecondBuild };
    });

    expect(result.afterFirstBuild.forests).toBeGreaterThan(0);
    expect(result.afterFirstBuild.procedures).toBeGreaterThan(
      result.afterFirstBuild.forests
    );
    expect(result.afterSecondBuild).toEqual(result.afterFirstBuild);
  });
});
