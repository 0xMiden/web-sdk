// Raw IndexedDB bulk-write throughput probe: N records shaped like forestSubtrees
// rows, one transaction, with and without a secondary index.
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../crates/web-client/package.json", import.meta.url)
);
const { chromium } = require("@playwright/test");

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>probe</title>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);

const result = await page.evaluate(async () => {
  const N = 70000;
  const run = (name, durability) =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore("subtrees", {
          keyPath: ["lineage", "depth", "position"],
        });
      };
      open.onsuccess = () => {
        const db = open.result;
        const rows = [];
        const lineage = "a".repeat(64);
        for (let i = 0; i < N; i++) {
          rows.push({
            lineage,
            depth: 56,
            position: i.toString(16).padStart(16, "0"),
            blob: new Uint8Array(500).fill(i & 0xff),
          });
        }
        const t0 = performance.now();
        const tx = db.transaction("subtrees", "readwrite", { durability });
        const store = tx.objectStore("subtrees");
        for (const row of rows) store.put(row);
        tx.oncomplete = () => resolve(performance.now() - t0);
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });

  const strict = await run("probe-strict", "strict");
  const relaxed = await run("probe-relaxed", "relaxed");
  const relaxed2 = await run("probe-relaxed-2", "relaxed");
  return { N, strictMs: strict, relaxedMs: relaxed, relaxed2Ms: relaxed2 };
});

console.log(JSON.stringify(result));
await browser.close();
