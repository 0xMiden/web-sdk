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
 * Decide what deadline `ceiling` may have, given `remaining` ms of usable budget.
 *
 * `floorMs` is the least a request may be granted: work is not started under a
 * deadline so short that it is certain to blow. It is compared against the
 * ceiling too, so a 30s barrier is not refused by a 60s floor.
 *
 * @returns {{refused: true, need: number} | {refused: false, ms: number, clamped: boolean}}
 *   `clamped` means the budget, not the ceiling, chose the number — so a timeout
 *   under it is a budget shortfall and must NOT be reported as a hang.
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
