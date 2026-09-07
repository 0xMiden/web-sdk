// Reproduces the completion-probability table in calibration.md's budget section.
//
// The question is not "does 14 × 90s fit in 45 minutes" — it does — but how much
// the real setup cost may drift before a default run stops completing, since a
// truncated run withholds its verdict and is therefore worth nothing to a
// reviewer. Completion is a distribution: what matters is the mean AND the spread.
const REPS = 6;
const PROVES = 4;
const SIDES = 2;
const ITERS = REPS + 1;
const SETUPS = ITERS * SIDES;
const PROVE_MS = 5000;
const SETTLE_MS = 2000;
const LAUNCH_MS = 20000;
const USABLE_MS = (45 - 1.5) * 60e3;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normal = (rng) => {
  const u = rng() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};

// Lognormal, so a setup can be slow but never negative.
const lognormal = (rng, mean, cv) => {
  const sigma2 = Math.log(1 + cv * cv);
  return Math.exp(Math.log(mean) - sigma2 / 2 + Math.sqrt(sigma2) * normal(rng));
};

function completionRate(meanSetupMs, cv, trials = 200000) {
  const rng = mulberry32(0x5eed);
  const fixed =
    LAUNCH_MS + ITERS * SIDES * PROVES * PROVE_MS + SETUPS * SETTLE_MS;
  let completed = 0;
  for (let t = 0; t < trials; t++) {
    let total = fixed;
    for (let i = 0; i < SETUPS; i++) total += lognormal(rng, meanSetupMs, cv);
    if (total <= USABLE_MS) completed++;
  }
  return completed / trials;
}

const CVS = [0.1, 0.25, 0.5];
console.log(
  `\n  ${SETUPS} setups per default run (--reps ${REPS}, both sides), ` +
    `${(USABLE_MS / 60000).toFixed(1)} min usable\n`
);
console.log(
  `  mean setup | ${CVS.map((c) => `CV=${c.toFixed(2)}`.padStart(9)).join(" ")}`
);
for (const seconds of [60, 90, 120, 150, 180]) {
  const cells = CVS.map(
    (cv) => `${(100 * completionRate(seconds * 1000, cv)).toFixed(1)}%`.padStart(9)
  );
  console.log(`  ${String(seconds).padStart(9)}s | ${cells.join(" ")}`);
}
console.log(
  `\n  Each cell is the probability a run completes, and so the probability it can\n` +
    `  be ruled on at all — a truncated run withholds its verdict. The 90s row is\n` +
    `  the estimate the budget was sized from; nothing has measured the real value\n` +
    `  on the target runner. Read the producer's [budget] line from a real run and\n` +
    `  resize from that.\n`
);
