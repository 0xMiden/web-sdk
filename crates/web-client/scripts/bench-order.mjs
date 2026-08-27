/**
 * The benchmark's interleave, and the only place that decides it.
 *
 * Split out of bench-proving.mjs for one reason: the driver decided the order in
 * one place and the "your configuration is imbalanced" warning asserted a parity
 * formula in another, and the two silently disagreed for the entire life of the
 * benchmark. The prove-level flip was keyed on `(i + rep) % 2` while the open
 * order was already keyed on `rep % 2`, so both alternations turned on the same
 * bit and cancelled: base went first in one retained prove of three in EVERY
 * repetition at the calibrated default, and at `--proves 2` never at all. The
 * warning meanwhile reported the configuration as balanced, because its formula
 * described the design rather than the code.
 *
 * So the warning now COUNTS the order this module produces instead of restating
 * a parity rule about it. A future change to the interleave moves both together
 * or fails the test in bench-order.test.mjs.
 *
 * Two independent alternations, and independence is the whole point:
 *   - Which side's page is OPENED (and therefore set up) first alternates per
 *     repetition. Setup mints, proves a block and syncs; it is not timed, but it
 *     decides what the machine looks like when the timed proves start.
 *   - Which side PROVES first within a prove slot alternates per prove index.
 */

/** Base's page is opened and set up first on even repetitions. */
export const opensBaseFirst = (rep) => rep % 2 === 0;

/**
 * Odd prove slots run in reverse of the open order.
 *
 * Keyed on the prove index ALONE. Adding `rep` here is what cancelled the
 * repetition-level alternation, because the open order already carries it.
 */
export const proveSlotFlipped = (proveIndex) => proveIndex % 2 === 1;

/**
 * The side labels for one prove slot, in the order they will prove.
 *
 * `sides` must be in open order — i.e. as produced by the caller having already
 * applied `opensBaseFirst`.
 */
export function proveOrder(sides, proveIndex) {
  return proveSlotFlipped(proveIndex) ? [...sides].reverse() : sides;
}

/**
 * Count how the retained work actually splits, by simulating the real loop.
 *
 * Mirrors the driver's two discards: repetition 0 is a warm-up and prove 0 of
 * every page is discarded, so what has to balance is the RETAINED subset, not
 * every slot that ran.
 *
 * Returns per-repetition counts as well as aggregates, because a per-repetition
 * statistic gates the published verdict: an interleave can balance across a run
 * and still lean the same way inside every repetition the sign test reads.
 */
export function orderBalance({ reps, proves }) {
  let proveBaseFirst = 0;
  let proveTotal = 0;
  let setupBaseFirst = 0;
  const perRep = [];

  // Repetition 0 is the discarded warm-up, so the retained repetitions are
  // 1..reps and the parity they start on is what matters.
  for (let rep = 1; rep <= reps; rep++) {
    const baseOpensFirst = opensBaseFirst(rep);
    if (baseOpensFirst) setupBaseFirst += 1;
    const sides = baseOpensFirst ? ["base", "head"] : ["head", "base"];

    let baseFirst = 0;
    let total = 0;
    for (let i = 0; i < proves; i++) {
      // Prove 0 of every page pays JIT, allocator growth and the precompile
      // table fill, and is discarded. It still RUNS, so it still occupies a
      // slot — but it is not part of what has to balance.
      if (i === 0) continue;
      if (proveOrder(sides, i)[0] === "base") baseFirst += 1;
      total += 1;
    }

    perRep.push({ rep, baseFirst, total });
    proveBaseFirst += baseFirst;
    proveTotal += total;
  }

  return {
    proveBaseFirst,
    proveTotal,
    provesBalanced: proveBaseFirst * 2 === proveTotal,
    setupBaseFirst,
    setupTotal: reps,
    setupBalanced: setupBaseFirst * 2 === reps,
    // True only when every retained repetition is internally balanced, which is
    // stricter than the aggregate and is what the paired sign test would want.
    perRepBalanced: perRep.every((r) => r.baseFirst * 2 === r.total),
    perRep,
  };
}
