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
// The generator is a fixed-seed LCG rather than Math.random so the doc's numbers
// reproduce exactly. It is not a good generator; at three significant figures it
// does not need to be.
//
// If the renderer's rule changes, change `verdict` below to match and re-run —
// the tables in calibration.md are only as current as the last run.

const THRESHOLD_PCT = 5.4;
const SIGMA_AGGREGATE = 1.79;
const MIN_REPS_FOR_SIGN_TEST = 4;
const TRIALS = 400000;

let seed = 42;
const rand = () =>
  ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const normal = () => {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

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
  // A mean of `reps` draws carries sd SIGMA_AGGREGATE, so each draw carries
  // SIGMA_AGGREGATE * sqrt(reps).
  const sigmaRep = SIGMA_AGGREGATE * Math.sqrt(reps);
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
