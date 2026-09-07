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

import {
  BUDGET_FLOOR_MS,
  BUDGET_MARGIN_MS,
  BudgetExhaustedError,
  createDeadlineFor,
  DeadlineExceededError,
  evaluateWithDeadline,
  formatMinutes,
  medianOf,
  PROVE_CEILING_MS,
  SETTLE_CEILING_MS,
  SETUP_CEILING_MS,
  withPlaywrightDeadline,
} from "./bench-budget.mjs";
import {
  balancedRetainedReps,
  opensBaseFirst,
  orderBalance,
  proveOrder,
} from "./bench-order.mjs";

/**
 * A page context that would not close mid-run.
 *
 * Its own class because it is a THIRD reason to stop short, and the two existing
 * ones do not describe it: the clock did not run out, and no in-page work
 * overran. The next repetition would have been measured alongside a page that is
 * still live, which is a reason to stop but not a reason to throw away the
 * repetitions already finished — those were measured before anything failed to
 * close. Carrying it as an early stop writes them out under a withheld verdict;
 * throwing, as this path used to, discarded a complete run over a browser that
 * was about to be killed anyway.
 */
class TeardownStopError extends Error {
  constructor(message) {
    super(message);
    this.name = "TeardownStopError";
  }
}

const USAGE = [
  "  node scripts/bench-proving.mjs --head <dist-mt-dir> [--base <dist-mt-dir>]",
  "       [--threads N] [--reps N] [--proves M] [--out results.json]",
  "       [--calibrate] [--budget-minutes N]",
  "",
  "  --calibrate  Point --base at the same dist as --head to measure the noise",
  "               floor. Requires --base. Labels stdout and results.json for a",
  "               human reader; the PR comment's calibration banner comes from",
  "               the workflow dispatch input, NOT from this flag, because the",
  "               renderer will not take that banner from the artifact.",
  "",
  "  --budget-minutes  How long the caller will let this run before killing it",
  "               (CI passes the step's timeout-minutes). Each in-page deadline is",
  "               clamped to what is left of it, so work that overruns late in the",
  "               run still names itself, and the repetitions already measured are",
  "               kept, instead of the runner killing the step with nothing to show.",
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
// same fields. Without them a run past a cap completes the whole multi-hour job
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
// across an even number of reps, which is why an odd count is refused below.
const reps = count("--reps", "6");
// Refused rather than warned about, because an odd count carries the exact defect
// a truncated run gives up a repetition to avoid. The setup order alternates by
// repetition, so an odd number runs base first once more than head — a fixed
// positional asymmetry, the one class of error repetitions cannot average out.
// A truncated run drops its tail for this; a clean `--reps 7` run used to keep it
// and, being above the verdict's repetition floor, publish a confident number
// carrying it, with nothing but a stderr line to say so. Same defect, so the same
// answer, and refusing is better than silently measuring six when seven were
// asked for.
if (reps % 2 !== 0) {
  usage(
    `--reps must be even (got ${reps}): the setup order alternates by repetition, ` +
      `so an odd count sets up base first once more often than head and biases ` +
      // `reps - 1` is only a suggestion when it is still a legal count: at
      // --reps 1 it is 0, which count() rejects as not a positive integer.
      `every repetition in the run. Use ${
        reps > 2 ? `${reps - 1} or ${reps + 1}` : `${reps + 1}`
      }.`
  );
}
// Extra proves are the cheap way to buy samples: setup (mint + block + sync)
// dominates a rep's cost and is not measured, while each extra prove is one
// more chance for `min` to catch an uncontended run.
// Mirrors `calibratedProvesPerRep` + 1 in .github/scripts/bench-profile.mjs:
// that field counts RETAINED proves, this flag counts ISSUED ones, and the first
// of every page is discarded. The two have to move together — the renderer
// blocks any run whose retained count does not match the profile — so this is
// one of the three places a change to that count has to land.
const CALIBRATED_PROVES = 4;
const proves = count("--proves", String(CALIBRATED_PROVES));
const outPath = flag("--out", null);

const budgetMinutesRaw = flag("--budget-minutes", null);
// Not `count()`: that caps at MAX_COUNT to mirror the renderer's sample limits,
// which has nothing to do with a wall-clock budget.
// A budget has to be large enough for the clamp to mean anything. Two accepted
// values made it a no-op in opposite directions: `0.001` gave a 60 ms budget
// against a 10 s floor, so every deadline was already past the budget the moment
// it was issued, and `1e308` overflowed the minutes-to-ms multiply to Infinity,
// which switched the clamp off entirely while looking like a valid number.
// BUDGET_MARGIN_MS and BUDGET_FLOOR_MS come from bench-budget.mjs. The floor is
// above a normal prove (single-digit seconds) on purpose: the point is to abort
// with a budget diagnostic rather than squeeze in one more attempt that a tight
// deadline would then misreport as a hang. It also has to stay at or above the
// settle ceiling, which is why it lives next to the work profiles and is asserted
// there rather than here.
//
// Working time on top of the two reserves. Without it the accepted minimum was
// the mathematical boundary — margin plus floor — where the budget is satisfied
// at t=0 and refused one millisecond later, so the smallest "valid" budget could
// not launch a browser, let alone measure anything. Three minutes is enough for a
// launch, a setup and a prove or two on the smallest useful configuration.
const BUDGET_WORKING_MIN_MS = 3 * 60 * 1000;
const MIN_BUDGET_MS =
  BUDGET_MARGIN_MS + BUDGET_FLOOR_MS + BUDGET_WORKING_MIN_MS;
let BUDGET_MS = null;
if (budgetMinutesRaw !== null) {
  const value = Number(budgetMinutesRaw);
  if (!Number.isFinite(value) || value <= 0) {
    usage(
      `--budget-minutes must be a positive number, got "${budgetMinutesRaw}".`
    );
  }
  const ms = value * 60 * 1000;
  if (!Number.isFinite(ms)) {
    usage(
      `--budget-minutes ${budgetMinutesRaw} overflows to Infinity in milliseconds; ` +
        `pass the step's real timeout-minutes.`
    );
  }
  if (ms < MIN_BUDGET_MS) {
    usage(
      `--budget-minutes must be at least ${formatMinutes(MIN_BUDGET_MS)} (got ` +
        `${budgetMinutesRaw}): ${BUDGET_MARGIN_MS / 1000}s is reserved for the ` +
        `diagnostic and teardown, up to ${BUDGET_FLOOR_MS / 1000}s is the least a step ` +
        `is granted before the run stops instead, and ` +
        `${BUDGET_WORKING_MIN_MS / 60000} minutes is the least that leaves room to ` +
        `launch a browser and measure anything.`
    );
  }
  BUDGET_MS = ms;
}

if (proves < 2) {
  usage(
    "--proves must be at least 2: the first prove of each page is discarded as cold."
  );
}

// The renderer's floor was calibrated against a mean of per-repetition minima
// over exactly three retained proves, and the spread of a minimum is not
// monotonic in the number of draws it is taken over, so the floor cannot be
// carried to a different count in either direction. The renderer gates on this
// (`calibratedProvesPerRep` in .github/scripts/bench-profile.mjs) and reports
// without ruling when it does not match. Say so here rather than at the end of a
// twenty-minute run.
if (proves !== CALIBRATED_PROVES) {
  console.log(
    `[warn] --proves ${proves} retains ${proves - 1} per repetition, but the ` +
      `regression floor is calibrated at ${CALIBRATED_PROVES - 1}. This run will ` +
      `report its numbers and the renderer will decline to rule on them. Use ` +
      `--proves ${CALIBRATED_PROVES} for a verdict.`
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
// One side or two: a head-only run (no --base) writes half as many samples, and
// charging it for a base it will not measure rejected configurations the renderer
// would have accepted.
const SIDES = BASE_DIR ? 2 : 1;
const plannedSamples = reps * (proves - 1) * SIDES * BENCHMARK_COUNT;
if (plannedSamples > MAX_SAMPLE_VALUES) {
  usage(
    `reps × (proves-1) × ${SIDES} side${SIDES === 1 ? "" : "s"} = ${plannedSamples} retained samples exceeds the ` +
      `${MAX_SAMPLE_VALUES} the comment renderer accepts, so the run would produce ` +
      `no report. Lower --reps or --proves.`
  );
}

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
// Only meaningful with two sides. `orderBalance` takes no side count and always
// simulates a base and a head, so a head-only run was asserting a base/head
// split for a base that never opens and printing a lean note about it — the
// first line a reader consults, describing an interleave that did not happen.
const balance = BASE_DIR ? orderBalance({ reps, proves }) : null;

// Assertions now, not warnings, and the change of severity is the point. Both of
// these were reachable only through an odd `--reps`, which is refused at parse
// time — so an imbalance here no longer means the operator asked for a lopsided
// run. It means `bench-order.mjs` and that check disagree, which is a bug in this
// file's own contract, and a bug that silently biases every number the run
// produces is not something to print and continue past.
//
// Kept rather than deleted for exactly that reason: they are the only thing
// checking that the even-`--reps` rule actually delivers the balance it claims.
if (balance && !balance.provesBalanced) {
  throw new Error(
    `the retained PROVES do not split evenly between base and head: base goes ` +
      `first in ${balance.proveBaseFirst} of ${balance.proveTotal}, with --reps ` +
      `${reps} --proves ${proves}. --reps is even, so this should be impossible: ` +
      `the interleave in bench-order.mjs and the even-reps rule have diverged`
  );
}
if (balance && !balance.setupBalanced) {
  throw new Error(
    `the SETUP order does not split evenly: base is opened first in ` +
      `${balance.setupBaseFirst} of ${balance.setupTotal} retained repetitions, ` +
      `with --reps ${reps}. --reps is even, so this should be impossible: the ` +
      `alternation in bench-order.mjs and the even-reps rule have diverged`
  );
}
if (balance && balance.provesBalanced && !balance.perRepBalanced) {
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
      `run but not within a repetition. An odd --proves would retain an even ` +
      `count and remove it, but the floor is calibrated at ${CALIBRATED_PROVES} ` +
      `proves and the renderer refuses to rule on any other count, so that trade ` +
      `is only available together with a recalibration.`
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

// Every setup's measured duration, for the budget report and for the artifact.
// Setup is untimed by the estimator — it is not a measurement of the SDK — but it
// is the dominant cost the step budget has to be sized against, and the number a
// reader needs to interpret a deadline overrun.
const setupDurations = [];

// The ceilings are useless on their own late in a run. The step that runs this is
// capped (BENCH_STEP_BUDGET_MINUTES in bench.yml), and a setup that wedges with
// less time left than its ten-minute ceiling would trip that deadline after the
// runner had already killed the step. That is exactly the outcome evaluateWithDeadline was added to
// prevent: dead with no diagnostic, having burned the rest of the budget.
//
// So each deadline is also clamped to what is left of the step's budget, minus a
// margin for the diagnostic to print and the teardown to run. --budget-minutes comes
// from the workflow, which is the only place that knows the cap; without it the
// clamp is skipped and the constants stand alone, which is right for a local run
// with no cap at all.
// Monotonic, and it must match the clock inside createDeadlineFor: the two are
// subtracted from each other. A wall clock here lets an NTP step grant a deadline
// past the step cap.
const startedAt = performance.now();

// Bound to this run's budget. The rule itself lives in bench-budget.mjs so it can
// be driven with a synthetic clock; this only supplies the numbers.
const deadlineFor = createDeadlineFor({
  budgetMs: BUDGET_MS,
  marginMs: BUDGET_MARGIN_MS,
  floorMs: BUDGET_FLOOR_MS,
  startedAt,
});

// A close that will not finish must not cost the run its numbers.
//
// Short on purpose: this is not bounding work, it is bounding a hang. A browser
// or a listening socket that has not closed in 30 seconds is not closing, and
// every second spent waiting is taken from the same step budget that still has
// to write results.json.
const CLOSE_DEADLINE_MS = 30 * 1000;

/**
 * The ceiling on Playwright's OWN calls — `newContext`, `newPage`, `goto`.
 *
 * Those three are the only per-repetition calls not wrapped by
 * `evaluateWithDeadline`, because they are Playwright's API rather than work
 * inside the page. Set explicitly rather than left to Playwright's 30s default
 * so the figure the artifact reports for such an overrun is the one that actually
 * applied; the driver converts a `TimeoutError` into a `DeadlineExceededError`
 * carrying this number.
 *
 * Generous against a `goto` of a local static server, and well under
 * SETUP_CEILING_MS so it cannot mask a setup that is merely slow.
 */
const PLAYWRIGHT_TIMEOUT_MS = 60 * 1000;

// The deadline the most recent Playwright call was actually granted. Only `goto`
// raises Playwright's own `TimeoutError` — the other two are raced by
// `withPlaywrightDeadline`, which reports its own figure — and the driver's
// conversion needs the granted number rather than the ceiling.
let lastPlaywrightDeadlineMs = PLAYWRIGHT_TIMEOUT_MS;

// Closes started somewhere other than the stage that waits for them.
//
// Both entries here used to be awaited, or not waited for at all, at their start
// site. Awaiting serialized them: the setup-failure close, the per-repetition
// side closes and the browser/server closes are three stages of 30s each, which
// is the whole 90s teardown margin, and results.json is written after all three.
// Not waiting at all lost the accounting: a late close that blows its deadline
// increments `abandonedCloses` whenever it happens, and the exit path reads that
// counter once — so a wedged close landing afterwards was neither reported nor
// escaped by the SIGKILL, and held the process open with all its work done.
//
// Registering here lets the start site return immediately while a later stage
// still waits, so the stages overlap and the accounting is complete before the
// artifact is built.
const pendingCloses = [];
const trackClose = (closing) => {
  pendingCloses.push(closing);
  return closing;
};
// Drained, not merely awaited: a close that settles here must not be waited on
// twice by the next stage.
const settlePendingCloses = () =>
  Promise.allSettled(pendingCloses.splice(0, pendingCloses.length));

// The `closeLate` seam `withPlaywrightDeadline` takes. A late winner is a context
// handed back by a call that already lost its deadline — the browser that just
// proved it was wedged — so its close is bounded like any other, recorded like
// any other, and registered so a stage waits for it.
const trackLateClose = (label, closing) =>
  trackClose(
    withCloseDeadline(label, closing).catch((error) => {
      teardownFailures.push(`${label}: ${error}`);
    })
  );

// Counts closes that blew their deadline, because abandoning one changes how
// this process has to exit. See the `abandonedCloses > 0` block at the very
// bottom of the file.
let abandonedCloses = 0;

const withCloseDeadline = (label, closing) => {
  if (!closing) return Promise.resolve();
  let timer;
  // `Promise.race` attaches no handler to the LOSER, so when the deadline wins
  // and the close later rejects — a dropped CDP connection, a server `close`
  // callback handed an error — that rejection is unhandled. Node 20 defaults to
  // `--unhandled-rejections=throw`, which would take the process down during
  // `emitResults()`: after the samples exist and before the file is durable,
  // which is the one window this whole teardown scheme exists to protect.
  const settled = Promise.resolve(closing).finally(() => clearTimeout(timer));
  settled.catch(() => {
    // Swallowed only for the losing branch. The racing branch below still sees
    // the rejection and records it as a teardown failure.
  });
  return Promise.race([
    // The rejection carries the label because the caller records `outcome.reason`
    // verbatim into the teardown list, and "timed out" with no subject would be
    // the least useful line in the report.
    settled,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        abandonedCloses += 1;
        reject(
          new Error(
            `${label} did not close within ${CLOSE_DEADLINE_MS / 1000}s; abandoning it so the results can still be written`
          )
        );
      }, CLOSE_DEADLINE_MS);
      // Deliberately NOT unref'd, for the case where the wedge is a listening
      // socket and nothing else is keeping the loop alive: an unref'd timer
      // would let node exit before the deadline fired and lose the results the
      // deadline exists to save. A wedged BROWSER is the opposite — its transport
      // stays ref'd and holds the process open on its own — so this timer's
      // ref-ness decides the outcome in one of the two cases and not the other.
      // The `finally` above clears it on every close that does settle, so a clean
      // run is never delayed.
    }),
  ]);
};

/**
 * Page errors, counted in full but retained in bounded number.
 *
 * Nothing downstream reads past the first entry — every message quotes `first`
 * and the count — but the array they used to be pushed into had no bound, and
 * the events feeding it are page-driven. A build whose `pageerror` fires once per
 * frame pushes tens of thousands of Errors, each retaining a stack, during a
 * single 20-minute prove; the driver only checks the log between proves, so
 * there is no throw to stop it. Left unbounded that turns a diagnosable "the page
 * raised an error" failure into an opaque OOM with no artifact.
 *
 * `length` is the TRUE count, not the retained one, so the existing call sites
 * keep reporting how many errors there were rather than how many were kept.
 */
class PageErrorLog {
  static RETAIN = 20;

  #retained = [];
  #count = 0;

  /**
   * `line` is logged, not just stored, and the logging is capped with the
   * retention for the same reason: these call sites used to `console.error`
   * unconditionally, so the frame-rate case flooded the job log with the same
   * message and buried the setup and timing output a reader needs. One line says
   * the flood happened; the count in the driver's throw says how big it got.
   */
  push(error, line) {
    this.#count += 1;
    if (this.#retained.length < PageErrorLog.RETAIN) {
      this.#retained.push(error);
      console.error(line);
    } else if (this.#count === PageErrorLog.RETAIN + 1) {
      console.error(
        `[pageerror] suppressing further page errors after ${PageErrorLog.RETAIN}; the count in the failure below is complete`
      );
    }
  }

  get length() {
    return this.#count;
  }

  get first() {
    return this.#retained[0];
  }
}

// Opens a page, runs setup on it, and returns handles the driver can drive
// one prove at a time. The caller owns closing the context.
const openSide = async (browser, url, label, repIndex) => {
  // Through `deadlineFor`, like every other ceiling in this file, rather than
  // straight off the constant. Three of these open per side per repetition, so a
  // repetition that began with less than a minute of budget left could spend six
  // unbudgeted ceilings against a 90s teardown margin, and the run reached
  // `emitResults()` with the margin already gone.
  //
  // REFUSED rather than clamped, and that is worth stating because the grant
  // shape allows both: PLAYWRIGHT_TIMEOUT_MS equals BUDGET_FLOOR_MS, so
  // `grantDeadline` either hands back the whole ceiling or refuses outright —
  // `clamped` is never set for these three. A refusal stops the run WITH its
  // completed repetitions instead of losing them to a killed step. Raise
  // PLAYWRIGHT_TIMEOUT_MS above the floor and clamping switches on, at which
  // point these call sites have to start reading `clamped` the way
  // `evaluateWithDeadline` does.
  const context = await withPlaywrightDeadline(
    `${label} rep ${repIndex}: newContext`,
    deadlineFor(PLAYWRIGHT_TIMEOUT_MS).ms,
    () => browser.newContext(),
    trackLateClose
  );
  // Both, because they are separate settings in Playwright and `goto` reads the
  // navigation one. Without these the three unwrapped calls run under a default
  // this file does not control and cannot report.
  context.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(PLAYWRIGHT_TIMEOUT_MS);
  const pageErrors = new PageErrorLog();
  // Set synchronously before any close is requested, so the worker-close
  // handler below can tell a teardown from a mid-run death. Playwright's own
  // `page.isClosed()` cannot: it flips after the workers have already gone.
  let closing = false;
  try {
    const page = await withPlaywrightDeadline(
      `${label} rep ${repIndex}: newPage`,
      deadlineFor(PLAYWRIGHT_TIMEOUT_MS).ms,
      () => context.newPage(),
      trackLateClose
    );
    // An uncaught page error means this iteration's timings are unexplained,
    // so fail rather than fold suspect numbers into the results.
    page.on("pageerror", (error) => {
      pageErrors.push(error, `[pageerror] ${label} rep ${repIndex}: ${error}`);
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
        pageErrors.push(error, `[worker] ${error.message}`);
      });
    });
    // Per call from the budget, not from the context default set above. `goto` is
    // the third of the three calls PLAYWRIGHT_TIMEOUT_MS names and was the only
    // one left on the raw constant, so 60s of unbudgeted wall clock could stack
    // on top of the two granted ceilings that precede it and push the work past
    // the point the teardown margin was reserved from. The context defaults stay
    // as the floor for anything else that reads them.
    lastPlaywrightDeadlineMs = deadlineFor(PLAYWRIGHT_TIMEOUT_MS).ms;
    await page.goto(url, { timeout: lastPlaywrightDeadlineMs });
    // Timed, and reported. Setup is not part of the measurement, but it is by far
    // the largest consumer of the step's wall-clock budget — a repetition sets up
    // BOTH sides, so a default run pays fourteen of them — and until this was
    // logged the figure in the budget arithmetic was an estimate nobody had
    // checked. Sizing --budget-minutes correctly needs the real number, and the
    // run itself is the only thing that knows it.
    const setupStartedAt = performance.now();
    const { rayonThreads } = await evaluateWithDeadline(
      page,
      setupInPage,
      { threads },
      {
        ...deadlineFor(SETUP_CEILING_MS),
        what: `${label} rep ${repIndex} setup`,
      }
    );
    const setupMs = performance.now() - setupStartedAt;
    // Filtered rather than asserted: this number only feeds a diagnostic, so it
    // must never be able to end a run that has measurements in hand.
    if (Number.isFinite(setupMs) && setupMs > 0) setupDurations.push(setupMs);
    if (pageErrors.length) {
      throw new Error(
        `${label} rep ${repIndex} raised ${pageErrors.length} page error(s) during setup; first: ${pageErrors.first}`
      );
    }
    // Snapshot after setup, when the rayon pool is fully spun up: `settle()`
    // compares against this rather than against `threads`, because how many
    // workers the pool actually opens is the browser's business.
    const workersAfterSetup = page.workers().length;

    return {
      label,
      rayonThreads,
      pageErrors,
      /**
       * Drain in-flight CDP events, then report what the page recorded.
       *
       * Reading `pageErrors` straight after the last prove is not enough.
       * Playwright delivers worker `close` over CDP asynchronously, so a worker
       * that dies during a repetition's LAST prove can be recorded after that
       * prove's own check has already returned — and `close()` then latches
       * `closing` and suppresses everything after it, so the tainted repetition
       * was retained and the run reported success.
       *
       * The `evaluate` narrows that window: it is a round trip on the same
       * connection the worker events arrive on, so anything the browser had
       * already emitted when it sent the reply has been dispatched by the time
       * this resolves. Bounded like every other in-page call, and a barrier that
       * fails is itself a reason to distrust the repetition.
       *
       * NOT a guarantee, and it must not be read as one. The ordering it relies
       * on is over EMISSION, and a worker's teardown does not travel the same
       * path into the browser process as an `evaluate` reply — a worker that
       * traps rather than being terminated is not reported from the main thread
       * at all. So a `close` emitted after the reply can still arrive after this
       * returns, be suppressed by the `closing` latch, and leave a repetition
       * measured on a shrunken pool in the results. Rare rather than impossible,
       * which is the worst shape for a benchmark, because the contaminated
       * repetition is indistinguishable from a regression. Making it airtight
       * needs an IN-PAGE check, where the ordering is the page's own execution
       * order: the SDK exposes `mtProbeAsync` for exactly that.
       *
       * Its ceiling sits BELOW the budget floor — a 30s barrier against a 60s
       * floor — so `grantDeadline` compares the floor against the ceiling and this
       * call only ever refuses outright or receives its full 30 seconds, never a
       * squeezed one.
       *
       * The worker count is NOT a second, independent detector, and it was
       * described as one here. Playwright removes the worker from `page.workers()`
       * and emits the `close` this file listens for in the same synchronous
       * callback, so an event that never arrives takes the count with it — there
       * is no failure mode where the count knows something the handler does not.
       * It is kept as a cheap assertion that Playwright's own bookkeeping agrees
       * with the handler, which would catch an upstream change to that coupling;
       * the barrier above is the half that does the work.
       */
      settle: async () => {
        try {
          await evaluateWithDeadline(page, () => 0, undefined, {
            ...deadlineFor(SETTLE_CEILING_MS),
            what: `${label} rep ${repIndex} settle`,
          });
        } catch (error) {
          // Two classes of error do not belong in `pageErrors`, which exists to
          // record faults of the PAGE. Burying either one here misdirects whoever
          // reads the log to the prover.
          //
          // A budget error means the clock ran out; burying it also lost the
          // marker the driver uses to keep the repetitions already measured.
          //
          // A TypeError or RangeError from this call is one of the budget module's
          // own validation guards firing — a malformed deadline, or a nonsensical
          // ceiling. Both are producer bugs, not something the page did. The other
          // two call sites let them propagate; this one has to say so explicitly
          // because its catch is broad.
          //
          // A DEADLINE overrun propagates like every other one. A 30-second empty
          // round trip on an idle page that does not come back IS a fault — the
          // barrier's ceiling is below BUDGET_FLOOR_MS, so it is granted whole or
          // refused outright and never gets a shortened deadline (asserted in
          // bench-budget.test.mjs) — but burying it in `pageErrors` made the
          // driver rethrow a plain Error, which skipped `emitResults()` and threw
          // away every COMPLETE repetition measured before it. The comment here
          // claimed it "discards the repetition"; it discarded the run.
          //
          // Propagating instead lands it on the earlyStop path: the tainted
          // repetition is still dropped (this throw precedes the push into
          // `samples`), the completed ones are written, and the renderer withholds
          // the verdict from any run that stopped early. That is the same
          // keep-what-was-measured rule bench-budget.mjs states for every other
          // timeout.
          if (
            error instanceof BudgetExhaustedError ||
            error instanceof DeadlineExceededError ||
            error instanceof TypeError ||
            error instanceof RangeError
          ) {
            throw error;
          }
          pageErrors.push(error, `[settle] ${label} rep ${repIndex}: ${error}`);
          return pageErrors;
        }
        const workersNow = page.workers().length;
        if (workersNow < workersAfterSetup) {
          const shrank = new Error(
            `${label} rep ${repIndex} ended with ${workersNow} web workers but had ${workersAfterSetup} after setup, so the rayon pool shrank during the measurement`
          );
          pageErrors.push(shrank, `[worker] ${shrank.message}`);
        }
        return pageErrors;
      },
      prove: async () => {
        const ms = await evaluateWithDeadline(
          page,
          proveOnceInPage,
          undefined,
          {
            ...deadlineFor(PROVE_CEILING_MS),
            what: `${label} rep ${repIndex} prove`,
          }
        );
        if (pageErrors.length) {
          throw new Error(
            `${label} rep ${repIndex} raised a page error while proving; first: ${pageErrors.first}`
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
        // Deadlined for the same reason the browser and server closes are: this
        // runs in the driver's per-repetition `finally`, upstream of the results
        // write, and `Promise.allSettled` waits for SETTLEMENT. The `.catch` here
        // only converts a rejection into a record — a `context.close()` that
        // never settles at all held the whole run until the runner killed the
        // step, discarding every repetition that had already succeeded.
        return withCloseDeadline(`${label} context`, context.close()).catch(
          (error) => {
            // Recorded, not printed, for the same reason the outer teardown does
            // not print: the end-of-run summary lists every entry with the
            // reason it matters, and logging here as well made a two-failure run
            // read like a four-failure one.
            teardownFailures.push(`${label} context: ${error}`);
          }
        );
      },
    };
  } catch (error) {
    closing = true;
    // Recorded for the same reason the close() above records: setup can fail
    // with the context already wedged (goto timing out, the setup evaluate
    // throwing), and a context that will not close leaves a live page behind.
    // Swallowing it silently left a leaked browser process with no explanation
    // anywhere in the log.
    //
    // Deadlined, and this is the path where it matters most. A wedged context is
    // most likely precisely here — the failure classes that break setup are the
    // ones that also break teardown — and this close runs before ANY results
    // exist, so a hang costs the whole step with no artifact at all, rather than
    // costing a clean exit after the numbers are safe. Not printed here: the
    // run is about to throw, and `reportTeardownFailures` lists every entry with
    // the reason it matters, so logging here as well double-printed it.
    //
    // Registered rather than awaited. Awaiting made this the first of three
    // serial 30s close stages, which together are the entire teardown margin;
    // the repetition's own `finally` drains it alongside the side closes, so the
    // two overlap and a wedged context costs 30s rather than 60s.
    trackClose(
      withCloseDeadline(
        `${label} context (during setup)`,
        context.close()
      ).catch((closeError) => {
        teardownFailures.push(`${label} context (during setup): ${closeError}`);
      })
    );
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
// Set when the run stops early because the step budget ran out, rather than
// because anything failed. Keeps the completed repetitions.
// Either stop keeps the repetitions already measured. Named for what it is rather
// than for one of its two causes: a budget refusal, which is certain because the
// arithmetic ran before the work did, or a deadline overrun, which is not.
let earlyStop = null;

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
      // Enforced, not just documented. Reintroducing a canonicalising sort here
      // is a silent statistical regression — the numbers stay plausible, the
      // printed balance note keeps claiming the interleave is balanced because it
      // asks bench-order.mjs rather than the loop, and only a recalibration would
      // ever show it. Cheap enough to check every repetition.
      const expectedOpenOrder = opensBaseFirst(rep)
        ? ["base", "head"]
        : ["head", "base"];
      const actualOpenOrder = sides.map((side) => side.label);
      const expectedHere = expectedOpenOrder.filter((label) =>
        actualOpenOrder.includes(label)
      );
      if (actualOpenOrder.join(",") !== expectedHere.join(",")) {
        throw new Error(
          `internal: sides must stay in open order for the interleave to compose ` +
            `(expected ${expectedHere.join(",")}, got ${actualOpenOrder.join(",")})`
        );
      }

      // `sides` STAYS in open order. bench-order.mjs's `proveOrder` documents
      // that as its input contract and `orderBalance` simulates it that way, so
      // canonicalising to [base, head] here strips the repetition parity out of
      // the composition and leaves the prove index as the only alternation — base
      // first iff `i` is even, the same way in every repetition. That is the
      // fixed positional asymmetry the interleave exists to remove, and it is the
      // one kind of error repetitions cannot average out. Nothing below indexes
      // `sides` positionally; every consumer goes through `side.label`.
      const perSide = new Map(sides.map((side) => [side.label, []]));
      for (let i = 0; i < proves; i++) {
        // ABBA: even proves run in the open order, odd proves reversed. Keyed on
        // `i` alone because `sides` is already in open order, which alternates
        // per repetition — the composition carries both bits, and adding `rep`
        // here would turn one of them twice. bench-order.mjs owns the rule and
        // bench-order.test.mjs pins it; the warning near the top of this file
        // counts what this produces rather than restating a parity formula.
        const order = proveOrder(sides, i);
        for (const side of order) {
          perSide.get(side.label).push(await side.prove());
        }
      }

      // Before anything is retained, and after a protocol barrier so a late
      // worker death has actually been delivered: without it the event could
      // land after this check and then be swallowed by the `closing` latch, and
      // a repetition measured on a shrunken rayon pool was kept.
      for (const side of sides) {
        await side.settle();
      }
      for (const side of sides) {
        if (side.pageErrors.length) {
          throw new Error(
            `${side.label} ${isWarmup ? "warmup" : `rep ${rep}`} raised ` +
              // "or the settle barrier", because `settle()` records its own
              // failures in this same array. A barrier that timed out reported as
              // a page error "during its proves" sent the reader to the prover for
              // something the proves had nothing to do with.
              `${side.pageErrors.length} page error(s) during its proves or the ` +
              `settle barrier; first: ` +
              `${side.pageErrors.first}`
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
    } catch (error) {
      // Running out of clock is not a failed benchmark, and it used to be
      // treated as one: the throw propagated to `benchError`, which is rethrown
      // upstream of `emitResults()`, so a run that had completed six of seven
      // repetitions wrote no artifact at all and the reporter posted "no usable
      // report". Every repetition in `samples` is whole — a repetition is only
      // pushed after both sides finish, so a mid-repetition stop leaves nothing
      // partial behind — which makes them worth keeping and reporting on.
      //
      // A deadline overrun stops the run the same way. It used to be classified
      // — hang, discard everything; clock, keep it — and six rounds of review
      // could not make that call correctly, because it is a guess about work that
      // did not finish. Keeping the measurements is the safe half of the guess:
      // the renderer withholds the verdict from any run that stopped early, so
      // nothing measured around a hang is published as a result, and a reader with
      // the facts settles in seconds what the code could not.
      //
      // Playwright's own TimeoutError counts as an overrun too. `goto` is the
      // remaining call in a repetition that is NOT wrapped by
      // `evaluateWithDeadline` — it is Playwright's own API, under the context
      // timeouts set in `openSide` — so a page that will not navigate late in a
      // run rejects with a plain Error subclass rather than with
      // DeadlineExceededError, and took the discard-everything path below. That
      // is the same unfinished-work shape as every other overrun, and it threw
      // away completed repetitions for it. Matched by `name` because the class is
      // not exported from `@playwright/test` in a form worth importing here.
      //
      // `newContext` and `newPage` used to be in that list and are not any more:
      // they are protocol round trips that ignore `setDefaultTimeout` entirely,
      // so there was no TimeoutError to convert and a browser wedged at either
      // one hung until the runner killed the step. `withPlaywrightDeadline` now
      // bounds them and raises DeadlineExceededError directly.
      //
      // Converted rather than passed through, because `stoppedEarlyKind:
      // "deadline"` obliges the artifact to carry `stoppedEarlyDeadlineMs` and
      // the renderer refuses it outright when it is missing. Playwright's own
      // timeout is the deadline that fired, so it is the honest figure to report.
      if (error instanceof Error && error.name === "TimeoutError") {
        // `lastPlaywrightDeadlineMs`, not the constant. `goto` now takes a
        // budget-clamped timeout, so the constant is no longer necessarily the
        // deadline that fired — and this figure becomes the artifact's
        // `stoppedEarlyDeadlineMs`, which the renderer publishes as the deadline
        // this run overran.
        error = new DeadlineExceededError(
          error.message,
          `a Playwright call did not finish within its ${lastPlaywrightDeadlineMs / 1000}s timeout: ${error.message}`,
          { deadlineMs: lastPlaywrightDeadlineMs }
        );
      }
      // Rethrown for anything else. A dead worker or a page error SHOULD discard
      // the run — those are observed faults, not unfinished work.
      if (
        !(error instanceof BudgetExhaustedError) &&
        !(error instanceof DeadlineExceededError)
      ) {
        throw error;
      }
      earlyStop = error;
      // Labelled by class, because the runbook sends people to this log first and
      // the two stops want opposite responses: a refusal means resize the budget,
      // an overrun means work out which of the two it was.
      console.error(
        `\n[${error instanceof BudgetExhaustedError ? "budget" : "deadline"}] ${error.message}`
      );
    } finally {
      await Promise.allSettled([
        ...sides.map((side) => side.close()),
        settlePendingCloses(),
      ]);
    }
    if (earlyStop) break;
    // Between repetitions, not after all of them — hence the bound. The reason
    // to stop is that the NEXT repetition would be measured alongside whatever
    // failed to close; after the last one there is no next repetition, the
    // samples are complete, and throwing here would discard a full run over a
    // browser that was about to be killed anyway. That case falls through to the
    // outer teardown, which keeps the results and exits nonzero.
    if (rep < totalReps - 1 && teardownFailures.length) {
      // An early stop rather than a throw. Stopping is right — the next repetition
      // would be measured against a live page — but the repetitions already in
      // `samples` were each measured before anything failed to close, and throwing
      // here sent them to `benchError`, which is rethrown upstream of
      // `emitResults()`. A run that had completed six of seven repetitions wrote no
      // artifact at all and the reporter posted "no usable report", which is the
      // same data loss the budget and deadline paths above were fixed for.
      earlyStop = new TeardownStopError(
        `a page context failed to close after ${isWarmup ? "the warmup" : `rep ${rep}`}, ` +
          `so the repetitions after it would be measured against a live page: ` +
          `${teardownFailures.join("; ")}`
      );
      console.error(`\n[teardown] ${earlyStop.message}`);
      break;
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
  //
  // Each one is also BOUNDED. These awaits run before results.json is written, so
  // a `browser.close()` that never settles — a wedged Chromium, which is a
  // plausible outcome of exactly the prover hang this benchmark exists to catch —
  // did not merely leak a process: it hung here until the runner killed the step,
  // and a complete set of measurements was never written at all. A close that
  // will not finish is recorded as a teardown failure like any other and the run
  // goes on to write its numbers.
  const teardown = await Promise.allSettled([
    // Included so the accounting is complete before `results` is built: this is
    // the last stage that runs before the artifact records `teardownFailures`
    // and before the exit path reads `abandonedCloses`.
    settlePendingCloses(),
    withCloseDeadline("browser", browser?.close()),
    ...servers.map(({ server }, i) =>
      withCloseDeadline(
        `server ${i}`,
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          // `close` only stops accepting; without this it waits out the
          // keep-alive timeout on any socket Chromium left open.
          server.closeAllConnections();
        })
      )
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

// The number of whole repetitions actually measured. Both sides advance together
// — a repetition is pushed only after every side finished — so either side's
// group count is the answer, and head is always present.
//
// Balanced down when the run stopped short, and that is not tidiness: an odd
// number of retained repetitions leaves the setup order lopsided, which biases
// every repetition rather than just costing one. `balancedRetainedReps` in
// bench-order.mjs owns the rule, alongside the alternation it protects. A full run
// is left exactly as measured — the requested count is even, so it never needs it.
// Captured before the drop below, because this is what the process actually ran
// and `repsExecuted` is supposed to say so.
const repsCompleted = samples.head.length;
const repsMeasured = earlyStop
  ? balancedRetainedReps(repsCompleted)
  : repsCompleted;
if (repsMeasured < repsCompleted) {
  console.error(
    // Tagged by what it is rather than by the budget, because all three early
    // stops reach this drop and only one of them is the clock.
    `[balance] dropping repetition ${repsCompleted} of the ${repsCompleted} measured: ` +
      `an odd number of retained repetitions leaves the setup order unbalanced, ` +
      `which biases the comparison in a way more repetitions cannot fix`
  );
  for (const label of Object.keys(samples)) {
    // Shortened, never extended. On a head-only run `samples.base` is empty, and
    // `[].length = 4` grows it into four holes that serialize as
    // `[null,null,null,null]`. Harmless today only because `summarize` filters
    // empty groups out before reading them — an accident to not depend on.
    if (samples[label].length > repsMeasured) {
      samples[label].length = repsMeasured;
    }
  }
}

// A budget stop with nothing measured is a failure, not a short report. The
// renderer requires `reps >= 1`, so emitting a zero-repetition artifact would
// only produce a refusal on the reporting side with the real reason left in this
// job's log. Say it here, where it is actionable.
if (earlyStop && !benchError && repsMeasured === 0) {
  benchError = new Error(
    `${earlyStop.headline ?? earlyStop.message} — ${
      repsCompleted === 0
        ? "no repetition completed"
        : "only one repetition completed, and a single repetition leaves the setup order unbalanced"
    }, so there is nothing to report`
  );
}

/**
 * Leave now, killing the browser, when a close had to be abandoned.
 *
 * `process.exit` is the only way past a ref'd handle: abandoning a wedged
 * `browser.close()` leaves Playwright's transport ref'd, so the process stays
 * alive with its work already done until the runner kills the step at its
 * `timeout-minutes`. That surfaces as a timeout rather than as a failed run —
 * the "killed with no diagnostic" outcome the budget clamp exists to prevent —
 * and it spends up to the whole step cap doing nothing.
 *
 * The SIGKILL is not optional. `process.exit` ends THIS process and does nothing
 * about the browser it launched; Playwright only reaps Chromium on a clean close,
 * which is exactly what did not happen here. On a self-hosted runner that orphan
 * outlives the job and lands in the next run's numbers as the interference this
 * whole script exists to exclude.
 *
 * Shared by both exit paths, because it was originally written into only one of
 * them. The success path reaches it after writing results; the `benchError` path
 * threw instead, and a wedged SETUP — which typically wedges the context close
 * too — takes the benchError path, so the kill was missing from the case most
 * likely to need it.
 *
 * Returns normally when nothing was abandoned, so callers keep their own
 * behaviour (throw, or fall through to a clean exit).
 */
const leaveIfResourcesAbandoned = async (finalMessage) => {
  if (abandonedCloses === 0) return;
  // Queued BEFORE the flush, not after. Flushing first and then writing put the
  // one message explaining the exit behind the flush that exists to preserve it:
  // when stderr is backed up — the only case where the flush does any work —
  // that write is still in the buffer when `process.exit` discards it.
  if (finalMessage) console.error(finalMessage);
  console.error(
    `\n${abandonedCloses} resource${abandonedCloses === 1 ? "" : "s"} had to be abandoned, so this process is exiting rather than waiting for ${abandonedCloses === 1 ? "it" : "them"}. Something may still be running.`
  );
  const flush = (stream) =>
    new Promise((resolve) => {
      if (stream.writableLength === 0) return resolve();
      stream.write("", () => resolve());
    });
  // Bounded. The flush waits on the GHA log pipe, and a back-pressured pipe is
  // the same "wait out the step cap" outcome this function exists to avoid — so
  // a lost diagnostic is preferred over a lost exit.
  await Promise.race([
    Promise.all([flush(process.stdout), flush(process.stderr)]),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  // Guarded and swallowed: `process()` is null for a remote browser, and the pid
  // may already be gone, neither of which should replace the exit code that says
  // why the run is leaving.
  try {
    browser?.process()?.kill("SIGKILL");
  } catch {
    // Already dead, or never ours to kill. Nothing to add.
  }
  process.exit(process.exitCode || 1);
};

if (benchError) {
  reportTeardownFailures({ resultsWritten: false });
  // Before the throw, because a throw does not reach the exit path at the bottom
  // of this file and a wedged setup is both the commonest way to get here and the
  // likeliest to have left Chromium alive. The message goes out through the same
  // flush rather than through node's uncaught-exception printer, which the exit
  // pre-empts.
  await leaveIfResourcesAbandoned(`\n${benchError.stack ?? benchError}`);
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
// thing that varies and it only ever ADDS time: the rep's MINIMUM is its best
// OBSERVED warm prove. Not its clean compute cost — a minimum is a lower-tail
// order statistic whose bias toward that tail depends on how many proves are
// drawn, so it is blind to a regression that leaves the best case alone. The
// comparison stays fair because both sides are forced to the same retained
// prove count, and the renderer's mean-of-every-prove cross-check is what
// covers the blind spot. See docs/benchmarks/calibration.md.
//
// Across reps the faucet differs (it is not seedable here), which changes the
// note commitment, the Fiat-Shamir transcript and hence the proof-of-work grind
// length — a skewed lottery that a global minimum would just pick the luckiest
// draw from. Averaging the per-rep minima keeps the interference filtering and
// SHRINKS the grind's contribution; it does not cancel it, because each side
// draws its own.
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
  schemaVersion: 3,
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
  //
  // MEASURED, not requested. The renderer requires `samples` to hold exactly
  // `reps` groups and refuses the artifact otherwise, so emitting the requested
  // count after a run that stopped early on its budget would have produced an
  // artifact the reporter throws away — defeating the point of keeping those
  // repetitions. `repsRequested` records what was asked for, so the difference
  // is visible rather than inferred.
  reps: repsMeasured,
  provesPerRep: proves - 1,
  repsRequested: reps,
  // What the process RAN: the discarded warm-up plus every repetition that
  // completed, including one dropped for parity. On a full run this is the
  // retained count plus the warm-up, as it always was.
  repsExecuted: repsCompleted + 1,
  provesExecutedPerRep: proves,
  // Present only when the run stopped short, so its absence means a full run.
  //
  // The renderer uses only its PRESENCE, never this text. Comment prose is
  // pinned on the trusted side for the same reason the verdict is: a fork
  // controls this file, and the one thing it must not get is a sentence in the
  // comment. The message is here for whoever reads results.json or the job log.
  ...(earlyStop
    ? {
        stoppedEarly: earlyStop.message,
        // The KIND, separately and from a closed set, because the renderer needs
        // it and must not parse the prose above. Without it the comment had to
        // pick one cause for both, and it picked "the budget ran out" — telling
        // the author of a deadlocked prover to raise their timeout.
        stoppedEarlyKind:
          earlyStop instanceof BudgetExhaustedError
            ? "budget"
            : earlyStop instanceof TeardownStopError
              ? "teardown"
              : "deadline",
        // Only an overrun has one, and it is half of what settles the question.
        // The other half is setupMsMedian below.
        ...(earlyStop instanceof DeadlineExceededError
          ? { stoppedEarlyDeadlineMs: earlyStop.facts.deadlineMs }
          : {}),
      }
    : {}),
  // Untimed by the estimator, but the figure the step budget is sized against.
  // Emitted so the budget can be checked from a real run rather than from an
  // estimate; the renderer ignores it.
  ...(setupDurations.length > 0
    ? {
        setupMsMean: Math.round(
          setupDurations.reduce((a, b) => a + b, 0) / setupDurations.length
        ),
        // The median alongside the mean and max because it is the robust one: a
        // single slow setup moves the other two and not this. Read it against a
        // deadline overrun's reported deadline to settle whether the work was
        // stuck or the clock was short — the pair is what replaced the code that
        // tried to answer that itself.
        setupMsMedian: medianOf(setupDurations),
        setupMsMax: Math.max(...setupDurations),
        setupCount: setupDurations.length,
      }
    : {}),
  // No `thresholdPct` / `thresholdProvisional` / `lowerIsBetter` here: those
  // decide the verdict, and .github/scripts/render-bench-comment.mjs renders
  // this file on the side that holds a write token, from an artifact a fork
  // controls. They are pinned on that side instead, in
  // .github/scripts/bench-profile.mjs, which the renderer imports and no
  // artifact can reach. Changing the noise floor means editing `thresholdPct`
  // there — see docs/benchmarks/calibration.md.
  // Carried into the artifact so the report can say so. `process.exitCode = 1`
  // reddens the bench job, but `Record PR context` and `Upload benchmark report`
  // are `if: always()` and the samples are complete — so without this the
  // reporter posted an ordinary-looking comment and a `neutral` check run beside
  // a red bench job, and nothing connected the two. A reader had no way to know
  // the numbers came from a run that left a page or a browser alive.
  //
  // Complete at this point, and there is no second write. Everything that can
  // append to this list has already run: the per-repetition context closes
  // inside the driver loop, and the browser and server closes in the `finally`
  // above, which is upstream of this object. An earlier version rewrote the file
  // after teardown on the belief that teardown came later; it could not fire.
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
// `results.reps`, not the `--reps` flag. After a budget stop the two differ, and
// printing the flag meant stdout said `reps=6` while the artifact and the PR
// comment both said four — the log being the first thing anyone reads when the
// comment looks wrong.
console.log(
  `threads=${results.threads} reps=${results.reps}` +
    (results.stoppedEarly ? ` (of ${results.repsRequested} requested)` : "") +
    ` proves/rep=${proves} warm samples/side=${samples.head.flat().length}\n`
);
if (results.stoppedEarly) {
  console.log(`stopped early: ${results.stoppedEarly}\n`);
}

// The budget report. Printed on every run because the step budget is sized against
// the setup cost, and a repetition sets up BOTH sides — so the count is
// 2 × (reps + 1), which is the figure to check the accounting in bench.yml
// against. Read this line and size --budget-minutes from it, not from an estimate.
if (setupDurations.length > 0) {
  const totalSetup = setupDurations.reduce((a, b) => a + b, 0);
  const slowest = Math.max(...setupDurations);
  console.log(
    `[budget] ${setupDurations.length} setups: ` +
      `mean ${(totalSetup / setupDurations.length / 1000).toFixed(1)}s, ` +
      `median ${(medianOf(setupDurations) / 1000).toFixed(1)}s, ` +
      `slowest ${(slowest / 1000).toFixed(1)}s, ` +
      `total ${(totalSetup / 60000).toFixed(1)} min` +
      (BUDGET_MS === null
        ? ""
        : ` of a ${formatMinutes(BUDGET_MS)}-minute budget`) +
      `. Setup is untimed by the estimator and dominates the clock; if this total ` +
      `crowds the budget, raise --budget-minutes and the step's timeout-minutes ` +
      `together.\n`
  );
}
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

// Guarded, because `leaveIfResourcesAbandoned` below is the only thing that
// escapes a wedged browser and a throw from here skipped it. This is the one
// path where the failure and the missing kill are correlated: a full disk or a
// read-only mount fails the write AND leaves the browser exactly as wedged as it
// was, so the process exited with an orphaned Chromium holding a port. The
// `benchError` path already ran the kill before rethrowing; the success path did
// not.
let writeError = null;
let writtenTo = null;
try {
  writtenTo = await emitResults();
} catch (error) {
  writeError = error;
}
if (writtenTo) console.log(`\nwrote ${writtenTo}`);

// The measurements are complete and written, so they are worth keeping — but a
// browser or server that would not close means this process is about to exit 0
// with something still holding a port or a pid. On a self-hosted runner that
// outlives the job and lands in the NEXT run's numbers as interference, which is
// the failure this whole script is built to avoid. Report the results, then say
// plainly that the run is not clean.
// Also guarded: it is load-bearing for reaching the kill below, and it writes to
// a stderr that can be EPIPE'd by the time it runs.
try {
  reportTeardownFailures({ resultsWritten: writeError === null });
} catch (error) {
  console.error(`\ncould not print the teardown summary: ${error.message}`);
}

// And then LEAVE, if a close was abandoned. `reportTeardownFailures` has set
// `process.exitCode`, which asks node to exit once the loop drains — and with a
// wedged close still ref'd the loop does not drain. The results are on disk and
// the summary is printed, so there is nothing left to wait for.
await leaveIfResourcesAbandoned(
  writeError ? `\n${writeError.stack ?? writeError}` : undefined
);
if (writeError) throw writeError;
