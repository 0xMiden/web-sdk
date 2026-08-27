/**
 * The benchmark's interleave, and the only place that decides it.
 *
 * Split out of bench-proving.mjs because the order was decided in one place and
 * ASSERTED in another: the driver ran the interleave, while the "your
 * configuration is imbalanced" warning restated a parity rule that was supposed
 * to describe it. Nothing tied the two together, so the warning could go on
 * reporting a configuration as balanced after a change to the interleave made it
 * anything but. The warning now COUNTS the order this module produces, and a
 * future change to the interleave either moves both together or fails
 * bench-order.test.mjs.
 *
 * The order itself is unchanged by the split, and `bench-order.test.mjs` pins
 * that: an earlier revision computed it as a canonical [base, head] flipped on
 * `(i + rep) % 2`, and this one composes the alternating open order with a flip
 * on `i % 2`. Those are the same function — both alternations still turn on both
 * bits — which is the property the tests check rather than the formula.
 *
 * Two independent alternations, and independence is the whole point:
 *   - Which side's page is OPENED (and therefore set up) first alternates per
 *     repetition. Setup mints, proves a block and syncs; it is not timed, but it
 *     decides what the machine looks like when the timed proves start.
 *   - Which side PROVES first within a prove slot alternates per prove index.
 *     Keyed on the prove index alone BECAUSE the open order it is applied to
 *     already carries the repetition parity; adding `rep` here as well would
 *     turn the same bit twice and cancel it.
 */

/** Base's page is opened and set up first on even repetitions. */
export const opensBaseFirst = (rep) => rep % 2 === 0;

/**
 * Odd prove slots run in reverse of the open order.
 *
 * Keyed on the prove index ALONE: the `sides` this is applied to are in open
 * order, which already alternates per repetition, so the composition of the two
 * carries both bits. Adding `rep` here as well would turn the same bit twice.
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

/**
 * The largest number of retained repetitions at or below `measured` that keeps the
 * setup order balanced.
 *
 * `opensBaseFirst` alternates on repetition parity, so an even count runs base
 * first exactly as often as head first and an odd count cannot: at three
 * repetitions one side has set up on an idle machine twice and the other once.
 * That is a FIXED positional asymmetry, the one class of error repetitions do not
 * average out — the reason the order alternates at all — so a run that has to stop
 * short gives up its odd tail rather than biasing every repetition it kept.
 *
 * Lives here because it is the same contract `opensBaseFirst` implements: change
 * the alternation and this rule changes with it.
 */
export function balancedRetainedReps(measured) {
  if (!Number.isInteger(measured) || measured < 0) {
    throw new TypeError(
      `measured repetitions must be a non-negative integer, got ${measured}`
    );
  }
  return measured - (measured % 2);
}
