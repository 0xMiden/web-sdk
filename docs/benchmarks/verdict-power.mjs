// Reproduces the power tables in calibration.md.
//
//   node docs/benchmarks/verdict-power.mjs
//
// Models each repetition's paired delta as normal about the true effect, scaled
// so the aggregate carries the measured sd from the profile's `estimatorSpread`,
// then applies the renderer's HEADLINE verdict rule: magnitude at displayed
// precision, no contradicting sign, a positive majority, and the repetition
// floor the profile's `calibratedReps` sets. Kept in the repo
// because the tables in calibration.md would otherwise be unreproducible claims
// about a rule that lives in code and changes.
//
// SCOPE, because "the verdict rule" is not one rule. The renderer also runs a
// mean cross-check (`meanOnly` / `pairedMeanAgreement`) over per-repetition
// MEANS, which can turn a headline-silent run into ❔ Unresolved when the means
// move while the minima do not. This model is fed per-repetition delta scalars
// and has no per-prove distribution to take a mean of, so it cannot express that
// leg at all: every row below is the behaviour of the headline
// minimum-estimator verdict, and the `silent` column means "the headline said
// nothing", not "the comment said nothing". Modelling the cross-check needs
// joint per-prove samples and a measured spread for the mean, which does not
// exist yet — see calibration.md on the mean's unmeasured σ.
//
// The generator is fixed-seed rather than Math.random so the doc's numbers
// reproduce exactly. It is mulberry32, not the obvious two-line LCG: a modulus
// of 2^31 with those constants has a measured period of 10,466 states, so a
// 400k-trial run at six repetitions drew 4.8M numbers from ~5k distinct pairs
// and every published rate was an artifact of that cycle rather than an
// estimate. The `checkGenerator` assertion below fails the script if the
// generator drifts from the analytic normal in its tail at either end of the
// reps range, if its draws are serially correlated, or if runs of same-signed
// draws are not as frequent as independence requires. That last check matters
// most: a far-tail check alone passes a stream with total serial dependence
// (feed every draw twice and the marginal distribution is untouched), and the
// sign-unanimity leg is what every `unresolved` figure below turns on.
//
// If the renderer's rule changes, change `verdict` below to match and re-run —
// the tables in calibration.md are only as current as the last run.

// The rule's three numbers are READ from the profile, not copied from it. Each
// used to be a literal here as well as in the renderer, so a re-calibration
// silently left this simulator modelling the OLD rule while calibration.md
// presented its tables as the current one. The profile is plain data with no
// dependencies, so importing it costs this script nothing and makes the pinning
// real rather than asserted.
import { DEFAULT_PROFILE } from "../../.github/scripts/bench-profile.mjs";

const THRESHOLD_PCT = DEFAULT_PROFILE.thresholdPct;
// σ of the reported figure, measured over the profile's `estimatorSpread` runs
// at the calibrated repetition count (calibration.md, "Why the estimator is what
// it is").
const SIGMA_AGGREGATE = DEFAULT_PROFILE.estimatorSpread.sdPct;
const CALIBRATED_REPS = DEFAULT_PROFILE.calibratedReps;
// The per-repetition spread is the fixed quantity — it is a property of the
// machine, not of how many repetitions you choose to average. Deriving it once
// here, rather than from each row's own `reps`, is the difference between
// modelling an average and modelling nothing: scaling per-rep σ up as
// √reps holds the aggregate's spread constant, which says averaging buys no
// precision at all, and produced a "24 repetitions" row claiming a true 8%
// regression would be called significant 0.8% of the time.
const SIGMA_REP = SIGMA_AGGREGATE * Math.sqrt(CALIBRATED_REPS);
// The renderer derives its repetition floor from `calibratedReps` the same way
// (`minRepsForSignTest` in .github/scripts/render-bench-comment.mjs), so both
// now follow the profile rather than agreeing by hand.
const MIN_REPS_FOR_SIGN_TEST = CALIBRATED_REPS;
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
 * Three checks, because one is not enough and the first version of this only had
 * the first.
 *
 * A far-tail check alone passes a stream that is 100% serially dependent — feed
 * it every draw twice and the marginal distribution is untouched — and such a
 * stream would wreck the sign-unanimity leg that every `unresolved` figure below
 * actually turns on. So the tail is checked at both the magnitudes the tables
 * use, and serial independence is checked directly.
 */
function checkGenerator() {
  const failures = [];

  // 1 & 2. Marginal tail at two repetition counts, chosen because they land in
  // different regions of the distribution: at one repetition the ±5.4% floor is
  // 1.23σ of the aggregate (the body, ~22%) and at six it is 3.02σ (the far
  // tail, ~0.26%). A bad generator can pass one and fail the other. Not 24 —
  // there the floor is over 6σ and both numbers round to zero, so the check
  // would be vacuous.
  const tails = [];
  for (const reps of [1, CALIBRATED_REPS]) {
    const sigma = SIGMA_REP / Math.sqrt(reps);
    const analytic = 2 * (1 - normalCdf(THRESHOLD_PCT / sigma));
    let hits = 0;
    for (let i = 0; i < TRIALS; i += 1) {
      if (Math.abs(sigma * normal()) >= THRESHOLD_PCT) hits += 1;
    }
    const observed = hits / TRIALS;
    // se = sqrt(p(1-p)/TRIALS); allow 4 se, floored so the far tail's tiny se
    // does not make the check hypersensitive to Monte-Carlo wobble.
    const tolerance = Math.max(
      4e-4,
      4 * Math.sqrt((analytic * (1 - analytic)) / TRIALS)
    );
    tails.push({ reps, observed, analytic });
    if (Math.abs(observed - analytic) > tolerance) {
      failures.push(
        `tail at reps=${reps}: P(|mean| >= ${THRESHOLD_PCT}%) came out ` +
          `${(100 * observed).toFixed(4)}%, analytic ${(100 * analytic).toFixed(4)}%`
      );
    }
  }

  // 3. Serial independence, which is the property the unanimity leg rests on and
  // the one a short-period or repeating stream destroys. Lag-1 correlation of
  // the normals, plus the joint statement the tables are made of: the chance
  // that `reps` consecutive draws all share a sign, against 2 * 0.5^reps.
  const draws = Array.from({ length: TRIALS }, () => normal());
  let sxy = 0;
  for (let i = 1; i < draws.length; i += 1) sxy += draws[i - 1] * draws[i];
  const lag1 = sxy / (draws.length - 1);
  if (Math.abs(lag1) > 0.01) {
    failures.push(`lag-1 correlation of the normals is ${lag1.toFixed(4)}`);
  }

  const reps = CALIBRATED_REPS;
  let unanimous = 0;
  const groups = Math.floor(draws.length / reps);
  for (let g = 0; g < groups; g += 1) {
    const slice = draws.slice(g * reps, g * reps + reps);
    const sign = Math.sign(slice[0]);
    if (slice.every((d) => Math.sign(d) === sign)) unanimous += 1;
  }
  const observedUnanimity = unanimous / groups;
  const analyticUnanimity = 2 * 0.5 ** reps;
  const unanimityTolerance =
    4 * Math.sqrt((analyticUnanimity * (1 - analyticUnanimity)) / groups);
  if (Math.abs(observedUnanimity - analyticUnanimity) > unanimityTolerance) {
    failures.push(
      `P(${reps} consecutive draws share a sign) came out ` +
        `${(100 * observedUnanimity).toFixed(4)}%, analytic ` +
        `${(100 * analyticUnanimity).toFixed(4)}%`
    );
  }

  if (failures.length) {
    throw new Error(`generator failed its checks:\n  - ${failures.join("\n  - ")}`);
  }
  return { tails, lag1, observedUnanimity, analyticUnanimity };
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
  if (!(contradicting === 0 && agree * 2 > reps)) return "unresolved";
  // Split by sign. calibration.md labels this column `slower`, and counting both
  // directions in it doubled the figure it published for the false-positive row:
  // under no effect the rule is symmetric, so half of every "significant" is a
  // spurious IMPROVEMENT, which is a different (and much less costly) failure
  // than a spurious regression.
  return aggregate > 0 ? "slower" : "faster";
}

function rates(reps, effectPct) {
  // SIGMA_REP is fixed and the aggregate tightens as √reps on its own.
  // THRESHOLD_PCT deliberately does NOT tighten with it — the renderer applies
  // one calibrated floor whatever `--reps` says — so a longer run gets a floor
  // that is more than 3σ of its own estimator, which is conservative, not
  // sharper. That is a property of the rule worth seeing in the table.
  const counts = { slower: 0, faster: 0, unresolved: 0, silent: 0 };
  for (let i = 0; i < TRIALS; i += 1) {
    counts[
      verdict(
        Array.from({ length: reps }, () => effectPct + SIGMA_REP * normal())
      )
    ] += 1;
  }
  return Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, (100 * v) / TRIALS])
  );
}

const row = (label, r) =>
  `  ${String(label).padStart(16)}  slower ${r.slower.toFixed(2).padStart(6)}%` +
  `  faster ${r.faster.toFixed(2).padStart(6)}%` +
  `  unresolved ${r.unresolved.toFixed(2).padStart(6)}%  silent ${r.silent.toFixed(2).padStart(6)}%`;

const check = checkGenerator();
console.log(
  "generator checks passed:\n" +
    check.tails
      .map(
        (t) =>
          `  tail at reps=${String(t.reps).padStart(2)}: observed ` +
          `${(100 * t.observed).toFixed(4)}% vs analytic ${(100 * t.analytic).toFixed(4)}%`
      )
      .join("\n") +
    `\n  lag-1 correlation: ${check.lag1.toFixed(5)}` +
    `\n  ${CALIBRATED_REPS} consecutive draws share a sign: ` +
    `${(100 * check.observedUnanimity).toFixed(4)}% vs analytic ` +
    `${(100 * check.analyticUnanimity).toFixed(4)}%\n`
);

// Memoised on (reps, effect). Three of the tables below overlap — (6, 0%)
// appears in two of them and in the familywise line, and (6, 8%) in two — and
// calling `rates` per cell gave each occurrence its own Monte-Carlo draw. The
// doc then published one modelled quantity as three different numbers (0.15%,
// 0.16%, and a familywise figure that back-solved to 0.153%), which reads as an
// arithmetic error in the analysis rather than as sampling noise.
const cache = new Map();
const ratesOnce = (reps, effectPct) => {
  const key = `${reps}:${effectPct}`;
  if (!cache.has(key)) cache.set(key, rates(reps, effectPct));
  return cache.get(key);
};

console.log("Six repetitions, by true effect:");
for (const effect of [0, 3, 5.4, 6.2, 8, 10, 15]) {
  console.log(row(`${effect}%`, ratesOnce(CALIBRATED_REPS, effect)));
}

console.log("\nA true 8% effect, by repetition count:");
for (const reps of [4, 6, 12, 24]) {
  console.log(row(`${reps} reps`, ratesOnce(reps, 8)));
}

console.log("\nFalse positives (no real effect), by repetition count:");
for (const reps of [1, 2, 3, 4, 6, 12, 24]) {
  console.log(row(`${reps} reps`, ratesOnce(reps, 0)));
}

const nullRates = ratesOnce(CALIBRATED_REPS, 0);
const perPush = (nullRates.slower + nullRates.faster) / 100;
console.log(
  `\nAt six reps, no real effect: any spurious verdict ` +
    `${(100 * perPush).toFixed(2)}% per push ` +
    `(slower ${nullRates.slower.toFixed(2)}%, faster ${nullRates.faster.toFixed(2)}%).\n` +
    `Familywise over ten benchmarked pushes: ` +
    `${(100 * (1 - (1 - perPush) ** 10)).toFixed(2)}%`
);
