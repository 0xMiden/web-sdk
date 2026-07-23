// One-off: insert an N-entry-map account with the branch build, then report the
// per-table row counts and payload bytes via disk-breakdown.js.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../crates/web-client/package.json", import.meta.url)
);
const { chromium } = require("@playwright/test");

const DIST_ST = resolve(process.argv[2] ?? "../crates/web-client/dist", "st");
const N = Number(process.argv[3] ?? 10000);
const breakdownSource = await readFile(
  new URL("./disk-breakdown.js", import.meta.url),
  "utf8"
);

const MIME = {
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};
const server = createServer(async (req, res) => {
  try {
    const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    if (path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>disk</title>");
      return;
    }
    const body = await readFile(join(DIST_ST, path));
    res.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);

await page.evaluate(async () => {
  const sdkExports = await import("./index.js");
  for (const [key, value] of Object.entries(sdkExports)) window[key] = value;
});

const result = await page.evaluate(
  async ({ n, breakdownSource }) => {
    const client = await window.MidenClient.createMock();
    const map = new window.StorageMap();
    for (let i = 0; i < n; i++) {
      const key = window.Word.newFromFelts(
        [0n, 0n, 0n, BigInt(i + 1)].map((v) => new window.Felt(v))
      );
      const value = window.Word.newFromFelts(
        [0n, 0n, 0n, BigInt(2 * i + 1)].map((v) => new window.Felt(v))
      );
      map.insert(key, value);
    }
    const component = await client.compile.component({
      code: `
        use miden::protocol::active_account
        use miden::core::word
        use miden::core::sys
        const S = word("bench::counter")
        @account_procedure
        pub proc get_count
            push.S[0..2] exec.active_account::get_item
            exec.sys::truncate_stack
        end
      `,
      namespace: "external_contract::counter_contract",
      slots: [
        window.StorageSlot.emptyValue("bench::counter"),
        window.StorageSlot.map("bench::bigmap", map),
      ],
    });
    const seed = new Uint8Array(32);
    seed.fill(0x42);
    const auth = window.AuthSecretKey.rpoFalconWithRNG(seed);
    await client.accounts.create({
      type: "ImmutableContract",
      storage: "public",
      seed,
      auth,
      components: [component],
    });

    // Load the breakdown helper and measure.
    // eslint-disable-next-line no-eval
    (0, eval)(breakdownSource);
    const measure =
      globalThis.measureMidenIndexedDb ?? window.measureMidenIndexedDb;
    return await measure();
  },
  { n: N, breakdownSource }
);

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
