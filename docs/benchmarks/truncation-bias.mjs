// Does stopping on a wall-clock budget bias the PAIRED delta?
//
// The mechanism under suspicion: the run stops because it was slow, so the
// retained prefix is selected on its own runtime. That is informative censoring.
// The question is whether it moves the reported percentage delta, which is a
// PAIRED quantity, and by how much relative to the 5.4% threshold.
//
// Faithful to the producer: every repetition runs BOTH sides, the budget is
// consumed by both, per-repetition machine noise is common-mode (it scales both
// sides together), and the side that sets up first pays a small penalty that
// alternates by repetition parity.

const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = (rng) => {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const T = 60; // seconds per prove, order of magnitude for this workload
const PROVES = 3; // retained proves per rep per side
const SIGMA_COMMON = 0.08; // machine-level, shared by both sides in a rep
const SIGMA_SIDE = 0.022; // per-side independent, the calibrated 2.2%
const SETUP_PENALTY = 0.03; // cost of setting up first, the ABBA asymmetry
// Set per scenario by the table loop at the bottom.
let DRIFT_PER_REP = 0;
let TAIL_P = 0;
let TAIL_SIZE = 0;
const THRESHOLD = 5.4;
const MIN_REPS = 6;

const minOf = (xs) => Math.min(...xs);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// One run. Returns the retained per-rep minima for both sides plus how the run
// ended. `budget` in seconds; Infinity means "never truncate".
function run(rng, delta, requestedReps, budget) {
  const base = [];
  const head = [];
  let elapsed = 0;
  for (let rep = 1; rep <= requestedReps + 1; rep++) {
    // Thermal drift: the runner slows as the job proceeds, so a truncated run
    // keeps the EARLY, faster repetitions. Common-mode, but systematic — this is
    // the mechanism most likely to break the exchangeability argument.
    const drift = 1 + DRIFT_PER_REP * (rep - 1);
    const m = Math.exp(normal(rng) * SIGMA_COMMON) * drift;
    const baseFirst = rep % 2 === 0; // mirrors opensBaseFirst
    const bPen = baseFirst ? SETUP_PENALTY : 0;
    const hPen = baseFirst ? 0 : SETUP_PENALTY;
    const b = [];
    const h = [];
    for (let p = 0; p < PROVES; p++) {
      // Heavy tail: an occasional very slow prove, which eats budget and would
      // wreck a mean. The statistic is a per-rep MINIMUM, so this also tests
      // whether the estimator's robustness survives truncation.
      const spikeB = rng() < TAIL_P ? 1 + TAIL_SIZE : 1;
      const spikeH = rng() < TAIL_P ? 1 + TAIL_SIZE : 1;
      b.push(T * m * (1 + bPen) * (1 + normal(rng) * SIGMA_SIDE) * spikeB);
      h.push(
        T * (1 + delta) * m * (1 + hPen) * (1 + normal(rng) * SIGMA_SIDE) * spikeH
      );
    }
    // The budget is consumed by everything the repetition actually did.
    elapsed += b.reduce((a, x) => a + x, 0) + h.reduce((a, x) => a + x, 0);
    if (elapsed > budget) return { base, head, truncated: true };
    if (rep > 1) {
      // rep 1 is the discarded warm-up
      base.push(minOf(b));
      head.push(minOf(h));
    }
  }
  return { base, head, truncated: false };
}

// The producer's rule: a truncated run drops its odd tail.
const balance = (n) => n - (n % 2);

function report(r) {
  let n = r.base.length;
  if (r.truncated) n = balance(n);
  if (n === 0) return null;
  const b = mean(r.base.slice(0, n));
  const h = mean(r.head.slice(0, n));
  return { n, deltaPct: ((h - b) / b) * 100 };
}

const verdict = (rep) =>
  rep === null || rep.n < MIN_REPS
    ? "unresolved"
    : rep.deltaPct > THRESHOLD
      ? "slower"
      : rep.deltaPct < -THRESHOLD
        ? "faster"
        : "noise";

const TRIALS = 40000;

function study(label, delta, budget, requestedReps) {
  const rng = mulberry32(12345);
  const groups = new Map();
  for (let i = 0; i < TRIALS; i++) {
    const r = run(rng, delta, requestedReps, budget);
    const rep = report(r);
    const key = r.truncated ? `stopped, retained ${rep ? rep.n : 0}` : "full run";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ rep, v: verdict(rep) });
  }
  console.log(`\n  ${label}  (true delta ${(delta * 100).toFixed(1)}%)`);
  const keys = [...groups.keys()].sort();
  for (const k of keys) {
    const g = groups.get(k);
    const withVal = g.filter((x) => x.rep);
    const md = withVal.length ? mean(withVal.map((x) => x.rep.deltaPct)) : NaN;
    const dir = g.filter((x) => x.v === "slower" || x.v === "faster").length;
    const pct = ((g.length / TRIALS) * 100).toFixed(1);
    console.log(
      `    ${k.padEnd(22)} ${pct.padStart(5)}% of runs   mean reported delta ` +
        `${(md >= 0 ? "+" : "") + md.toFixed(2)}%   directional verdict ${((dir / g.length) * 100).toFixed(2)}%`
    );
  }
}

// Reproduces the table in the "Stopping on the clock does not bias the
// comparison" section of calibration.md. The budget is expressed as a multiple of
// a full run's nominal cost, so the interesting region — where a run stops with
// exactly six repetitions retained — is reachable without hard-coding seconds.
const nominal = 9 * 2 * PROVES * T;

const scenarios = [
  ["Null, budget 0.95x", 0, 0.95, 0, 0, 0],
  ["Null, budget 1.00x", 0, 1.0, 0, 0, 0],
  ["Null, 5% thermal drift", 0, 0.95, 0.05, 0, 0],
  ["Null, heavy-tailed proves", 0, 0.95, 0, 0.15, 1.5],
  ["True +8%, budget 0.95x", 0.08, 0.95, 0, 0, 0],
  ["True +8%, 5% drift", 0.08, 0.95, 0.05, 0, 0],
];

// Each scenario is run twice: once with no budget at all, which yields complete
// six-repetition runs, and once with a budget placed where the run stops having
// retained exactly six. The comparison is the whole point — an absolute rate
// means nothing on its own, since heavy tails and drift move the numbers whether
// or not anything was truncated. What matters is that the two columns agree.
function measure(delta, budget, requestedReps, wantTruncated) {
  const rng = mulberry32(12345);
  const deltas = [];
  let directional = 0;
  let matched = 0;
  for (let i = 0; i < TRIALS; i++) {
    const r = run(rng, delta, requestedReps, budget);
    const rep = report(r);
    if (!rep || rep.n !== 6) continue;
    if (r.truncated !== wantTruncated) continue;
    matched += 1;
    deltas.push(rep.deltaPct);
    const v = verdict(rep);
    if (v === "slower" || v === "faster") directional += 1;
  }
  return {
    share: matched / TRIALS,
    delta: deltas.length ? mean(deltas) : NaN,
    directional: matched ? directional / matched : NaN,
  };
}

const fmtDelta = (d) =>
  Number.isNaN(d)
    ? "n/a"
    : `${d >= 0 ? "+" : "\u2212"}${Math.abs(d).toFixed(2)}%`;
const fmtRate = (r) => (Number.isNaN(r) ? "n/a" : `${(r * 100).toFixed(2)}%`);

console.log(
  "| Scenario | Complete | Stopped at 6 | Stopped share |"
);
console.log("| --- | --- | --- | --- |");
for (const [label, delta, budgetFactor, drift, tailP, tailSize] of scenarios) {
  DRIFT_PER_REP = drift;
  TAIL_P = tailP;
  TAIL_SIZE = tailSize;
  // Requesting six with no budget gives the uninterrupted baseline; requesting
  // eight with a budget gives runs that stopped having kept six.
  const full = measure(delta, Infinity, 6, false);
  const cut = measure(delta, nominal * budgetFactor, 8, true);
  console.log(
    `| ${label} | ${fmtDelta(full.delta)} / ${fmtRate(full.directional)} ` +
      `| ${fmtDelta(cut.delta)} / ${fmtRate(cut.directional)} ` +
      `| ${fmtRate(cut.share)} |`
  );
}
