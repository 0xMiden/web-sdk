// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("AccountReader tests", () => {
  test("creates account reader and reads account data correctly", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const account = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const reader = await client.accountReader(account.id());

      const nonce = await reader.nonce();
      const commitment = await reader.commitment();
      const isNew = (await reader.status()).isNew();
      const codeCommitment = await reader.codeCommitment();

      return {
        accountId: account.id().toString(),
        readerId: reader.accountId().toString(),
        accountNonce: account.nonce().toString(),
        readerNonce: nonce.toString(),
        accountCommitment: account.to_commitment().toHex(),
        readerCommitment: commitment.toHex(),
        accountCodeCommitment: account.code().commitment().toHex(),
        readerCodeCommitment: codeCommitment.toHex(),
        isNew,
      };
    });
    expect(result.accountId).toEqual(result.readerId);
    expect(result.accountNonce).toEqual(result.readerNonce);
    expect(result.accountCommitment).toEqual(result.readerCommitment);
    expect(result.accountCodeCommitment).toEqual(result.readerCodeCommitment);
    expect(result.isNew).toBe(true);
  });
});

test.describe("shared account forest cache", () => {
  test("an interleaved account batch preserves each intermediate state", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "IndexedDB cache is browser-only"
    );
    const result = await run(async ({ sdk }) => {
      const db = `forest_${crypto.randomUUID()}`;
      const fixture = await (
        await sdk.getWasmOrThrow()
      ).AccountForestFixture.create(db);
      try {
        const otherBalances = await fixture.applyInterleavedBatch();
        return {
          otherBalances,
          fee: (await fixture.readAsset(false)).toString(),
          token: (await fixture.readAsset(true)).toString(),
          rows: JSON.parse(await sdk.exportStore(db)),
        };
      } finally {
        fixture.free();
      }
    });
    expect(result.otherBalances).toEqual(["1867", "555"]);
    expect(result.fee).toBe("734");
    expect(result.token).toBe("777");
    expect(result.rows.transactions).toHaveLength(3);
  });
  test("full account reads refresh witnesses without writing persisted state", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "IndexedDB cache is browser-only"
    );
    const result = await run(async ({ sdk }) => {
      const db = `forest_${crypto.randomUUID()}`;
      const native = await sdk.getWasmOrThrow();
      const fixture = await native.AccountForestFixture.create(db);
      try {
        const before = await sdk.exportStore(db);
        await fixture.readAccount();
        const fee = await fixture.readAsset(false);
        const token = await fixture.readAsset(true);
        const map = await fixture.readMap();
        const after = await sdk.exportStore(db);
        return {
          fee: fee.toString(),
          token: token.toString(),
          map,
          unchanged: before === after,
        };
      } finally {
        fixture.free();
      }
    });
    expect(result.fee).toBe("1000");
    expect(result.token).toBe("777");
    expect(result.map).toBe(
      "0x0500000000000000060000000000000007000000000000000800000000000000"
    );
    expect(result.unchanged).toBe(true);
  });

  test("witness reads refresh a tracked vault and map without a full account read", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "IndexedDB cache is browser-only"
    );
    const results = await run(async ({ sdk }) => {
      const results = [];
      for (const mapFirst of [false, true]) {
        const db = `forest_${crypto.randomUUID()}`;
        const fixture = await (
          await sdk.getWasmOrThrow()
        ).AccountForestFixture.create(db);
        try {
          const before = await sdk.exportStore(db);
          let token, map;
          if (mapFirst) {
            map = await fixture.readMap();
            token = await fixture.readAsset(true);
          } else {
            token = await fixture.readAsset(true);
            map = await fixture.readMap();
          }
          results.push({
            token: token.toString(),
            map,
            unchanged: before === (await sdk.exportStore(db)),
          });
        } finally {
          fixture.free();
        }
      }
      return results;
    });
    for (const result of results) {
      expect(result.token).toBe("777");
      expect(result.map).toBe(
        "0x0500000000000000060000000000000007000000000000000800000000000000"
      );
      expect(result.unchanged).toBe(true);
    }
  });

  test("single and sequential batch applies retain untouched assets and maps", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "IndexedDB cache is browser-only"
    );
    const results = await run(async ({ sdk }) => {
      const results = [];
      for (const batch of [false, true]) {
        const db = `forest_${crypto.randomUUID()}`;
        const fixture = await (
          await sdk.getWasmOrThrow()
        ).AccountForestFixture.create(db);
        try {
          await fixture.apply(batch);
          results.push({
            fee: (await fixture.readAsset(false)).toString(),
            token: (await fixture.readAsset(true)).toString(),
            map: await fixture.readMap(),
            rows: JSON.parse(await sdk.exportStore(db)),
          });
        } finally {
          fixture.free();
        }
      }
      return results;
    });
    for (const [index, result] of results.entries()) {
      expect(result.fee).toBe(index === 1 ? "734" : "867");
      expect(result.token).toBe("777");
      expect(result.map).toBe(
        "0x0500000000000000060000000000000007000000000000000800000000000000"
      );
      expect(result.rows.transactions).toHaveLength(index === 1 ? 2 : 1);
      expect(
        result.rows.historicalAccountAssets.filter(
          (row) => row.replacedAtNonce === "3"
        )
      ).toHaveLength(1);
      if (index === 1)
        expect(
          result.rows.historicalAccountAssets.filter(
            (row) => row.replacedAtNonce === "4"
          )
        ).toHaveLength(1);
    }
  });

  test("single and batch applies reject persisted final or later state before writes", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "IndexedDB cache is browser-only"
    );
    const results = await run(async ({ sdk }) => {
      const results = [];
      for (const batch of [false, true])
        for (const later of [false, true]) {
          const db = `forest_${crypto.randomUUID()}`;
          const fixture = await (
            await sdk.getWasmOrThrow()
          ).AccountForestFixture.create(db);
          try {
            await fixture.adoptFinalState(later);
            const before = await sdk.exportStore(db);
            let error;
            try {
              await fixture.apply(batch);
            } catch (caught) {
              error = String(caught);
            }
            results.push({
              error,
              unchanged: before === (await sdk.exportStore(db)),
            });
          } finally {
            fixture.free();
          }
        }
      return results;
    });
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.error).toContain("transaction input account commitment");
      expect(result.unchanged).toBe(true);
    }
  });

  test("a discontinuous batch leaves all persisted tables unchanged", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "IndexedDB cache is browser-only"
    );
    const result = await run(async ({ sdk }) => {
      const db = `forest_${crypto.randomUUID()}`;
      const fixture = await (
        await sdk.getWasmOrThrow()
      ).AccountForestFixture.create(db);
      try {
        const before = await sdk.exportStore(db);
        let error;
        try {
          await fixture.applyDiscontinuousBatch();
        } catch (caught) {
          error = String(caught);
        }
        return {
          error,
          fee: (await fixture.readAsset(false)).toString(),
          token: (await fixture.readAsset(true)).toString(),
          unchanged: before === (await sdk.exportStore(db)),
        };
      } finally {
        fixture.free();
      }
    });
    expect(result.error).toContain("transaction input account commitment");
    expect(result.fee).toBe("1000");
    expect(result.token).toBe("777");
    expect(result.unchanged).toBe(true);
  });

  test("a later preparation failure restores the staged forest", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "IndexedDB cache is browser-only"
    );
    const result = await run(async ({ sdk }) => {
      const db = `forest_${crypto.randomUUID()}`;
      const fixture = await (
        await sdk.getWasmOrThrow()
      ).AccountForestFixture.create(db);
      const before = await sdk.exportStore(db);
      let error;
      try {
        await fixture.applyInvalidFinalRootBatch();
      } catch (caught) {
        error = String(caught);
      }
      const unchanged = before === (await sdk.exportStore(db));
      const rows = JSON.parse(before);
      const removed = rows.latestAccountAssets[0];
      const connection = await new Promise((resolve, reject) => {
        const open = indexedDB.open(db);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const write = (restore) =>
        new Promise((resolve, reject) => {
          const tx = connection.transaction("latestAccountAssets", "readwrite");
          const table = tx.objectStore("latestAccountAssets");
          if (restore) table.put(removed);
          else table.delete([removed.accountId, removed.vaultKey]);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      let fee, map;
      try {
        await write(false);
        fee = (await fixture.readAsset(false)).toString();
        map = await fixture.readMap();
      } finally {
        await write(true);
        connection.close();
        fixture.free();
      }
      return {
        error,
        unchanged: unchanged && before === (await sdk.exportStore(db)),
        fee,
        map,
      };
    });
    expect(result.error).toContain("ConflictingRoots");
    expect(result.unchanged).toBe(true);
    expect(result.fee).toBe("1000");
    expect(result.map).toBe(
      "0x0500000000000000060000000000000007000000000000000800000000000000"
    );
  });

  test("an incomplete snapshot is rejected before refreshing the account cache", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "IndexedDB cache is browser-only"
    );
    const result = await run(async ({ sdk }) => {
      const db = `forest_${crypto.randomUUID()}`;
      const fixture = await (
        await sdk.getWasmOrThrow()
      ).AccountForestFixture.create(db);
      try {
        const rows = JSON.parse(await sdk.exportStore(db));
        const removed = rows.latestAccountAssets[0];
        const connection = await new Promise((resolve, reject) => {
          const open = indexedDB.open(db);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const write = async (restore) =>
          new Promise((resolve, reject) => {
            const tx = connection.transaction(
              "latestAccountAssets",
              "readwrite"
            );
            const table = tx.objectStore("latestAccountAssets");
            if (restore) table.put(removed);
            else table.delete([removed.accountId, removed.vaultKey]);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
        await write(false);
        let error;
        try {
          await fixture.readAccount();
        } catch (caught) {
          error = String(caught);
        }
        await write(true);
        connection.close();
        return { error, token: (await fixture.readAsset(true)).toString() };
      } finally {
        fixture.free();
      }
    });
    expect(result.error).toContain("account snapshot commitment");
    expect(result.token).toBe("777");
  });
});
