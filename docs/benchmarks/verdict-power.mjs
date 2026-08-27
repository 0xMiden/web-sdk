// Reproduces the power tables in calibration.md.
//
//   node docs/benchmarks/verdict-power.mjs
//
// Models each repetition's paired delta as normal about the true effect, scaled
// so the aggregate carries the measured 1.79% sd, then applies the renderer's
// verdict rule verbatim: magnitude at displayed precision, no contradicting
// sign, a positive majority, and the four-repetition floor. Kept in the repo
// because the tables in calibration.md would otherwise be unreproducible claims
// about a rule that lives in code and changes.
//
// The generator is fixed-seed rather than Math.random so the doc's numbers
// reproduce exactly. It is mulberry32, not the obvious two-line LCG: a modulus
// of 2^31 with those constants has a measured period of 10,466 states, so a
// 400k-trial run at six repetitions drew 4.8M numbers from ~5k distinct pairs
// and every published rate was an artifact of that cycle rather than an
// estimate. The `checkGenerator` assertion below now fails the script if the
// generator's tail probability drifts from the analytic normal, so a bad
// generator cannot quietly publish a table again.
//
// If the renderer's rule changes, change `verdict` below to match and re-run —
// the tables in calibration.md are only as current as the last run.

const THRESHOLD_PCT = 5.4;
// σ of the reported figure, measured over six calibration runs at the default
// six repetitions (calibration.md, "Why the estimator is what it is").
const SIGMA_AGGREGATE = 1.79;
const CALIBRATED_REPS = 6;
// The per-repetition spread is the fixed quantity — it is a property of the
// machine, not of how many repetitions you choose to average. Deriving it once
// here, rather than from each row's own `reps`, is the difference between
// modelling an average and modelling nothing: scaling per-rep σ up as
// √reps holds the aggregate's spread constant, which says averaging buys no
// precision at all, and produced a "24 repetitions" row claiming a true 8%
// regression would be called significant 0.8% of the time.
const SIGMA_REP = SIGMA_AGGREGATE * Math.sqrt(CALIBRATED_REPS);
const MIN_REPS_FOR_SIGN_TEST = 4;
const TRIALS = 400000;

let state = 42;
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = () => {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * The one part of this model with a closed form: the aggregate is a mean of
 * normals, so P(|mean| >= THRESHOLD_PCT) under no effect is just the normal
 * tail. Every rate below is conditioned on that event, so if the generator
 * cannot reproduce it the tables are fiction — which is exactly what happened
 * with the LCG this replaced.
 */
function checkGenerator() {
  const analytic = 2 * (1 - normalCdf(THRESHOLD_PCT / SIGMA_AGGREGATE));
  let hits = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    if (Math.abs(SIGMA_AGGREGATE * normal()) >= THRESHOLD_PCT) hits += 1;
  }
  const observed = hits / TRIALS;
  // 400k trials at p ≈ 0.0026 gives se ≈ 8e-5, so 4 se ≈ 3.2e-4. A generator
  // with a 10k-state cycle misses this by orders of magnitude.
  if (Math.abs(observed - analytic) > 4e-4) {
    throw new Error(
      `generator failed its tail check: P(|mean| >= ${THRESHOLD_PCT}%) came out ` +
        `${(100 * observed).toFixed(4)}%, analytic is ${(100 * analytic).toFixed(4)}%`
    );
  }
  return { observed, analytic };
}

/** Abramowitz & Stegun 26.2.17, plenty for a four-digit comparison. */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? 1 - tail : tail;
}

/** The renderer's rule, mirrored. Returns the label a reader would see. */
function verdict(deltas) {
  const reps = deltas.length;
  const aggregate = mean(deltas);
  const clearsFloor =
    Number(Math.abs(aggregate).toFixed(2)) >= Number(THRESHOLD_PCT.toFixed(2));
  if (!clearsFloor) return "silent";
  if (reps < MIN_REPS_FOR_SIGN_TEST) return "unresolved";
  const direction = Math.sign(aggregate);
  const agree = deltas.filter((d) => Math.sign(d) === direction).length;
  const contradicting = deltas.filter(
    (d) => d !== 0 && Math.sign(d) !== direction
  ).length;
  return contradicting === 0 && agree * 2 > reps ? "significant" : "unresolved";
}

function rates(reps, effectPct) {
  // Fixed per-repetition spread; the aggregate tightens as √reps on its own.
  // THRESHOLD_PCT deliberately does NOT tighten with it — the renderer applies
  // one calibrated floor whatever `--reps` says — so a longer run gets a floor
  // that is more than 3σ of its own estimator, which is conservative, not
  // sharper. That is a property of the rule worth seeing in the table.
  const sigmaRep = SIGMA_REP;
  const counts = { significant: 0, unresolved: 0, silent: 0 };
  for (let i = 0; i < TRIALS; i += 1) {
    counts[
      verdict(
        Array.from({ length: reps }, () => effectPct + sigmaRep * normal())
      )
    ] += 1;
  }
  return Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, (100 * v) / TRIALS])
  );
}

const row = (label, r) =>
  `  ${String(label).padStart(16)}  significant ${r.significant.toFixed(2).padStart(6)}%` +
  `  unresolved ${r.unresolved.toFixed(2).padStart(6)}%  silent ${r.silent.toFixed(2).padStart(6)}%`;

const check = checkGenerator();
console.log(
  `generator tail check: observed ${(100 * check.observed).toFixed(4)}% vs ` +
    `analytic ${(100 * check.analytic).toFixed(4)}%\n`
);

console.log("Six repetitions, by true effect:");
for (const effect of [0, 3, 5.4, 6.2, 8, 10, 15]) {
  console.log(row(`${effect}%`, rates(6, effect)));
}

console.log("\nA true 8% effect, by repetition count:");
for (const reps of [4, 6, 12, 24]) {
  console.log(row(`${reps} reps`, rates(reps, 8)));
}

console.log("\nFalse positives (no real effect), by repetition count:");
for (const reps of [1, 2, 3, 4, 6, 12, 24]) {
  console.log(row(`${reps} reps`, rates(reps, 0)));
}

const perPush = rates(6, 0).significant / 100;
console.log(
  `\nFamilywise over ten benchmarked pushes at six reps: ` +
    `${(100 * (1 - (1 - perPush) ** 10)).toFixed(2)}%`
);
