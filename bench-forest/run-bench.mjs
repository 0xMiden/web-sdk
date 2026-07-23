// Browser benchmark for the account SMT forest IndexedDB persistence.
//
// Usage:
//   node run-bench.mjs --dist <path-to-web-client-dist> --label <name> [--sizes 1000,10000]
//
// Serves <dist>/st on an ephemeral port, drives a real Chromium via Playwright
// (resolved from crates/web-client's node_modules) and measures, per map size N:
//   - insertMs:      accounts.create() of a contract with an N-entry storage map
//   - updateTxMs:    transactions.execute() of a counter-increment tx on that account
//   - warmReadsMs:   accountReader().getStorageMapItem() witness reads (median of M)
//   - openMs:        raw client construction on a page reload over the existing DB
//   - coldReadMs:    first witness read after the reload
//   - reloadWarmMs:  median warm read after the reload
//   - usageBytes:    navigator.storage.estimate().usage after setup
//
// Results are written to results-<label>.json.

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../crates/web-client/package.json", import.meta.url)
);
const { chromium } = require("@playwright/test");

// ── args ────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean)
);
if (!args.dist || !args.label) {
  console.error(
    "usage: node run-bench.mjs --dist <dist dir> --label <name> [--sizes n,n]"
  );
  process.exit(1);
}
const DIST_ST = resolve(args.dist, "st");
const LABEL = args.label;
const SIZES = (args.sizes ?? "1000,10000,50000").split(",").map(Number);
const WARM_READS = 30;

// ── static server ───────────────────────────────────────────────────
const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".html": "text/html",
};
const server = createServer(async (req, res) => {
  try {
    const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    if (path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>bench</title>");
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
const PORT = server.address().port;
console.log(`[${LABEL}] serving ${DIST_ST} on :${PORT}`);

// ── in-page benchmark ───────────────────────────────────────────────
const COUNTER_CODE = `
  use miden::protocol::active_account
  use miden::protocol::native_account
  use miden::core::word
  use miden::core::sys

  const COUNTER_SLOT = word("bench::counter")

  #! Inputs:  []
  #! Outputs: [count]
  @account_procedure
  pub proc get_count
      push.COUNTER_SLOT[0..2] exec.active_account::get_item
      exec.sys::truncate_stack
  end

  #! Inputs:  []
  #! Outputs: []
  @account_procedure
  pub proc increment_count
      push.COUNTER_SLOT[0..2] exec.active_account::get_item
      add.1
      push.COUNTER_SLOT[0..2] exec.native_account::set_item
      exec.sys::truncate_stack
  end
`;
const MAP_SLOT = "bench::bigmap";
const COUNTER_SLOT = "bench::counter";

async function setupSdk(page) {
  await page.evaluate(async () => {
    const sdkExports = await import("./index.js");
    for (const [key, value] of Object.entries(sdkExports)) {
      window[key] = value;
    }
    const wasm = await window.getWasmOrThrow();
    window.AuthScheme = wasm.AuthScheme;
  });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// A wasm panic can take the whole page down without settling pending
// promises, so every evaluate gets a Node-side deadline; on timeout the
// caller closes the context and the run moves on to the next size.
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function benchSize(browser, n) {
  const context = await browser.newContext(); // fresh profile => empty IndexedDB
  try {
    return await benchSizeInner(context, n);
  } finally {
    await context.close().catch(() => {});
  }
}

async function benchSizeInner(context, n) {
  const page = await context.newPage();
  // A wasm panic in a worker surfaces as a pageerror but leaves the awaited
  // promise pending forever, so evaluates race against this rejection to
  // fail fast instead of running out the deadline.
  let markPageDead;
  const pageDoomed = new Promise((_, reject) => {
    markPageDead = reject;
  });
  pageDoomed.catch(() => {});
  page.on("pageerror", (e) => {
    console.error("  pageerror:", e.message);
    markPageDead(new Error(`pageerror: ${e.message}`));
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  console:", m.text());
    if (m.text().includes("[forest-bench]")) console.log(" ", m.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await setupSdk(page);

  // Phase A: create the account with an N-entry map, execute one update tx,
  // measure warm witness reads through a raw client's AccountReader.
  const phaseA = await withDeadline(
    Promise.race([
      pageDoomed,
      page.evaluate(
        async ({ n, counterCode, mapSlot, counterSlot, warmReads }) => {
          // High-level client: compile, create, prove, sync, execute.
          const client = await window.MidenClient.createMock();

          const map = new window.StorageMap();
          const readIndices = [];
          for (let i = 0; i < n; i++) {
            const key = window.Word.newFromFelts(
              [0n, 0n, 0n, BigInt(i + 1)].map((v) => new window.Felt(v))
            );
            const value = window.Word.newFromFelts(
              [0n, 0n, 0n, BigInt(2 * i + 1)].map((v) => new window.Felt(v))
            );
            map.insert(key, value);
            if (
              readIndices.length < 64 &&
              i % Math.max(1, Math.floor(n / 64)) === 0
            ) {
              readIndices.push(i + 1);
            }
          }

          const component = await client.compile.component({
            code: counterCode,
            namespace: "external_contract::counter_contract",
            slots: [
              window.StorageSlot.emptyValue(counterSlot),
              window.StorageSlot.map(mapSlot, map),
            ],
          });

          const seed = new Uint8Array(32);
          seed.fill(0x42);
          const auth = window.AuthSecretKey.rpoFalconWithRNG(seed);

          const t0 = performance.now();
          const account = await client.accounts.create({
            type: "ImmutableContract",
            storage: "public",
            seed,
            auth,
            components: [component],
          });
          const insertMs = performance.now() - t0;
          const accountId = account.id().toString();

          client.proveBlock();
          await client.sync();

          // Update tx: counter increment (incremental account patch in the store).
          // Only feasible for small maps: the mock chain does not register
          // SDK-created accounts as committed, so the tx carries the full account
          // state and larger maps exceed the protocol's update-size and advice
          // budgets.
          let updateTxMs = null;
          if (n <= 1000) {
            const script = await client.compile.txScript({
              code: `
            use external_contract::counter_contract
            @transaction_script
            pub proc main
              call.counter_contract::increment_count
            end
          `,
              libraries: [{ component }],
            });
            const t1 = performance.now();
            await client.transactions.execute({
              account: account.id(),
              script,
            });
            updateTxMs = performance.now() - t1;
            client.proveBlock();
            await client.sync();
          }

          // Witness reads via a raw client over the same DB (AccountReader is not
          // exposed by the high-level resource API).
          const raw = await window.MockWasmWebClient.createClient();
          if (raw.worker) {
            raw.worker.terminate();
            raw.worker = null;
          }
          const reader = await raw.accountReader(account.id());
          const readKey = (i) =>
            window.Word.newFromFelts(
              [0n, 0n, 0n, BigInt(i)].map((v) => new window.Felt(v))
            );
          const times = [];
          for (let r = 0; r < warmReads; r++) {
            const i = readIndices[r % readIndices.length];
            const s = performance.now();
            await reader.getStorageMapItem(mapSlot, readKey(i));
            times.push(performance.now() - s);
          }

          // A transaction against a second, small account while the store also
          // tracks the heavy one (post-open steady state on both variants).
          // Skipped past 10k entries: the mock chain's MerkleStore node budget
          // panics on any transaction while a ~50k-entry account is tracked, and
          // the panic takes the whole page down, which would also lose phase B.
          let smallTxMs = null;
          const smallTxWork =
            n > 10000
              ? null
              : (async () => {
                  const smallSeed = new Uint8Array(32);
                  smallSeed.fill(0x77);
                  const smallAuth =
                    window.AuthSecretKey.rpoFalconWithRNG(smallSeed);
                  const smallComponent = await client.compile.component({
                    code: counterCode,
                    namespace: "external_contract::counter_contract",
                    slots: [window.StorageSlot.emptyValue(counterSlot)],
                  });
                  const smallAccount = await client.accounts.create({
                    type: "ImmutableContract",
                    storage: "public",
                    seed: smallSeed,
                    auth: smallAuth,
                    components: [smallComponent],
                  });
                  client.proveBlock();
                  await client.sync();
                  const smallScript = await client.compile.txScript({
                    code: `
            use external_contract::counter_contract
            @transaction_script
            pub proc main
              call.counter_contract::increment_count
            end
          `,
                    libraries: [{ component: smallComponent }],
                  });
                  const tS = performance.now();
                  await client.transactions.execute({
                    account: smallAccount.id(),
                    script: smallScript,
                  });
                  const elapsed = performance.now() - tS;
                  client.proveBlock();
                  await client.sync();
                  return elapsed;
                })();
          try {
            if (smallTxWork) {
              smallTxMs = await Promise.race([
                smallTxWork,
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error("small-tx timed out")),
                    90_000
                  )
                ),
              ]);
            }
          } catch (e) {
            console.error("[forest-bench] small-tx skipped:", e.message);
          }

          const estimate = await navigator.storage.estimate();
          return {
            accountId,
            insertMs,
            updateTxMs,
            smallTxMs,
            warmReadTimes: times,
            usageBytes: estimate.usage ?? null,
            readIndices,
          };
        },
        {
          n,
          counterCode: COUNTER_CODE,
          mapSlot: MAP_SLOT,
          counterSlot: COUNTER_SLOT,
          warmReads: WARM_READS,
        }
      ),
    ]),
    120_000 + n * 15,
    "phase A"
  );
  console.log(`[${LABEL}] N=${n} phase A done`);

  // Phase B: reload the page (same context, same IndexedDB) and measure raw
  // client construction plus the first (cold) witness read.
  await page.reload();
  await setupSdk(page);
  const phaseB = await withDeadline(
    Promise.race([
      pageDoomed,
      page.evaluate(
        async ({ accountId, mapSlot, warmReads, readIndices }) => {
          const t0 = performance.now();
          const raw = await window.MockWasmWebClient.createClient();
          if (raw.worker) {
            raw.worker.terminate();
            raw.worker = null;
          }
          const openMs = performance.now() - t0;

          const id = window.AccountId.fromHex(accountId);
          const readKey = (i) =>
            window.Word.newFromFelts(
              [0n, 0n, 0n, BigInt(i)].map((v) => new window.Felt(v))
            );

          const reader = await raw.accountReader(id);
          const t1 = performance.now();
          await reader.getStorageMapItem(mapSlot, readKey(readIndices[0]));
          const coldReadMs = performance.now() - t1;

          const times = [];
          for (let r = 0; r < warmReads; r++) {
            const i = readIndices[r % readIndices.length];
            const s = performance.now();
            await reader.getStorageMapItem(mapSlot, readKey(i));
            times.push(performance.now() - s);
          }
          // usedJSHeapSize covers only the V8 heap (Chrome-only API); the forest
          // lives in wasm linear memory, which never shrinks, so its byteLength
          // after open plus reads reflects what the client allocated.
          const heapBytes = performance.memory?.usedJSHeapSize ?? null;
          let wasmBytes = null;
          try {
            const glue = await window.getWasmOrThrow();
            const exports = await glue.__wbg_init();
            wasmBytes = exports?.memory?.buffer?.byteLength ?? null;
          } catch {
            // leave wasmBytes null if the glue does not expose memory
          }
          return {
            openMs,
            coldReadMs,
            reloadWarmTimes: times,
            heapBytes,
            wasmBytes,
          };
        },
        {
          accountId: phaseA.accountId,
          mapSlot: MAP_SLOT,
          warmReads: WARM_READS,
          readIndices: phaseA.readIndices,
        }
      ),
    ]),
    180_000,
    "phase B"
  );

  return {
    n,
    insertMs: phaseA.insertMs,
    updateTxMs: phaseA.updateTxMs,
    warmReadMedianMs: median(phaseA.warmReadTimes),
    usageBytes: phaseA.usageBytes,
    smallTxMs: phaseA.smallTxMs,
    openMs: phaseB.openMs,
    coldReadMs: phaseB.coldReadMs,
    reloadWarmMedianMs: median(phaseB.reloadWarmTimes),
    heapBytes: phaseB.heapBytes,
    wasmBytes: phaseB.wasmBytes,
  };
}

// ── main ────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const results = { label: LABEL, dist: DIST_ST, sizes: [] };
// The mock chain panics nondeterministically at very large N (the panic
// takes the page down), so each size gets a few attempts in fresh contexts.
const ATTEMPTS = 3;
for (const n of SIZES) {
  let lastError;
  let done = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !done; attempt++) {
    console.log(
      `[${LABEL}] N=${n}${attempt > 1 ? ` (attempt ${attempt})` : ""} ...`
    );
    try {
      const r = await benchSize(browser, n);
      results.sizes.push(r);
      console.log(`[${LABEL}] N=${n}`, JSON.stringify(r));
      done = true;
    } catch (e) {
      lastError = e;
      console.error(`[${LABEL}] N=${n} attempt ${attempt} FAILED:`, e.message);
    }
  }
  if (!done) results.sizes.push({ n, error: lastError.message });
}
await browser.close();
server.close();

const out = new URL(`./results-${LABEL}.json`, import.meta.url);
await writeFile(out, JSON.stringify(results, null, 2));
console.log(`[${LABEL}] wrote ${out.pathname}`);
