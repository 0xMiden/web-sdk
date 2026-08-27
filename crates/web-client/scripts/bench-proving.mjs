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
//     documented no-worker branch. (Both sides' pages do each hold a rayon pool
//     open for the length of a rep, but only one side proves at a time and idle
//     workers park, so the cost is symmetric and cancels in the interleave.)
//   - The faucet is not seedable on this branch (generate_faucet uses
//     StdRng::from_os_rng), so its id — and hence the note commitment, the
//     nullifier, the Fiat-Shamir transcript and the proof-of-work grind length
//     — is fresh per setup. Base and head are separate pages against separate
//     dists, so each runs its OWN setup and draws its own grind: the comparison
//     is NOT paired on the grind. Averaging per-rep minima over several reps is
//     what shrinks that difference; it does not cancel it. Removing it outright
//     needs a seedable faucet — see docs/benchmarks/calibration.md.

import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { opensBaseFirst, orderBalance, proveOrder } from "./bench-order.mjs";

const USAGE = [
  "  node scripts/bench-proving.mjs --head <dist-mt-dir> [--base <dist-mt-dir>]",
  "       [--threads N] [--reps N] [--proves M] [--out results.json]",
  "       [--calibrate] [--budget-minutes N]",
  "",
  "  --calibrate  Point --base at the same dist as --head to measure the noise",
  "               floor. Requires --base, and marks the run as calibration so the",
  "               comment renderer labels the result as a noise measurement.",
  "",
  "  --budget-minutes  How long the caller will let this run before killing it",
  "               (CI passes the step's timeout-minutes). Each in-page deadline is",
  "               clamped to what is left of it, so a hang late in the run still",
  "               names what wedged instead of dying to the runner's own timeout.",
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
  "--budget-minutes",
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
  // A repeated flag is a misconfiguration, not a preference for one of the two.
  // `indexOf` silently took the first, so `--reps 6 --reps 999` ran six and
  // reported six — the same class of quiet wrong answer the unknown-flag check
  // above exists to prevent.
  if (args.indexOf(name, i + 1) !== -1) {
    usage(`${name} was given more than once.`);
  }
  const value = args[i + 1];
  // Catches `--reps` at the end of argv and `--reps --out`, both of which
  // would otherwise parse to NaN and silently run zero iterations.
  if (value === undefined || value.startsWith("--")) {
    usage(`${name} requires a value.`);
  }
  return value;
};

// Mirrors the ceilings .github/scripts/render-bench-comment.mjs enforces on the
// same fields. Without them a run past a cap completes the whole 90-minute job
// and writes a results.json the renderer then refuses on its quiet path — no
// comment, no error, nothing pointing at the flag that caused it. Failing in the
// first two seconds instead is the whole difference.
const MAX_COUNT = 1000;

const count = (name, fallback) => {
  const raw = flag(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    usage(`${name} must be a positive integer, got "${raw}".`);
  }
  if (value > MAX_COUNT) {
    usage(
      `${name} must be at most ${MAX_COUNT}, got ${value}: the comment renderer ` +
        `refuses anything larger, so the run would produce no report.`
    );
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
// Even by default, and bench.yml matches it on both triggers. The ABBA order
// flip below balances over ALL proves, but prove #0 of each page is discarded,
// and `proves - 1` is odd — so the retained proves only come out even-handed
// across an even number of reps. See the warning after the driver loop.
const reps = count("--reps", "6");
// Extra proves are the cheap way to buy samples: setup (mint + block + sync)
// dominates a rep's cost and is not measured, while each extra prove is one
// more chance for `min` to catch an uncontended run.
const proves = count("--proves", "4");
const outPath = flag("--out", null);

const budgetMinutesRaw = flag("--budget-minutes", null);
// Not `count()`: that caps at MAX_COUNT to mirror the renderer's sample limits,
// which has nothing to do with a wall-clock budget.
if (budgetMinutesRaw !== null) {
  const value = Number(budgetMinutesRaw);
  if (!Number.isFinite(value) || value <= 0) {
    usage(
      `--budget-minutes must be a positive number, got "${budgetMinutesRaw}".`
    );
  }
}
const BUDGET_MS =
  budgetMinutesRaw === null ? null : Number(budgetMinutesRaw) * 60 * 1000;

if (proves < 2) {
  usage(
    "--proves must be at least 2: the first prove of each page is discarded as cold."
  );
}

// The per-flag ceilings above are not sufficient: the renderer's cap is on the
// TOTAL number of retained sample values in the artifact, across both sides and
// every benchmark. `--reps 1000 --proves 1000` clears both flag checks and then
// emits ~2M values against a 200k cap, which is a full job for a report that is
// refused. The retained count is reps × (proves-1) per side, two sides, times
// the number of benchmarks emitted below. It is a MULTIPLIER, not a divisor:
// keep it equal to the length of the `benchmarks:` array further down, or the
// check silently stops being conservative.
const MAX_SAMPLE_VALUES = 200000;
const BENCHMARK_COUNT = 1;
const plannedSamples = reps * (proves - 1) * 2 * BENCHMARK_COUNT;
if (plannedSamples > MAX_SAMPLE_VALUES) {
  usage(
    `reps × (proves-1) × 2 sides = ${plannedSamples} retained samples exceeds the ` +
      `${MAX_SAMPLE_VALUES} the comment renderer accepts, so the run would produce ` +
      `no report. Lower --reps or --proves.`
  );
}

// Not fatal — a deliberately short run is a legitimate thing to ask for — but
// silence here would hand back a number carrying a known directional bias.
// No figure is attached to the imbalance on purpose. The +1.19% second-position
// penalty is per prove, but the reported statistic is a mean of per-rep MINIMA,
// and a minimum is not linear in a per-prove penalty: if a rep's fastest prove
// ran first on both sides the penalty cancels outright, and if it ran second on
// one side it lands in full. Scaling 1.19% by the retained prove count would be
// precision this design cannot support.
// COUNTED from the same module the driver orders by, not restated as a parity
// formula. The formula version asserted the design instead of the code, and when
// the code stopped matching the design it went on reporting the calibrated
// default as balanced.
const balance = orderBalance({ reps, proves });

if (!balance.provesBalanced) {
  console.warn(
    `[warn] the retained PROVES do not split evenly between base and head: base ` +
      `goes first in ${balance.proveBaseFirst} of ${balance.proveTotal}. One side ` +
      `runs second once more than the other, and second position carries a ` +
      `measured penalty. Use an even --reps, or an odd --proves.`
  );
}
if (!balance.setupBalanced) {
  console.warn(
    `[warn] the SETUP order does not split evenly: base is opened first in ` +
      `${balance.setupBaseFirst} of ${balance.setupTotal} retained repetitions, so ` +
      `one side's mint/proveBlock/syncState runs alongside a live page one time ` +
      `more than the other's. Setup is not timed, but it decides what the machine ` +
      `looks like when the timed proves start. Use an even --reps.`
  );
}
if (balance.provesBalanced && !balance.perRepBalanced) {
  // Aggregate balance is not per-repetition balance, and a per-repetition
  // statistic gates the verdict: the sign test reads each repetition's delta
  // separately. With an odd retained count per repetition (the calibrated
  // default retains 3) each repetition leans by one prove, in alternating
  // directions. That costs power rather than manufacturing a verdict — a bias
  // that flips sign every repetition makes unanimous agreement harder — so it is
  // a note, not a warning about a wrong answer.
  console.log(
    `[note] each retained repetition leans by one prove (${balance.perRep
      .map((r) => `${r.baseFirst}/${r.total}`)
      .join(
        " "
      )} base-first), alternating direction, so it cancels across the ` +
      `run but not within a repetition. An odd --proves retains an even count ` +
      `per repetition and removes it.`
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
      // `pipeline` and not `pipe`: `pipe` neither forwards source errors nor
      // destroys the source when the destination dies, and Chromium aborts
      // in-flight asset requests every time a context closes mid-fetch — once
      // per side per repetition. That leaked an open file descriptor each time.
      // `pipeline` tears down both ends whichever one fails, which also covers
      // the mid-read failure that would otherwise stall the browser on an
      // asset whose headers were already sent.
      await pipeline(createReadStream(filePath), response).catch((error) => {
        // ERR_STREAM_PREMATURE_CLOSE is the client going away, which is normal
        // and not worth a line; anything else is a real read failure.
        if (error?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
          console.error(`[server] read failed for ${filePath}: ${error}`);
        }
      });
    } catch (error) {
      // Logged, because the file's own reasoning for failing early elsewhere is
      // that an unexplained 404 surfaces in the browser as "Failed to fetch
      // dynamically imported module" — the exact opaque symptom this catch was
      // producing for a decode error, an EACCES or a genuine bug.
      console.error(`[server] 404 for ${request.url}: ${error}`);
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
  // What follows checks that, plus the resulting pool SIZE. Neither is a check
  // that `proveTransaction` dispatches onto the pool: `rayonThreadCount` reports
  // how many threads exist, not whether the prove used them. A build that
  // silently proved single-threaded inside an 8-thread pool would still pass
  // here. The sdk exposes mtProbeAsync for that if this ever needs to be
  // airtight.
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
  } catch (error) {
    // Deliberately no retry with the real `Worker` restored. That fallback is
    // exactly the construction path the comment above rules out, so it would
    // buy a client at the cost of the rayon sub-workers this side is trying not
    // to have — and it would do so on ONE side, since the two sides are opened
    // independently. A base measured with contending sub-workers against a head
    // measured without them produces a difference that is entirely an artifact
    // of the fallback, reported as a performance result. Failing here costs a
    // benchmark run; succeeding quietly costs the number its credibility.
    throw new Error(
      `createClient failed on its no-worker branch: ${error?.message ?? error}. ` +
        `Not retrying with Worker restored — that would measure this side under ` +
        `rayon contention the other side does not have.`,
      { cause: error }
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

/**
 * `page.evaluate` under an explicit deadline.
 *
 * Playwright's `evaluate` takes no timeout and is not covered by
 * `setDefaultTimeout` — only navigation and locator calls are. So a prove that
 * wedges inside wasm hangs forever, and the only thing that eventually notices
 * is the job-level timeout, which kills the run without a diagnostic and after
 * burning the rest of the budget. A rayon deadlock in the prover is precisely
 * the change class this benchmark exists to catch, so the head build hanging is
 * an expected case rather than an exotic one.
 *
 * The race leaves the evaluate running — there is no way to cancel it — but the
 * context close in the caller's teardown takes the page down with it.
 */
const evaluateWithDeadline = async (page, fn, arg, { ms, what }) => {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(fn, arg),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what} did not finish within ${ms} ms — treating it as wedged rather than waiting out the job timeout`
              )
            ),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// Generous, because these bound a HANG, not a slow run: proving on a loaded
// 8-core runner is single-digit seconds, and setup mints, proves a block and
// syncs. Anything past these is not slow, it is stuck.
const SETUP_DEADLINE_MS = 10 * 60 * 1000;
const PROVE_DEADLINE_MS = 5 * 60 * 1000;

// The constants above are useless on their own late in a run. The step that runs
// this is capped (20 minutes in bench.yml), and a setup that wedges 12 minutes
// in would trip a 10-minute deadline at minute 22 — after the runner has already
// killed the job. That is exactly the outcome evaluateWithDeadline was added to
// prevent: dead with no diagnostic, having burned the rest of the budget.
//
// So each deadline is also clamped to what is left of the step's budget, minus a
// margin for the diagnostic to print and the teardown to run. --budget-ms comes
// from the workflow, which is the only place that knows the cap; without it the
// clamp is skipped and the constants stand alone, which is right for a local run
// with no cap at all.
const BUDGET_MARGIN_MS = 90 * 1000;
const startedAt = Date.now();

const deadlineFor = (ceiling) => {
  if (BUDGET_MS === null) return ceiling;
  const left = BUDGET_MS - (Date.now() - startedAt) - BUDGET_MARGIN_MS;
  // A floor of ten seconds rather than zero or a negative: past the budget the
  // next call should fail fast with a named diagnostic, not be handed a deadline
  // that has already expired (which would read as an instant, inexplicable
  // timeout) and not be handed an unbounded one either.
  return Math.max(10 * 1000, Math.min(ceiling, left));
};

// Opens a page, runs setup on it, and returns handles the driver can drive
// one prove at a time. The caller owns closing the context.
const openSide = async (browser, url, label, repIndex) => {
  const context = await browser.newContext();
  const pageErrors = [];
  // Set synchronously before any close is requested, so the worker-close
  // handler below can tell a teardown from a mid-run death. Playwright's own
  // `page.isClosed()` cannot: it flips after the workers have already gone.
  let closing = false;
  try {
    const page = await context.newPage();
    // An uncaught page error means this iteration's timings are unexplained,
    // so fail rather than fold suspect numbers into the results.
    page.on("pageerror", (error) => {
      console.error(`[pageerror] ${label} rep ${repIndex}: ${error}`);
      pageErrors.push(error);
    });
    // `pageerror` fires for the main frame only, and proving runs on a rayon
    // pool of web workers. A worker dying mid-run left no trace here while the
    // pool silently shrank, and a shrunken pool yields slower-but-plausible
    // timings that nothing downstream can distinguish from a real regression.
    //
    // Gated on our own `closing` latch and NOT on `page.isClosed()`: Playwright
    // delivers every worker's `close` before the page's own `close` that sets
    // that flag, so a healthy teardown reported one bogus worker death per
    // worker per side per repetition — 112 of them on the CI configuration.
    page.on("worker", (worker) => {
      worker.on("close", () => {
        if (closing) return;
        const error = new Error(
          `a web worker exited while ${label} rep ${repIndex} was still running, so the rayon pool may have shrunk mid-measurement`
        );
        console.error(`[worker] ${error.message}`);
        pageErrors.push(error);
      });
    });
    await page.goto(url);
    const { rayonThreads } = await evaluateWithDeadline(
      page,
      setupInPage,
      { threads },
      {
        ms: deadlineFor(SETUP_DEADLINE_MS),
        what: `${label} rep ${repIndex} setup`,
      }
    );
    if (pageErrors.length) {
      throw new Error(
        `${label} rep ${repIndex} raised ${pageErrors.length} page error(s) during setup; first: ${pageErrors[0]}`
      );
    }
    return {
      label,
      rayonThreads,
      // Read once more after the prove loop. Playwright delivers worker `close`
      // over CDP asynchronously, so a worker that dies during a repetition's
      // LAST prove can be recorded after that prove's own check has returned —
      // and `close()` then latches `closing`, suppressing everything after. The
      // samples for that repetition were kept and the run reported success.
      pageErrors,
      prove: async () => {
        const ms = await evaluateWithDeadline(
          page,
          proveOnceInPage,
          undefined,
          {
            ms: deadlineFor(PROVE_DEADLINE_MS),
            what: `${label} rep ${repIndex} prove`,
          }
        );
        if (pageErrors.length) {
          throw new Error(
            `${label} rep ${repIndex} raised a page error while proving; first: ${pageErrors[0]}`
          );
        }
        return ms;
      },
      // Report rather than throw: a failing close would replace whatever error
      // the iteration was already unwinding with. Recorded, though, because a
      // context that would not close leaves a live page — and its wasm rayon
      // pool — contending with every repetition that follows, which is the exact
      // interference the estimator assumes is absent. The caller checks the
      // record and stops rather than measuring against it.
      close: () => {
        closing = true;
        return context.close().catch((error) => {
          // Recorded, not printed, for the same reason the outer teardown does
          // not print: the end-of-run summary lists every entry with the reason
          // it matters, and logging here as well made a two-failure run read
          // like a four-failure one.
          teardownFailures.push(`${label} context: ${error}`);
        });
      },
    };
  } catch (error) {
    closing = true;
    // Recorded for the same reason the close() above records: setup can fail
    // with the context already wedged (goto timing out, the setup evaluate
    // throwing), and a context that will not close leaves a live page behind.
    // Swallowing it silently left a leaked browser process with no explanation
    // anywhere in the log.
    await context.close().catch((closeError) => {
      console.error(
        `[teardown] ${label} context (during setup): ${closeError}`
      );
      teardownFailures.push(`${label} context (during setup): ${closeError}`);
    });
    throw error;
  }
};

const servers = [];
let browser;
// Set when the driver loop throws, so the teardown summary can run before the
// error propagates. Without it, the failures the `finally` records were pushed
// into an array nothing read: the summary sits after this block, and unwinding
// skips it.
let benchError = null;

/**
 * The single surface for teardown failures. Every recording site pushes and
 * stays quiet so this can list them once, with the reason they matter.
 *
 * Called on both exits — the clean one and the unwinding one — because a browser
 * or server that would not close is worse news than whatever error stopped the
 * run: on a self-hosted runner it outlives the job and lands in the NEXT run's
 * numbers as exactly the interference this script exists to exclude.
 */
const reportTeardownFailures = ({ resultsWritten }) => {
  if (!teardownFailures.length) return;
  console.error(
    `\n${teardownFailures.length} teardown ${teardownFailures.length === 1 ? "failure" : "failures"} — ` +
      (resultsWritten
        ? `the results above were written, but resources were left open:\n`
        : `the run did not finish, and resources were left open:\n`) +
      teardownFailures.map((failure) => `  - ${failure}`).join("\n")
  );
  process.exitCode = 1;
};
// Every teardown that rejected. A benchmark whose resources would not release is
// not a benchmark that succeeded: mid-run it means later repetitions were
// measured against a page that should have been gone, and at the end it means
// this process is about to report a clean pass while leaving something running.
const teardownFailures = [];
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
      // Setup is alternated too, not just the proves. Every other part of this
      // loop is ABBA'd, and this was the one place with a fixed order: base
      // always opened first, so base's mint/execute/sync ran on an idle machine
      // while head's always ran alongside base's live page and its rayon pool.
      // Prove #0 of each page is discarded, which absorbs some of that, but a
      // fixed asymmetry is the one kind of error repetitions cannot average out
      // — the same reason the proves are alternated at all.
      const openBaseFirst = opensBaseFirst(rep);
      const opens = [
        ...(baseServer
          ? [{ url: baseServer.url, label: "base", first: openBaseFirst }]
          : []),
        { url: headServer.url, label: "head", first: !openBaseFirst },
      ].sort((a, b) => Number(b.first) - Number(a.first));
      for (const { url, label } of opens) {
        sides.push(await openSide(browser, url, label, rep));
      }
      // By label, not by position: the open order alternates, so "last opened"
      // is no longer "head".
      observedThreads = sides.find(
        (side) => side.label === "head"
      ).rayonThreads;
      // The prove order below indexes `sides`, so it has to be a stable
      // [base, head] regardless of which was opened first, or the ABBA flip
      // below would alternate twice and cancel itself.
      sides.sort((a, b) =>
        a.label === "base" ? -1 : b.label === "base" ? 1 : 0
      );

      const perSide = new Map(sides.map((side) => [side.label, []]));
      for (let i = 0; i < proves; i++) {
        // ABBA: even proves run in the open order, odd proves reversed. Keyed on
        // `i` ALONE, deliberately.
        //
        // This was `(i + rep) % 2`, which silently cancelled the whole design:
        // `sides` is already ordered by `rep % 2` above, so adding `rep` to the
        // prove-level parity made both alternations key on the same bit and the
        // effective order collapsed to a function of `i` only. Base went first
        // iff `i` was even, in EVERY repetition. At the calibrated default
        // (--reps 6 --proves 4, retaining proves 1..3) that is base first in one
        // retained prove of three, the same way every repetition — a fixed
        // positional asymmetry, which is the one kind of error repetitions
        // cannot average out, and precisely what the interleave exists to
        // remove. At --proves 2 base never went first at all.
        //
        // Keyed on `i`, the two alternations are independent again: the open
        // order flips per repetition, the prove order flips per prove, and the
        // retained proves balance whenever `reps × (proves - 1)` is even — which
        // is exactly the condition the guard near the top of this file warns
        // about, and was already the intended contract.
        const order = proveOrder(sides, i);
        for (const side of order) {
          perSide.get(side.label).push(await side.prove());
        }
      }

      // Before anything is retained: a worker death recorded late — after the
      // last prove's own check — otherwise went into `pageErrors` and was never
      // read, so a repetition measured on a shrunken rayon pool was kept.
      for (const side of sides) {
        if (side.pageErrors.length) {
          throw new Error(
            `${side.label} ${isWarmup ? "warmup" : `rep ${rep}`} raised ` +
              `${side.pageErrors.length} page error(s) during its proves; first: ` +
              `${side.pageErrors[0]}`
          );
        }
      }

      for (const side of sides) {
        const all = perSide.get(side.label);
        // Discard prove #0 of every page too: it pays JIT, allocator growth
        // and the precompile preprocessed-table fill, none of which a warm
        // client pays.
        const warm = all.slice(1);
        if (!isWarmup) samples[side.label].push(warm);
        // 1-based, matching how the comment renderer labels the same rows.
        const tag = isWarmup ? "warmup" : `rep ${rep}`;
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
    // Between repetitions, not after all of them — hence the bound. The reason
    // to stop is that the NEXT repetition would be measured alongside whatever
    // failed to close; after the last one there is no next repetition, the
    // samples are complete, and throwing here would discard a full run over a
    // browser that was about to be killed anyway. That case falls through to the
    // outer teardown, which keeps the results and exits nonzero.
    if (rep < totalReps - 1 && teardownFailures.length) {
      throw new Error(
        `a page context failed to close after ${isWarmup ? "the warmup" : `rep ${rep}`}, ` +
          `so the repetitions after it would be measured against a live page: ` +
          `${teardownFailures.join("; ")}`
      );
    }
  }
} catch (error) {
  // Captured rather than propagated from here: the `finally` below still has to
  // run and record the browser and server closes, and only once it has is the
  // teardown summary complete. Rethrown after that summary, at the bottom.
  benchError = error;
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
      // Recorded, not printed. The summary at the end of the script lists every
      // entry with the reason they matter; logging here as well made a two-
      // failure run read like a four-failure one.
      teardownFailures.push(String(outcome.reason));
    }
  }
}

if (benchError) {
  reportTeardownFailures({ resultsWritten: false });
  throw benchError;
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
// hence the proof-of-work grind length — a skewed lottery that a global
// minimum would just pick the luckiest draw from. Averaging the per-rep minima
// keeps the interference filtering and averages the grind away.
//
// `min` / `median` / `max` over all samples are retained as a spread check.
const mean = (xs) => xs.reduce((total, x) => total + x, 0) / xs.length;
// Reduced rather than `Math.min(...xs)`: the spread form throws a RangeError
// past ~125k arguments, and reaching that only after a run this expensive would
// be a bad way to find out.
const minOf = (xs) => xs.reduce((lo, x) => (x < lo ? x : lo), Infinity);
const maxOf = (xs) => xs.reduce((hi, x) => (x > hi ? x : hi), -Infinity);

// `samples` is the whole payload, and the summary alongside it is for a human
// reading this script's stdout or the raw artifact.
//
// The renderer does NOT read `value` / `min` / `median` / `max`: it recomputes
// all four from `samples`, because on the reporting side this file is
// fork-controlled input to a job holding a write token, and a summary that
// disagrees with its own samples would let the artifact author the verdict.
// Keep the two consistent anyway — they are read side by side during a
// calibration run — but nothing downstream depends on it.
const summarize = (groups) => {
  const usable = groups.filter((group) => group.length > 0);
  const flat = usable.flat();
  if (!flat.length) return null;
  const perRepMin = usable.map(minOf);
  return {
    // `statistic` names the figure so this script's own stdout and a human reading results.json
    // can never describe it differently.
    statistic: "mean-of-per-rep-minima",
    value: mean(perRepMin),
    perRepMin: perRepMin.map((x) => Number(x.toFixed(3))),
    min: minOf(flat),
    median: median(flat),
    max: maxOf(flat),
    samples: usable.map((group) => group.map((x) => Number(x.toFixed(3)))),
  };
};

const results = {
  // 2, not 1: `reps` / `provesPerRep` became the RETAINED counts, and the
  // renderer now recomputes the statistics from `samples` instead of reading
  // them. The reporting job always runs the DEFAULT branch's renderer against
  // an artifact built by the PR head's producer, so the two halves are
  // routinely at different revisions — a version that does not move when the
  // meaning of a field moves is decoration.
  // Contract for v2, enforced in .github/scripts/render-bench-comment.mjs:
  // `samples` is mandatory and holds exactly `reps` groups of `provesPerRep`
  // finite numbers. `teardownFailures` below is additive and optional — the
  // renderer treats a missing or malformed field as empty — so it needs no bump.
  schemaVersion: 2,
  status: BASE_DIR ? "ok" : "head-only",
  calibration: CALIBRATION,
  // Named so the comment can say where the numbers came from; a threshold
  // calibrated on one runner class means nothing on another.
  runner: process.env.BENCH_RUNNER || "local",
  variant: "mt",
  profile: "release",
  threads: observedThreads ?? threads,
  // RETAINED counts, which is what the reported statistic was computed over.
  // The executed counts are alongside so the artifact still records the config:
  // a warm-up rep and the first prove of every page run and are thrown away.
  reps,
  provesPerRep: proves - 1,
  repsExecuted: reps + 1,
  provesExecutedPerRep: proves,
  // No `thresholdPct` / `thresholdProvisional` / `lowerIsBetter` here: those
  // decide the verdict, and .github/scripts/render-bench-comment.mjs renders
  // this file on the side that holds a write token, from an artifact a fork
  // controls. They are pinned there instead. Changing the noise floor means
  // editing THRESHOLD_PCT in that file — see docs/benchmarks/calibration.md.
  // Carried into the artifact so the report can say so. `process.exitCode = 1`
  // reddens the bench job, but `Record PR context` and `Upload benchmark report`
  // are `if: always()` and the samples are complete — so without this the
  // reporter posted an ordinary-looking comment and a `neutral` check run beside
  // a red bench job, and nothing connected the two. A reader had no way to know
  // the numbers came from a run that left a page or a browser alive.
  //
  // Filled in twice: once here for the mid-run failures, which are the ones that
  // can contaminate the numbers above, and again after the final teardown for
  // the end-of-run ones. See the rewrite below.
  teardownFailures: [...teardownFailures],
  benchmarks: [
    {
      name: "prove / consume / ecdsa-k256-keccak",
      unit: "ms",
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

const emitResults = async () => {
  if (!outPath) {
    console.log(`\nJSON: ${JSON.stringify(results)}`);
    return;
  }
  const resolved = path.resolve(outPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  return resolved;
};

const writtenTo = await emitResults();
if (writtenTo) console.log(`\nwrote ${writtenTo}`);
const teardownFailuresAtWrite = teardownFailures.length;

// The measurements are complete and written, so they are worth keeping — but a
// browser or server that would not close means this process is about to exit 0
// with something still holding a port or a pid. On a self-hosted runner that
// outlives the job and lands in the NEXT run's numbers as interference, which is
// the failure this whole script is built to avoid. Report the results, then say
// plainly that the run is not clean.
// The browser and the servers close AFTER the results are written, so failures
// there are not in the file yet. Rewrite it rather than leave the artifact
// claiming a clean run — the reporter reads only the file, never this log.
if (teardownFailures.length > teardownFailuresAtWrite) {
  results.teardownFailures = [...teardownFailures];
  await emitResults().catch((error) => {
    console.error(
      `[teardown] could not record teardown failures in the results file: ${error}`
    );
  });
}

reportTeardownFailures({ resultsWritten: true });
