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
// genuinely wedged. So the grant says whether the budget chose it.
//
// WHAT THIS DELIBERATELY DOES NOT DO is guess WHY a timeout happened. Six rounds
// of review went into a flag that tried: it compared the grant against a predicted
// duration and called the timeout either a hang (discard the run) or the clock
// running out (keep it). Every version was wrong in one direction or the other,
// because the question it answered — "is the grant below 2x what I predict?" —
// is not the question that decides — "is the grant below what the work actually
// needed?" — and the band between a prediction and an outcome cannot be closed by
// choosing a better predictor. The last attempt used the median of measured
// durations, which is the right statistic and still reproduces the original defect
// at the second setup of a run, where one sample makes the median a maximum.
//
// A timeout now raises one error, the caller keeps what it measured, and the facts
// go in the artifact. The renderer already withholds the verdict from any run that
// stopped early, so nothing measured around a hang can be published AS A VERDICT —
// which is the outcome the guessing existed to prevent, achieved by a check that
// does not have to guess.

/**
 * The median of some measured durations, rounded to whole ms.
 *
 * Robust where the mean and the max are not: one slow sample moves those and not
 * this. Here rather than in the producer because the producer is a top-level
 * script that nothing can import, and the rule this replaced spent seven review
 * rounds broken partly because it lived there untested. `NaN` on empty input, so
 * callers must check — there is no meaningful median of nothing, and a sentinel
 * would end up rendered.
 */
export function medianOf(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.round(
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  );
}

/**
 * Raised BEFORE work starts, when the arithmetic shows the budget cannot fund it.
 *
 * Distinct from `DeadlineExceededError` because this one is certain: the numbers
 * were compared before anything ran, so "the clock ran out" is a fact rather than
 * an inference. Nothing about the benchmark is implicated.
 */
export class BudgetExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Raised when work that started did not finish inside its deadline.
 *
 * Carries the facts and draws no conclusion, because none is available: the work
 * may have been stuck, or the deadline may simply have been shorter than it needed.
 * The caller keeps its measurements either way and the artifact records what
 * happened, so a reader can settle in seconds what six rounds of review could not
 * settle in code.
 */
export class DeadlineExceededError extends Error {
  constructor(headline, message, facts) {
    super(message);
    this.name = "DeadlineExceededError";
    // What happened, with none of the reassurance the full message carries. The
    // caller pastes that message into contexts where no repetition survived, and
    // "keeps the repetitions it already has" contradicts itself there.
    this.headline = headline;
    this.facts = facts;
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
 * The ceiling on each piece of work: what bounds a HANG, not what the work takes.
 *
 * Generous on purpose. Proving on a loaded 8-core runner is single-digit seconds,
 * and setup mints, proves a block and syncs. Anything past a ceiling is not slow,
 * it is stuck — but see the header: reaching one is not treated as proof of that.
 *
 * Here rather than in bench-proving.mjs because the producer is a top-level script
 * that cannot export, so while it owned these the test declared its own copies and
 * a retune could ship with the suite green.
 */
export const SETUP_CEILING_MS = 10 * 60 * 1000;
export const PROVE_CEILING_MS = 5 * 60 * 1000;
// An empty round trip on an idle page. Below BUDGET_FLOOR_MS, which is
// load-bearing: `grantDeadline` compares the floor against the ceiling, so this
// call is either refused outright or granted whole, and is therefore never
// clamped. Asserted in the test.
export const SETTLE_CEILING_MS = 30 * 1000;

/**
 * The floor and margin the producer runs its budget with.
 *
 * Here rather than in the producer because `BUDGET_FLOOR_MS >= SETTLE_CEILING_MS`
 * is load-bearing — it is what makes a settle grant either refused outright or
 * whole, hence never clamped. A test asserts the relation, which it could not do
 * while these were producer-local copies.
 */
export const BUDGET_FLOOR_MS = 60 * 1000;
export const BUDGET_MARGIN_MS = 90 * 1000;

/**
 * Decide what deadline `ceiling` may have, given `remaining` ms of usable budget.
 *
 * `floorMs` is the least a request may be granted: work is not started under a
 * deadline so short that it is certain to blow. It is compared against the
 * ceiling too, so a 30s barrier is not refused by a 60s floor.
 *
 * `clamped` says the budget picked the number rather than the ceiling. It is
 * bookkeeping, for the diagnostic — do NOT read it as "the work was given too
 * little". A prove's ceiling is five minutes for work taking under two seconds, so
 * every clamped prove grant is still at least twelve times what a prove needs.
 * Treating it as a shortfall is how a deadlocked prover came to be reported as the
 * budget running out.
 *
 * @returns {{refused: true, need: number}
 *   | {refused: false, ms: number, clamped: boolean}}
 */
export function grantDeadline({ ceiling, remaining, floorMs }) {
  for (const [name, value] of Object.entries({ ceiling, remaining, floorMs })) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number, got ${value}`);
    }
  }
  if (ceiling <= 0 || floorMs <= 0) {
    throw new RangeError(
      `ceiling and floorMs must be positive, got ceiling=${ceiling} floorMs=${floorMs}`
    );
  }

  const need = Math.min(ceiling, floorMs);
  if (remaining < need) return { refused: true, need };

  const ms = Math.min(ceiling, remaining);
  return { refused: false, ms, clamped: ms < ceiling };
}

/**
 * Bind `grantDeadline` to one run's budget, so the caller passes only a ceiling.
 *
 * MONOTONIC clock by default, and the caller must not substitute a wall clock. An
 * NTP step backwards inflates `remaining`, which grants a deadline past the step
 * cap and lets the runner kill the step outright — no artifact, no diagnostic,
 * which is the exact outcome the clamp exists to prevent. The injectable seam is
 * for tests, which pass a counter.
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
  now = () => performance.now(),
}) {
  return (ceiling) => {
    // The same SHAPE as the budgeted path, which matters more than it looks: the
    // call sites SPREAD this into the deadline options, and spreading a bare
    // number contributes no properties at all — `ms` would arrive undefined and
    // `setTimeout` would treat it as zero, timing out every step instantly while
    // reporting each one as wedged. That happened.
    if (budgetMs === null) {
      return { refused: false, ms: ceiling, clamped: false };
    }

    const elapsed = now() - startedAt;
    const grant = grantDeadline({
      ceiling,
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
 * Run `page.evaluate(fn, arg)` under a deadline.
 *
 * Playwright's `evaluate` takes no timeout and is not covered by
 * `setDefaultTimeout` — only navigation and locator calls are. So a prove that
 * wedges inside wasm hangs forever, and the only thing that eventually notices is
 * the job-level timeout, which kills the run without a diagnostic and after burning
 * the rest of the budget. A rayon deadlock in the prover is precisely the change
 * class this benchmark exists to catch, so the head build hanging is an expected
 * case rather than an exotic one.
 *
 * A timeout raises `DeadlineExceededError` and says what happened without saying
 * why. See the header for why no version of "why" survived review.
 *
 * The race leaves the evaluate running — there is no way to cancel it — but the
 * context close in the caller's teardown takes the page down with it.
 */
export async function evaluateWithDeadline(
  page,
  fn,
  arg,
  { ms, what, clamped }
) {
  // Checked because the failure mode is silent and total. `setTimeout` coerces a
  // non-number delay to zero, so a malformed `ms` does not throw — it times out
  // every step instantly and reports each one as wedged.
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new TypeError(
      `${what}: deadline must be a finite positive number of ms, got ${ms}. ` +
        `deadlineFor must return {ms} on every path`
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
              (() => {
                const headline =
                  `${what} did not finish within ` +
                  `${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(0)}s`}` +
                  (clamped
                    ? ", the time the step budget had left for it"
                    : ", its full ceiling");
                return new DeadlineExceededError(
                  headline,
                  `${headline}. The run stops here and keeps the repetitions it ` +
                    `already has. Whether it was stuck or just needed longer than ` +
                    `the clock had is not something this can tell you — the ` +
                    `artifact records the deadline and the measured setup cost ` +
                    `so you can.`,
                  { what, deadlineMs: ms, clamped: Boolean(clamped) }
                );
              })()
            ),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounds a Playwright call that `setDefaultTimeout` does not reach.
 *
 * Only `goto` honours the context timeouts — it is a page operation.
 * `browser.newContext()` and `context.newPage()` are protocol round trips that
 * ignore both settings, and `newContext` necessarily runs before there is a
 * context to configure. A browser wedged at either one therefore hung until the
 * runner killed the step: no early stop, no artifact, and every completed
 * repetition lost, which is the failure the early-stop machinery exists to
 * prevent.
 *
 * `closeLate` wraps the late winner's close, so the producer can put it under
 * the same abandonment accounting as every other close it owns; the default is
 * the bare close, for callers with no such accounting.
 *
 * A late winner is closed rather than leaked — the call can still succeed after
 * the race is lost, handing back a context nobody holds a reference to.
 */
export async function withPlaywrightDeadline(
  label,
  ms,
  start,
  closeLate = (_label, closing) => closing
) {
  // Same guard, and for the same reason, as `evaluateWithDeadline`: `setTimeout`
  // coerces a non-number delay to zero rather than throwing, so a malformed `ms`
  // does not fail loudly — it refuses every call instantly and reports each one
  // as a wedged browser. `ms` now arrives from `deadlineFor` rather than from a
  // constant, so that is a live path rather than a typo.
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new TypeError(
      `${label}: deadline must be a finite positive number of ms, got ${ms}. ` +
        `deadlineFor must return {ms} on every path`
    );
  }
  let timer;
  let timedOut = false;
  const pending = start();
  // Attached before the race, so the late-winner path is armed even if the race
  // throws synchronously.
  //
  // The `.catch` is belt and braces, not the thing standing between a late
  // rejection and a process death: `Promise.race` subscribes to EVERY element,
  // so a loser that rejects later is already handled. It is kept because this
  // chain is a second, independent subscription to `pending` — one the race
  // knows nothing about — and that one does need its own handler.
  //
  // Through the caller's wrapper, because the resource being closed belongs to
  // the browser that just lost the race by wedging. An unbounded close here hung
  // forever without being counted, so the producer reached its exit path
  // believing every resource had been released and waited on a handle nothing
  // would settle — precisely the hang its abandonment count exists to escape.
  pending
    .then((won) => {
      if (timedOut && won && typeof won.close === "function") {
        return closeLate(`late ${label}`, won.close());
      }
      return undefined;
    })
    .catch(() => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new DeadlineExceededError(
              `${label} did not return within ${ms / 1000}s`,
              `${label} did not return within ${ms / 1000}s. The run keeps the ` +
                `repetitions it already finished and stops here.`,
              { deadlineMs: ms }
            )
          );
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
