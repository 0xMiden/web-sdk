// @ts-nocheck
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

let server;
let origin;
const root = resolve(import.meta.dirname, "../dist");

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>IndexedDB safety</title>");
      return;
    }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}/`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader(
        "Content-Type",
        extname(file) === ".wasm" ? "application/wasm" : "text/javascript"
      );
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const workerProbe = `
const originalIdbTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (...args) {
  const tx = originalIdbTransaction.apply(this, args);
  if (tx.mode === "readwrite") self.postMessage({ storageProbe: { durability: tx.durability, storeName: this.name } });
  return tx;
};
`;

async function prepare(page, build, entry, workerMode) {
  await page.route(
    "**/workers/web-client-methods-worker*.js",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: workerProbe + (await response.text()),
      });
    }
  );
  await page.goto(origin);
  return page.evaluate(
    async ({ build, entry, workerMode }) => {
      const main = [];
      const worker = [];
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (tx.mode === "readwrite") main.push(tx.durability);
        return tx;
      };
      const NativeWorker = Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (data.storageProbe) worker.push(data.storageProbe.durability);
          });
        }
      };
      const sdk = await import(`/${build}/${entry}.js`);
      sdk.WasmWebClient.workerMode = workerMode;
      const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      // Mock validator keys are independent of the client seed. Persist one
      // genesis before the worker's independently created mock can race it.
      const bootstrap = await sdk.MockWebClient.createClient(
        undefined,
        undefined,
        seed,
        undefined,
        { durability: "strict" },
        false
      );
      const chain = await bootstrap.serializeMockChain();
      const transport = await bootstrap.serializeMockNoteTransportNode();
      bootstrap.terminate();
      await bootstrap.waitForIdle();
      const order = [];
      const failures = [];
      const client = await sdk.MockWebClient.createClient(
        chain,
        transport,
        seed,
        undefined,
        {
          durability: "strict",
          onFailure: (failure) => {
            failures.push(failure);
            order.push("failure");
          },
        }
      );
      await client.setSetting("browser-durability", new Uint8Array([1, 2, 3]));
      const stored = Array.from(await client.getSetting("browser-durability"));
      await client.syncState();
      window.storageTest = { client, sdk, main, worker, failures, order };
      return { stored, main, worker, isolated: crossOriginIsolated };
    },
    { build, entry, workerMode }
  );
}

for (const build of ["st", "mt"]) {
  for (const entry of ["index", "eager"]) {
    for (const workerMode of ["classic", "module"]) {
      test(`${build}/${entry} ${workerMode}: strict main and worker transactions`, async ({
        page,
        browserName,
      }) => {
        test.skip(
          build === "mt" && browserName === "webkit",
          "Threaded WASM requires the Chromium CI capability"
        );
        const result = await prepare(page, build, entry, workerMode);
        expect(result.stored).toEqual([1, 2, 3]);
        expect(result.main.length).toBeGreaterThan(0);
        expect(result.worker.length).toBeGreaterThan(0);
        expect(result.main.every((value) => value === "strict")).toBe(true);
        expect(result.worker.every((value) => value === "strict")).toBe(true);
        if (build === "mt") expect(result.isolated).toBe(true);
        await page.evaluate(() => window.storageTest.client.terminate());
      });
    }
  }
}

for (const route of ["main", "worker"]) {
  test(`native Chromium quota failure reaches ${route} callback before rejection`, async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "CDP quota override is Chromium-only"
    );
    await prepare(page, "st", "index", "module");
    await page.evaluate(async () => {
      await window.storageTest.client.proveBlock();
      await window.storageTest.client.proveBlock();
      window.storageTest.failures.length = 0;
      window.storageTest.order.length = 0;
      window.storageTest.quotaProbe = await new Promise((resolve, reject) => {
        const request = indexedDB.open("quota-calibration", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("probe");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1 });
    try {
      const quota = await cdp.send("Storage.getUsageAndQuota", { origin });
      expect(quota.overrideActive).toBe(true);
      expect(quota.quota).toBe(1);
      // Chromium caches bucket headroom for 30 seconds. Wait for native quota
      // enforcement with at most 40 KiB of payload, without faking errors.
      const calibration = await page.evaluate(async () => {
        const db = window.storageTest.quotaProbe;
        for (let attempt = 0; attempt < 40; attempt++) {
          const errorName = await new Promise((resolve) => {
            const tx = db.transaction("probe", "readwrite");
            let cause;
            const request = tx
              .objectStore("probe")
              .add(crypto.getRandomValues(new Uint8Array(1024)), attempt);
            request.onerror = () => {
              cause = request.error?.name;
            };
            tx.oncomplete = () => resolve(undefined);
            tx.onabort = () => resolve(cause ?? tx.error?.name ?? "AbortError");
          });
          if (errorName) return { errorName, attempts: attempt + 1 };
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return { errorName: "QuotaNotEnforced", attempts: 40 };
      });
      expect(calibration.errorName).toBe("QuotaExceededError");
      expect(
        await page.evaluate(() => ({
          failures: window.storageTest.failures,
          order: window.storageTest.order,
        }))
      ).toEqual({ failures: [], order: [] });
      const result = await page.evaluate(async (route) => {
        const { client, failures, order } = window.storageTest;
        let rejected = false;
        try {
          if (route === "main")
            await client.setSetting("quota-growth", new Uint8Array(256 * 1024));
          else await client.syncState();
        } catch {
          rejected = true;
          order.push("rejection");
        }
        return { rejected, failures, order };
      }, route);
      expect(result.rejected).toBe(true);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.failures.every((failure) => failure.kind === "quota")).toBe(
        true
      );
      expect(result.order[0]).toBe("failure");
      expect(result.order.at(-1)).toBe("rejection");
      for (const failure of result.failures)
        expect(Object.keys(failure).sort()).toEqual([
          "backend",
          "errorName",
          "eventId",
          "kind",
          "operation",
          "phase",
          "storeName",
        ]);
    } finally {
      await cdp.send("Storage.overrideQuotaForOrigin", { origin });
      await page.evaluate(() => {
        window.storageTest.quotaProbe.close();
        window.storageTest.client.terminate();
      });
      await cdp.detach();
    }
  });
}

test("standalone export and import retain strict policy without live client holders", async ({
  page,
}) => {
  await prepare(page, "st", "index", "module");
  const result = await page.evaluate(async () => {
    const { client, sdk, main } = window.storageTest;
    const dump = await sdk.exportStore("mock_client_db", {
      durability: "strict",
    });
    client.terminate();
    await client.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    main.length = 0;
    await sdk.importStore("mock_client_db", dump, { durability: "strict" });
    const restored = JSON.parse(
      await sdk.exportStore("mock_client_db", { durability: "strict" })
    );
    return {
      restored: JSON.stringify(restored) === JSON.stringify(JSON.parse(dump)),
      transactions: main,
    };
  });
  expect(result.restored).toBe(true);
  expect(result.transactions.length).toBeGreaterThan(0);
  expect(result.transactions.every((value) => value === "strict")).toBe(true);
});
