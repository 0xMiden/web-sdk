// Benchmarks WASM transaction proving, A/B, for the CI proving-benchmark bot.
//
// Measures ONE workload: proving a note-consume transaction executed by an
// ECDSA-k256-keccak authenticated wallet, on the MT (multi-threaded) build,
// against an in-browser mock chain. No network, no node, no RPC.
//
// Why this workload:
//   - ECDSA-k256-keccak raises a precompile claim, so the proof runs
//     miden-precompiles-prover's STARK session. That session dominates the
//     proof, which makes it where regressions actually show. A Falcon-
//     authenticated account raises no claim.
//   - A mint is executed and authenticated by the FAUCET; a consume is
//     executed by the WALLET. To measure the ECDSA path the ECDSA account has
//     to be the signer, so the workload is a consume and the faucet stays
//     Falcon.
//
// Usage:
//   node scripts/bench-proving.mjs --head <dist-mt-dir> [--base <dist-mt-dir>]
//        [--threads N] [--reps N] [--proves M] [--out results.json]
//
// Pass --calibrate with --base and --head pointing at two COPIES of one dist
// to measure the noise floor: the true delta is zero, so whatever the run
// reports is pure measurement noise. See docs/benchmarks/calibration.md.
//
// Traps this script deliberately avoids (each one silently produces fake
// numbers rather than an error):
//   - `proveTransaction(result, null)` on a mock client returns a DUMMY proof
//     (new_transactions.rs, the cfg(feature = "testing") prove_dummy branch),
//     and every shipped dist is built with `testing` on. Every prove here
//     passes an explicit TransactionProver.newLocalProver().
//   - wasm-bindgen takes the prover BY VALUE, so a reused prover handle throws
//     "null pointer passed to rust". Fresh prover per call.
//   - `sdk.AuthScheme` is a JS string shim that SHADOWS the wasm enum
//     (js/index.js). The real enum comes off getWasmOrThrow().
//   - The mock chain's worker round-trip is broken, and on MT the worker would
//     also start a SECOND rayon pool in its own wasm instance — 16 threads on
//     8 cores. The client is constructed with `Worker` hidden so it takes the
//     documented no-worker branch.
//   - The faucet is not seedable on this branch (generate_faucet uses
//     StdRng::from_os_rng), so its id — and hence the note commitment, the
//     nullifier, the Fiat-Shamir transcript and the proof-of-work grind length
//     — is fresh per run. Setup therefore happens once per REP, not once per
//     side, so the median across reps absorbs grind jitter instead of letting
//     it land whole in the base-vs-head delta.

import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const USAGE = [
  "  node scripts/bench-proving.mjs --head <dist-mt-dir> [--base <dist-mt-dir>]",
  "       [--threads N] [--reps N] [--proves M] [--out results.json]",
].join("\n");

const args = process.argv.slice(2);

const usage = (message) => {
  console.error(`${message}\n\nUsage:\n${USAGE}`);
  process.exit(2);
};

const KNOWN_FLAGS = new Set([
  "--head",
  "--base",
  "--threads",
  "--reps",
  "--proves",
  "--out",
  "--calibrate",
]);

// A misspelled flag would otherwise be ignored and the run would quietly
// report the default config as if it were what was asked for.
for (const arg of args) {
  if (arg.startsWith("--") && !KNOWN_FLAGS.has(arg)) {
    usage(`Unknown flag "${arg}".`);
  }
}

const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  // Catches `--reps` at the end of argv and `--reps --out`, both of which
  // would otherwise parse to NaN and silently run zero iterations.
  if (value === undefined || value.startsWith("--")) {
    usage(`${name} requires a value.`);
  }
  return value;
};

const count = (name, fallback) => {
  const raw = flag(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    usage(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
};

const headDir = flag("--head", null);
if (!headDir) usage("--head is required.");
const baseDirRaw = flag("--base", null);

const resolveDist = path.resolve;
const HEAD_DIR = resolveDist(headDir);
const BASE_DIR = baseDirRaw ? resolveDist(baseDirRaw) : null;

const threads = count("--threads", "8");
const reps = count("--reps", "5");
// Extra proves are the cheap way to buy samples: setup (mint + block + sync)
// dominates a rep's cost and is not measured, while each extra prove is one
// more chance for `min` to catch an uncontended run.
const proves = count("--proves", "4");
const outPath = flag("--out", null);

if (proves < 2) {
  usage(
    "--proves must be at least 2: the first prove of each page is discarded as cold."
  );
}

// Fail here rather than ten seconds later, inside Chromium, as an opaque
// "Failed to fetch dynamically imported module" from a 404ing static server.
for (const [label, dir] of [
  ["head", HEAD_DIR],
  ["base", BASE_DIR],
]) {
  if (!dir) continue;
  if (!(await stat(path.join(dir, "eager.js")).catch(() => null))) {
    usage(
      `No eager.js under ${dir} (--${label}) — build it first (\`pnpm run build-mt\`).`
    );
  }
}

// Calibration is declared, not inferred: the honest way to measure the noise
// floor is to point --base and --head at two COPIES of one dist, which
// exercises the real two-server path but has a true delta of exactly zero.
// Inferring it from path equality would miss that setup.
const CALIBRATION = args.includes("--calibrate");
if (CALIBRATION && !BASE_DIR) {
  usage(
    "--calibrate needs both --base and --head (point them at two copies of one dist)."
  );
}

const contentTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json"],
  [".wasm", "application/wasm"],
]);

// One server per dist dir. COOP/COEP are load-bearing twice over: the MT
// bundle needs SharedArrayBuffer, and a page that is not cross-origin isolated
// also gets a coarsened performance.now(), which would blunt the measurement.
const startServer = async (distDir) => {
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(
          "<!doctype html><meta charset=utf-8><title>proving bench</title>"
        );
        return;
      }

      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(distDir, relativePath);
      if (!filePath.startsWith(`${distDir}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        response.writeHead(404).end();
        return;
      }

      response.setHeader(
        "Content-Type",
        contentTypes.get(path.extname(filePath)) ?? "application/octet-stream"
      );
      // `pipe` does not forward source errors and the headers are already
      // sent, so a mid-read failure can only be surfaced by tearing the
      // response down — otherwise the browser stalls on the asset forever.
      createReadStream(filePath)
        .on("error", (error) => {
          console.error(`[server] read failed for ${filePath}: ${error}`);
          response.destroy(error);
        })
        .pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve, reject) => {
    const onListenError = (error) => reject(error);
    server.once("error", onListenError);
    server.listen(0, "127.0.0.1", () => {
      // Leaving the startup listener attached would let the first
      // post-startup error settle an already-resolved promise and vanish.
      server.off("error", onListenError);
      server.on("error", (error) => console.error(`[server] ${error}`));
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(`Failed to resolve bench server address for ${distDir}`);
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
};

// Runs inside page.evaluate once per page, in a fresh browser context (hence a
// fresh wasm instance and a cold rayon pool). Leaves the client and the
// executed TransactionResult on `window` so `proveOnceInPage` below can time
// individual proves against them: the two sides are driven alternately, one
// prove at a time, which is what cancels drift.
const setupInPage = async ({ threads: wantThreads }) => {
  const MOCK_DB = "mock_client_db";
  const seed = (fill) =>
    Uint8Array.from({ length: 32 }, (_, i) => (fill + i * 7) & 0xff);
  const CLIENT_SEED = seed(0x11);
  const WALLET_SEED = seed(0x53);

  const deleteMockDb = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        const request = indexedDB.deleteDatabase(MOCK_DB);
        request.onsuccess = finish;
        request.onerror = finish;
        request.onblocked = finish;
      } catch {
        finish();
      }
      setTimeout(finish, 3000);
    });

  // eager.js awaits wasm init at top level, then re-exports the whole index
  // surface, which itself re-exports every wasm-bindgen binding.
  const sdk = await import("/eager.js");

  if (!globalThis.crossOriginIsolated) {
    throw new Error(
      "page is not crossOriginIsolated — the MT bundle cannot start a rayon pool"
    );
  }
  if (typeof sdk.initThreadPool !== "function") {
    throw new Error("initThreadPool missing — this is not the mt build");
  }
  if (typeof sdk.rayonThreadCount !== "function") {
    throw new Error(
      "rayonThreadCount missing — build lacks the `testing` feature"
    );
  }

  // initThreadPool must configure the SAME wasm instance the client proves on.
  // Assert that rather than assume it.
  const wasm = await sdk.getWasmOrThrow();
  if (wasm.rayonThreadCount !== sdk.rayonThreadCount) {
    throw new Error(
      "sdk namespace and client wasm instance differ — initThreadPool would target the wrong instance"
    );
  }

  // Hide `Worker` during construction so the client takes its documented
  // no-worker branch. Constructing normally and terminating afterwards (the
  // recipe the test suite uses) would, on MT, first spawn a second wasm
  // instance that calls initThreadPool(navigator.hardwareConcurrency) — whose
  // rayon sub-workers outlive terminate() and contend with ours.
  const RealWorker = globalThis.Worker;
  let client;
  await deleteMockDb();
  try {
    globalThis.Worker = undefined;
    client = await sdk.MockWasmWebClient.createClient(
      null,
      null,
      CLIENT_SEED,
      undefined
    );
  } catch {
    globalThis.Worker = RealWorker;
    await deleteMockDb();
    client = await sdk.MockWasmWebClient.createClient(
      null,
      null,
      CLIENT_SEED,
      undefined
    );
  } finally {
    globalThis.Worker = RealWorker;
  }
  if (client.worker) {
    client.worker.terminate();
    client.worker = null;
  }

  // Needs the real `Worker` back, which the finally above restored.
  await sdk.initThreadPool(wantThreads);
  const rayonThreads = sdk.rayonThreadCount();
  if (rayonThreads !== wantThreads) {
    throw new Error(
      `rayonThreadCount() === ${rayonThreads}, expected ${wantThreads}`
    );
  }

  // The JS API exports a string shim named AuthScheme that shadows the wasm
  // enum, so the enum has to come off the wasm namespace.
  const AuthScheme = wasm.AuthScheme;
  if (!AuthScheme || AuthScheme.AuthEcdsaK256Keccak === undefined) {
    throw new Error("wasm AuthScheme enum unavailable");
  }

  await client.syncState();

  const wallet = await client.newWallet(
    sdk.AccountStorageMode.private(),
    AuthScheme.AuthEcdsaK256Keccak,
    WALLET_SEED
  );
  const faucet = await client.newFaucet(
    sdk.AccountStorageMode.private(),
    false,
    "BNCH",
    "BNCH",
    8,
    BigInt(10000000),
    AuthScheme.AuthRpoFalcon512
  );

  const walletId = wallet.id();
  const faucetId = faucet.id();

  // Untimed setup. This submit proves via the mock's dummy-proof shortcut (no
  // explicit prover), so it costs nothing — we only want the note it produces.
  const mintRequest = await client.newMintTransactionRequest(
    walletId,
    faucetId,
    sdk.NoteType.Public,
    BigInt(1000)
  );
  const mintTxId = await client.submitNewTransaction(faucetId, mintRequest);

  // Ordered and both required: proveBlock commits the mock block containing
  // the mint, syncState pulls that block and its note into the local store.
  await client.proveBlock();
  await client.syncState();

  const [mintRecord] = await client.getTransactions(
    sdk.TransactionFilter.ids([mintTxId])
  );
  if (!mintRecord) {
    throw new Error(
      "mint transaction record not found after proveBlock+syncState"
    );
  }
  const noteId = mintRecord.outputNotes().notes()[0].id().toString();

  const noteRecord = await client.getInputNote(noteId);
  if (!noteRecord) throw new Error(`minted note ${noteId} not in store`);
  const note = noteRecord.toNote();

  // Execute once, untimed: proving is the subject, and reusing one
  // TransactionResult removes all execution variance between proves.
  const consumeRequest = client.newConsumeTransactionRequest([note]);
  const txResult = await client.executeTransaction(walletId, consumeRequest);
  if (!txResult) throw new Error("executeTransaction returned nothing");

  globalThis.__midenBench = { sdk, client, txResult };
  return { rayonThreads };
};

// Times exactly ONE prove against the state `setupInPage` left on `window`.
// Kept separate so the driver can alternate base and head at ~1.5s granularity
// instead of running each side's whole batch back to back.
const proveOnceInPage = async () => {
  const state = globalThis.__midenBench;
  if (!state)
    throw new Error(
      "bench state missing — setupInPage did not run on this page"
    );
  const { sdk, client, txResult } = state;
  // wasm-bindgen takes the prover BY VALUE, so a reused handle throws
  // "null pointer passed to rust". Fresh prover every call.
  const prover = sdk.TransactionProver.newLocalProver();
  const t0 = performance.now();
  const proven = await client.proveTransaction(txResult, prover);
  const elapsed = performance.now() - t0;
  if (!proven) throw new Error("proveTransaction returned nothing");
  return elapsed;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2
    ? s[s.length >> 1]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const fmt = (ms) => (ms === null ? "n/a" : `${ms.toFixed(0)}ms`);

// Opens a page, runs setup on it, and returns handles the driver can drive
// one prove at a time. The caller owns closing the context.
const openSide = async (browser, url, label, repIndex) => {
  const context = await browser.newContext();
  const pageErrors = [];
  try {
    const page = await context.newPage();
    // An uncaught page error means this iteration's timings are unexplained,
    // so fail rather than fold suspect numbers into the results.
    page.on("pageerror", (error) => {
      console.error(`[pageerror] ${label} rep ${repIndex}: ${error}`);
      pageErrors.push(error);
    });
    await page.goto(url);
    const { rayonThreads } = await page.evaluate(setupInPage, { threads });
    if (pageErrors.length) {
      throw new Error(
        `${label} rep ${repIndex} raised ${pageErrors.length} page error(s) during setup; first: ${pageErrors[0]}`
      );
    }
    return {
      label,
      rayonThreads,
      prove: async () => {
        const ms = await page.evaluate(proveOnceInPage);
        if (pageErrors.length) {
          throw new Error(
            `${label} rep ${repIndex} raised a page error while proving; first: ${pageErrors[0]}`
          );
        }
        return ms;
      },
      // Report rather than throw: a failing close would replace whatever error
      // the iteration was already unwinding with.
      close: () =>
        context
          .close()
          .catch((error) => console.error(`[teardown] context: ${error}`)),
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
};

const servers = [];
let browser;
// Grouped per rep, not flattened: the comment prints them per rep, and a
// whole rep drifting is a different story from one prove drifting.
const samples = { base: [], head: [] };
let observedThreads = null;

try {
  const headServer = await startServer(HEAD_DIR);
  servers.push(headServer);
  const baseServer = BASE_DIR ? await startServer(BASE_DIR) : null;
  if (baseServer) servers.push(baseServer);

  browser = await chromium.launch({ headless: true });

  // Both sides are set up first, then driven ONE PROVE AT A TIME, alternating.
  // Running each side's whole batch back to back lets thermal ramp and
  // noisy-neighbour drift land as a fake delta; alternating at ~1.5s
  // granularity cancels it.
  //
  // The order also flips every prove (ABBA), and the rep's starting side flips
  // too. Without that, one side always runs second within a pair and pays a
  // consistent penalty — measured on this workload as a systematic +1.19%
  // against the second side across 6 calibration runs, which is a bias, not
  // noise, and no number of repetitions removes it.
  // One extra, discarded repetition up front. The first rep of a process pays
  // OS-level warm-up (page cache, Chromium's own start-up, CPU governor ramp)
  // that no later rep pays; measured on this workload it was the difference
  // between sd 3.14% and sd 2.20% across six calibration runs.
  const totalReps = reps + 1;
  for (let rep = 0; rep < totalReps; rep++) {
    const isWarmup = rep === 0;
    const sides = [];
    try {
      if (baseServer) {
        sides.push(await openSide(browser, baseServer.url, "base", rep));
      }
      sides.push(await openSide(browser, headServer.url, "head", rep));
      observedThreads = sides[sides.length - 1].rayonThreads;

      const perSide = new Map(sides.map((side) => [side.label, []]));
      for (let i = 0; i < proves; i++) {
        // ABBA: even proves run in order, odd proves reversed. Combined with
        // the rep-level flip below, each side spends half its proves first.
        const flip = (i + rep) % 2 === 1;
        const order = flip ? [...sides].reverse() : sides;
        for (const side of order) {
          perSide.get(side.label).push(await side.prove());
        }
      }

      for (const side of sides) {
        const all = perSide.get(side.label);
        // Discard prove #0 of every page too: it pays JIT, allocator growth
        // and the precompile preprocessed-table fill, none of which a warm
        // client pays.
        const warm = all.slice(1);
        if (!isWarmup) samples[side.label].push(warm);
        const tag = isWarmup ? "warmup" : `rep ${rep - 1}`;
        console.log(
          `${side.label} ${tag}: ${all.map(fmt).join("  ")}` +
            (isWarmup
              ? "  (discarded)"
              : `  (warm: ${warm.map(fmt).join(" ")})`)
        );
      }
    } finally {
      await Promise.allSettled(sides.map((side) => side.close()));
    }
  }
} finally {
  // Settle every teardown independently: a failing browser close must not skip
  // the server closes, and none of them may replace the benchmark's own error.
  const teardown = await Promise.allSettled([
    browser?.close(),
    ...servers.map(
      ({ server }) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          // `close` only stops accepting; without this it waits out the
          // keep-alive timeout on any socket Chromium left open.
          server.closeAllConnections();
        })
    ),
  ]);
  for (const outcome of teardown) {
    if (outcome.status === "rejected") {
      console.error(`[teardown] ${outcome.reason}`);
    }
  }
}

// The headline statistic is a TWO-LEVEL estimator, and both levels earn their
// place. Measured across six calibration runs of identical binaries:
//
//   median over all samples      sd 5.39%
//   min over all samples         sd 2.96%  (worst run 5.88%)
//   mean of per-rep minima       sd 1.79%  (worst run 2.71%)   <- this one
//
// Within one rep every prove is bit-identical work, so interference is the only
// thing that varies and it only ever ADDS time: the rep's MINIMUM is the clean
// compute cost for that rep. Across reps the faucet differs (it is not seedable
// here), which changes the note commitment, the Fiat-Shamir transcript and
// hence the proof-of-work grind length — a heavy-tailed lottery that a global
// minimum would just pick the luckiest draw from. Averaging the per-rep minima
// keeps the interference filtering and averages the grind away.
//
// `min` / `median` / `max` over all samples are retained as a spread check.
const mean = (xs) => xs.reduce((total, x) => total + x, 0) / xs.length;

const summarize = (groups) => {
  const usable = groups.filter((group) => group.length > 0);
  const flat = usable.flat();
  if (!flat.length) return null;
  const perRepMin = usable.map((group) => Math.min(...group));
  return {
    // The reported figure. `statistic` names it so the renderer and the
    // comment can never drift from what was actually computed.
    statistic: "mean-of-per-rep-minima",
    value: mean(perRepMin),
    perRepMin: perRepMin.map((x) => Number(x.toFixed(3))),
    min: Math.min(...flat),
    median: median(flat),
    max: Math.max(...flat),
    samples: usable.map((group) => group.map((x) => Number(x.toFixed(3)))),
  };
};

const results = {
  schemaVersion: 1,
  status: BASE_DIR ? "ok" : "head-only",
  calibration: CALIBRATION,
  // Named so the comment can say where the numbers came from; a threshold
  // calibrated on one runner class means nothing on another.
  runner: process.env.BENCH_RUNNER || "local",
  variant: "mt",
  profile: "release",
  threads: observedThreads ?? threads,
  reps,
  provesPerRep: proves,
  // 5% is 3 sigma of the estimator above as measured on a loaded developer
  // laptop (sd 1.79% over six calibration runs of identical binaries). It is
  // still PROVISIONAL: the number that matters is the one measured on the CI
  // runner, which is quieter and will almost certainly be tighter. See
  // docs/benchmarks/calibration.md.
  thresholdPct: 5,
  thresholdProvisional: true,
  benchmarks: [
    {
      name: "prove / consume / ecdsa-k256-keccak",
      unit: "ms",
      lowerIsBetter: true,
      base: summarize(samples.base),
      head: summarize(samples.head),
    },
  ],
};

console.log(`\nhead: ${HEAD_DIR}`);
if (BASE_DIR)
  console.log(`base: ${BASE_DIR}${CALIBRATION ? "  (calibration run)" : ""}`);
console.log(
  `threads=${results.threads} reps=${reps} proves/rep=${proves} warm samples/side=${samples.head.flat().length}\n`
);
for (const benchmark of results.benchmarks) {
  const baseValue = benchmark.base?.value ?? null;
  const headValue = benchmark.head?.value ?? null;
  const delta =
    baseValue !== null && headValue !== null && baseValue !== 0
      ? `${(((headValue - baseValue) / baseValue) * 100).toFixed(2)}%`
      : "n/a";
  console.log(
    `${benchmark.name}: base ${fmt(baseValue)}  head ${fmt(headValue)}  delta ${delta}  ` +
      `(spread: base ${fmt(benchmark.base?.min ?? null)}-${fmt(benchmark.base?.max ?? null)}, ` +
      `head ${fmt(benchmark.head?.min ?? null)}-${fmt(benchmark.head?.max ?? null)})`
  );
}

if (outPath) {
  const resolved = path.resolve(outPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${resolved}`);
} else {
  console.log(`\nJSON: ${JSON.stringify(results)}`);
}
