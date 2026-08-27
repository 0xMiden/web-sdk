// How the step's wall-clock budget decides whether a piece of work may start,
// and how long it is allowed.
//
// Split out of bench-proving.mjs for the same reason bench-order.mjs was: the
// rule kept being re-derived inline and kept coming out subtly wrong, three
// rounds of review in a row. The arithmetic is the whole defect surface, it needs
// no browser to exercise, and here it can be driven with a synthetic clock and
// pinned to the PROPERTY it has to satisfy rather than to a restatement of the
// expression.
//
// The property, which is the thing to hold onto:
//
//   Every request comes back as exactly one of three outcomes — refused, granted
//   the full ceiling, or granted less than the ceiling AND flagged as clamped.
//   There is no fourth, and in particular there is no "granted less than the
//   ceiling without saying so".
//
// That last shape is what the caller cannot survive. A deadline of 61s handed to
// work whose ceiling is 600s will usually blow, and the timeout that follows is
// indistinguishable — to the code and to the reader — from the process being
// genuinely wedged. The previous version scaled its REFUSAL to the ceiling but
// returned `min(ceiling, remaining)` regardless, so anything above the floor got
// silently squeezed by up to 10x and a budget shortfall was reported as a hang,
// discarding a run's measurements on the strength of a deadline the budget had
// manufactured.

/**
 * Raised when the budget cannot fund the work, and used by the driver to tell a
 * clock that ran out from a benchmark that broke — the two deserve opposite
 * outcomes, since running out of time should keep the repetitions already
 * measured while a wedged prover should discard them.
 */
export class BudgetExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * `.toFixed(0)` rounded the accepted minimum of 2.5 minutes to "3" and told the
 * user to raise a budget they had never passed.
 */
export const formatMinutes = (ms) => {
  const minutes = ms / 60000;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2);
};

/**
 * How much slack a grant needs over the work's realistic duration before a
 * timeout under it counts as evidence about the process.
 *
 * At 2, work that normally takes 90s must have been given at least 180s before a
 * timeout is called a hang. Below that the deadline is close enough to the real
 * duration that ordinary variance explains the overrun, so it says nothing.
 */
export const STARVATION_FACTOR = 2;

/**
 * The work this budget funds, as {ceiling, expected} pairs.
 *
 * Here rather than in bench-proving.mjs because the RATIO between the two is the
 * invariant `grantDeadline` enforces, and while the producer owned the constants
 * its test declared its own copies of them — so a retune that broke the scheme
 * could ship with the suite green. The producer is a top-level script and cannot
 * export, so the values had to move to be testable at all.
 *
 * Ceilings are generous because they bound a HANG, not a slow run: proving on a
 * loaded 8-core runner is single-digit seconds, and setup mints, proves a block
 * and syncs. Anything past a ceiling is not slow, it is stuck.
 *
 * Expected durations are estimates. They decide how a timeout is LABELLED, never
 * how long anything is allowed, and for setup the producer refines this from its
 * own measurements as the run proceeds — see `observedSetupExpectation`.
 */
export const SETUP_WORK = { ceiling: 10 * 60 * 1000, expected: 90 * 1000 };
export const PROVE_WORK = { ceiling: 5 * 60 * 1000, expected: 5 * 1000 };
// An empty round trip on an idle page. Its ceiling sits below the usual 60s
// budget floor, which is load-bearing: `grantDeadline` compares the floor against
// the ceiling, so this call only ever refuses outright or gets its full grant, and
// is therefore never clamped and never starved.
export const SETTLE_WORK = { ceiling: 30 * 1000, expected: 2 * 1000 };

/**
 * Decide what deadline `ceiling` may have, given `remaining` ms of usable budget.
 *
 * `floorMs` is the least a request may be granted: work is not started under a
 * deadline so short that it is certain to blow. It is compared against the
 * ceiling too, so a 30s barrier is not refused by a 60s floor.
 *
 * `expected` is the work's REALISTIC duration, which is a different quantity from
 * its ceiling and the distinction is the whole point of this function's return
 * shape. A ceiling bounds a hang and is therefore enormous — ten minutes for a
 * setup that takes ninety seconds, five for a prove that takes two. So "the
 * budget chose this number" (`clamped`) and "this number was too small for the
 * work" (`starved`) are nearly unrelated: across the clamped band, 96% of setup
 * grants and 100% of prove grants are LARGER than the work needs.
 *
 * Do not use `clamped` to decide what a timeout means, in either direction.
 * Reading it as a shortfall reports a deadlocked prover as the budget running out
 * and KEEPS the run, publishing measurements taken around a hang. Reading it as a
 * full ceiling calls a real shortfall a hang and throws away a complete set of
 * measurements. `starved` is the flag that answers the question actually being
 * asked.
 *
 * @returns {{refused: true, need: number}
 *   | {refused: false, ms: number, clamped: boolean, starved: boolean}}
 */
export function grantDeadline({ ceiling, remaining, floorMs, expected }) {
  for (const [name, value] of Object.entries({
    ceiling,
    remaining,
    floorMs,
    expected,
  })) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number, got ${value}`);
    }
  }
  if (ceiling <= 0 || floorMs <= 0 || expected <= 0) {
    throw new RangeError(
      `ceiling, floorMs and expected must be positive, got ceiling=${ceiling} ` +
        `floorMs=${floorMs} expected=${expected}`
    );
  }
  // `expected > ceiling` is the obvious error; `expected * STARVATION_FACTOR >
  // ceiling` is the one that actually breaks the scheme, and only this stronger
  // form is worth checking. Above it the FULL CEILING is starved, so no timeout
  // can ever be classified a hang — which resurrects the defect this function
  // exists to prevent: a deadlocked prover reported as the budget running out,
  // with its measurements kept and published.
  //
  // Reachable by following this repo's own instructions. bench.yml and
  // calibration.md both say to read the producer's `[budget]` line and resize
  // from it, and an `expected` raised past ceiling / STARVATION_FACTOR does
  // exactly this. Enforced here rather than merely tested, because a test can
  // only cover the profiles someone thought to add.
  if (expected * STARVATION_FACTOR > ceiling) {
    throw new RangeError(
      `expected (${expected}) is more than 1/${STARVATION_FACTOR} of ceiling ` +
        `(${ceiling}): above that the full ceiling counts as starved and nothing ` +
        `can be classified as a hang. Raise the ceiling, or lower expected below ` +
        `${ceiling / STARVATION_FACTOR}`
    );
  }

  const need = Math.min(ceiling, floorMs);
  if (remaining < need) return { refused: true, need };

  const ms = Math.min(ceiling, remaining);
  return {
    refused: false,
    ms,
    clamped: ms < ceiling,
    starved: ms < expected * STARVATION_FACTOR,
  };
}

/**
 * Bind `grantDeadline` to one run's budget, so the caller passes only the
 * ceiling and the expected duration.
 *
 * A factory rather than a closure inside the producer, because the producer is
 * ~1400 lines that need a browser to run and this is where four consecutive
 * rounds of review found a defect. Every one of them was in the WIRING — the
 * arithmetic was checked each time and the way its answer got used was not — so
 * the seam exists to let the wiring be driven with an injected clock.
 *
 * `now` is injectable for exactly that reason.
 *
 * @param {object} config
 * @param {number|null} config.budgetMs Total step budget, or null for no budget
 *   (a local run, where the ceilings stand alone).
 * @param {number} config.marginMs Reserved for the diagnostic and teardown.
 * @param {number} config.floorMs Least a request may be granted.
 * @param {number} config.startedAt Timestamp the run began.
 * @param {() => number} [config.now]
 */
export function createDeadlineFor({
  budgetMs,
  marginMs,
  floorMs,
  startedAt,
  now = Date.now,
}) {
  return (ceiling, expected) => {
    // The same SHAPE as the budgeted path, which matters more than it looks: the
    // call sites SPREAD this into the deadline options, and spreading a bare
    // number contributes no properties at all — `ms` would arrive undefined and
    // `setTimeout` would treat it as zero, timing out every step instantly while
    // reporting each one as wedged. That happened.
    if (budgetMs === null) {
      return { refused: false, ms: ceiling, clamped: false, starved: false };
    }

    const elapsed = now() - startedAt;
    const grant = grantDeadline({
      ceiling,
      expected,
      remaining: budgetMs - elapsed - marginMs,
      floorMs,
    });

    if (grant.refused) {
      throw new BudgetExhaustedError(
        `the ${formatMinutes(budgetMs)}-minute step budget is exhausted ` +
          `(${(elapsed / 60000).toFixed(1)} min elapsed, ` +
          `${(marginMs / 1000).toFixed(0)}s reserved for teardown, and the next ` +
          `step wants up to ${(grant.need / 1000).toFixed(0)}s), so the run is ` +
          `stopping here; raise --budget-minutes and the step's timeout-minutes ` +
          `together, or lower --reps / --proves`
      );
    }

    return grant;
  };
}

/**
 * Run `page.evaluate(fn, arg)` under a deadline, classifying a timeout.
 *
 * `starved` — NOT `clamped` — decides which error a timeout raises, and the
 * distinction is the whole reason both flags exist.
 *
 * `clamped` says the budget picked the number rather than the ceiling. That is a
 * fact about bookkeeping, not about the process, and branching on it here was
 * wrong in a way worth recording: a prove's ceiling is five minutes for work that
 * takes under two seconds, so EVERY clamped prove grant is at least twelve times
 * what the prove needs. So a genuinely deadlocked prover, timing out under a
 * 294-second deadline, was reported as the budget running out — told the reader in
 * as many words that it was "not a hang" — and the run was KEPT, publishing
 * measurements taken around a deadlock. That is the earlier defect with its sign
 * flipped: it stopped losing good numbers and started keeping bad ones.
 *
 * `starved` says the grant was short against the work's realistic duration, which
 * is the question that decides what a timeout means:
 *
 *   - Not starved: the work had comfortably more time than it needs, so a timeout
 *     is a hang. The run is broken and its numbers should be discarded.
 *   - Starved: the deadline itself explains the overrun, so nothing has been
 *     learned about the process. The run stops cleanly and keeps what it measured.
 */
export async function evaluateWithDeadline(
  page,
  fn,
  arg,
  { ms, what, starved }
) {
  // Checked because the failure mode is silent and total. `setTimeout` coerces a
  // non-number delay to zero, so a malformed `ms` does not throw — it times out
  // every step instantly and reports each one as wedged.
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new TypeError(
      `${what}: deadline must be a finite positive number of ms, got ${ms}. ` +
        `deadlineFor must return {ms, starved} on every path`
    );
  }

  let timer;
  try {
    return await Promise.race([
      page.evaluate(fn, arg),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              starved
                ? new BudgetExhaustedError(
                    `${what} did not finish within the ${ms} ms the step budget ` +
                      `had left for it. That is too close to what this step ` +
                      `normally takes for the overrun to say anything about the ` +
                      `run — it may have been stuck, or it may simply have needed ` +
                      `longer than the clock had — so the run stops here and keeps ` +
                      `the repetitions it already has, rather than discarding them ` +
                      `on a deadline the budget chose`
                  )
                : new Error(
                    `${what} did not finish within ${ms} ms — treating it as ` +
                      `wedged rather than waiting out the job timeout`
                  )
            ),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
