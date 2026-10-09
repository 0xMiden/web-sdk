// What a clock-truncated run does to the paired comparison, and why the renderer
// refuses to rule on one.
//
//   node docs/benchmarks/truncation-selection.mjs
//
// This replaces an earlier script that asked the wrong question. That one modelled
// truncation under noise applied equally to both sides, found the paired delta
// unbiased, and was cited for the claim that "the comparison stays sound". The
// symmetry was doing all the work and nothing said so.
//
// The mechanism, stated before the simulation so the numbers can be checked
// against it rather than trusted:
//
// A truncated run stops when the clock runs out, so its length is decided by how
// slow the machine was — which is the quantity being measured. The surviving
// repetitions are therefore a selected sample. Selection acts on the run's total
// duration, roughly head + base, while the reported quantity is the difference,
// head - base. The correlation between the two is
//
//     Cov(head + base, head - base) = Var(head) - Var(base)
//
// which is zero exactly when the two sides have the same run-level variance. So
// symmetric noise, however heavy-tailed or drifting, cancels out of the paired
// delta; unequal variance does not, and the residue is proportional to the
// difference of the variances.
//
// The table below is that identity, measured. The model is deliberately the
// harshest of the reviewed candidates: thermal drift across the run, 5% chance of
// a 2.5x spike on any prove, four proves executed per repetition with the first
// discarded, and setup time charged to the budget — because the producer pays
// setup sequentially and it dominates a repetition's cost.
//
// The one knob is where the run-level factor lives. Read the "both" row against
// the "head-only" row: that difference is the whole argument.

// The floor is read from the profile rather than copied. A literal here modelled
// whatever the floor used to be, under a heading in calibration.md presenting
// the result as the current rule.
import { DEFAULT_PROFILE } from "../../.github/scripts/bench-profile.mjs";

const TRIALS = 400_000;
const SIGMA_RUN = 0.12; // run-level factor, one or both sides
const SIGMA_PROVE = 0.025; // per-prove jitter
const SIGMA_SETUP = 0.15; // setup is noisy and untimed, but charged to the clock
const THERMAL_PER_REP = 0.06; // the machine gets slower as the run goes on
const SPIKE_P = 0.05;
const SPIKE_X = 2.5;
const POSITION_PENALTY = 0.02; // second-position cost, per prove
const SETUP_COST = 180; // relative to a prove at 100
const PROVE_COST = 100;
const PROVES = 4; // executed; the first is discarded
const THRESHOLD_PCT = DEFAULT_PROFILE.thresholdPct;

const rng = (() => {
  let s = 0xdecafbad;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
})();
const normal = () => {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};
const lognormal = (sigma) => Math.exp(normal() * sigma - 0.5 * sigma ** 2);
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
const minOf = (xs) => Math.min(...xs);

/**
 * One run, stopping when `budget` is spent, retaining an even number of
 * repetitions the way the producer does.
 */
function run(budget, requested, mode) {
  const headRunFactor =
    mode === "head-only" || mode === "both" ? lognormal(SIGMA_RUN) : 1;
  const baseRunFactor =
    mode === "base-only" || mode === "both" ? lognormal(SIGMA_RUN) : 1;

  const base = [];
  const head = [];
  let elapsed = 0;

  for (let rep = 0; rep <= requested; rep += 1) {
    const thermal = 1 + THERMAL_PER_REP * rep;
    // Untimed by the estimator, charged to the wall clock, paid twice per
    // repetition because both sides are set up.
    elapsed += 2 * SETUP_COST * thermal * lognormal(SIGMA_SETUP);

    const b = [];
    const h = [];
    const baseOpensFirst = rep % 2 === 0;
    for (let p = 0; p < PROVES; p += 1) {
      const baseFirst = p % 2 === 0 ? baseOpensFirst : !baseOpensFirst;
      const bv =
        PROVE_COST *
        thermal *
        (baseFirst ? 1 : 1 + POSITION_PENALTY) *
        baseRunFactor *
        lognormal(SIGMA_PROVE) *
        (rng() < SPIKE_P ? SPIKE_X : 1);
      const hv =
        PROVE_COST *
        thermal *
        (baseFirst ? 1 + POSITION_PENALTY : 1) *
        headRunFactor *
        lognormal(SIGMA_PROVE) *
        (rng() < SPIKE_P ? SPIKE_X : 1);
      elapsed += bv + hv;
      b.push(bv);
      h.push(hv);
    }

    // A repetition interrupted by the clock is not retained at all.
    if (elapsed > budget) break;
    // Repetition 0 is the warm-up, and the first prove of each is discarded.
    if (rep > 0) {
      base.push(minOf(b.slice(1)));
      head.push(minOf(h.slice(1)));
    }
  }

  // The producer's rule: round the retained count down to even, so the setup
  // order stays balanced.
  const n = base.length - (base.length % 2);
  if (n === 0) return null;
  return { base: base.slice(0, n), head: head.slice(0, n), retained: n };
}

/** The renderer's actual rule: magnitude floor AND unanimous paired sign. */
function verdict(r) {
  const b = mean(r.base);
  const deltaPct = ((mean(r.head) - b) / b) * 100;
  if (r.retained < 6) return { deltaPct, called: false };
  const deltas = r.base.map((bv, i) => r.head[i] - bv);
  const direction = Math.sign(mean(deltas));
  const contradicting = deltas.filter(
    (d) => d !== 0 && Math.sign(d) !== direction
  ).length;
  const agree = deltas.filter((d) => Math.sign(d) === direction).length;
  const unanimous = contradicting === 0 && agree * 2 > r.retained;
  return {
    deltaPct,
    called: unanimous && Math.abs(deltaPct) >= THRESHOLD_PCT,
  };
}

function study(mode, budget, requested) {
  const deltas = [];
  let called = 0;
  let kept = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    const r = run(budget, requested, mode);
    if (r === null) continue;
    // Compare like with like: only runs that retained exactly six, so the
    // difference between the columns is the selection and not the count.
    if (r.retained !== 6) continue;
    kept += 1;
    const v = verdict(r);
    deltas.push(v.deltaPct);
    if (v.called) called += 1;
  }
  return {
    n: kept,
    mean: mean(deltas),
    called: (100 * called) / kept,
  };
}

// A budget that makes "retained 6 of 8" the common outcome, against a clean
// six-of-six run of the same model.
const BUDGET = 2 * SETUP_COST * 7 + PROVES * 2 * PROVE_COST * 7 * 1.2;

console.log(
  `truncation selection, ${TRIALS.toLocaleString()} trials per cell, ` +
    `threshold ±${THRESHOLD_PCT}%\n`
);
console.log("  run-level factor  | stopped at 6 of 8    | clean 6 of 6");
console.log("                    | mean delta   verdict | mean delta   verdict");
console.log("  " + "-".repeat(18) + "+" + "-".repeat(22) + "+" + "-".repeat(21));
for (const mode of ["neither", "both", "head-only", "base-only"]) {
  const cut = study(mode, BUDGET, 8);
  const full = study(mode, Infinity, 6);
  console.log(
    `  ${mode.padEnd(18)}| ${cut.mean.toFixed(2).padStart(7)}%  ${cut.called.toFixed(1).padStart(6)}% | ` +
      `${full.mean.toFixed(2).padStart(7)}%  ${full.called.toFixed(1).padStart(6)}%   ` +
      `(shift ${(cut.mean - full.mean).toFixed(2)}pp)`
  );
}

console.log(`
Reading this. The "shift" is the whole argument; the two other columns need care.

  "neither" and "both" are the symmetric cases, and the shift is a fifth of a
  point. The selection cancels exactly as Var(head) - Var(base) = 0 predicts, and
  it cancels even though this model has thermal drift and heavy tails — which is
  why "make the noise nastier" is not a way to break a paired design.

  "head-only" and "base-only" give one side a ${(SIGMA_RUN * 100).toFixed(0)}% run-level factor and nothing
  to the other. Truncation then shifts the mean by many points, in opposite
  directions — and the SHIFT is what the argument rests on, because it is the
  part truncation causes.

  The clean column of those two rows is not zero, and that is a different effect:
  a percentage of a noisy denominator is biased upward by roughly its variance
  (Jensen), so ${(SIGMA_RUN * 100).toFixed(0)}% run-level noise on the BASE side alone lifts the clean
  mean by about ${(SIGMA_RUN * SIGMA_RUN * 100).toFixed(2)}pp whether the run was cut short or not. At the real
  measured spread the same term is ~0.03pp, far under the floor, so it does not
  move a verdict — but it is why "base-only, clean" reads +1.4% rather than 0%.

  The verdict column is NOT a false-positive rate except in the "neither" row.
  Everywhere else this model contains a genuine per-run difference between the
  sides — that is what a run-level factor IS — so a verdict of "different" is
  often correct, and the high rates say the design has power, not that it lies.
  The null is the "neither" row: 0% called, as it should be.

  The SIZE of the shift depends on how much of the run the clock cuts; this
  budget is deliberately tight. A gentler truncation gives a smaller number. The
  sign and the symmetry structure do not depend on the budget, and those are what
  the decision rests on.

So the unbiasedness of a truncated comparison is not a property of the design. It
is a property of the two binaries having equal run-to-run variance, which nothing
has measured on this workload, and which a change to allocation or memory layout
could plausibly break. The renderer therefore reports a truncated run's numbers
and withholds the verdict — see verdictPreconditions in
.github/scripts/render-bench-comment.mjs. A complete run is unaffected: it has no
selection, so none of this applies to it.`);
