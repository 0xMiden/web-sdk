// Tests for the step-budget deadline rule.
//
// Run with `node --test crates/web-client/scripts/bench-budget.test.mjs` or
// `make test-bench-scripts`.
//
// Written against the PROPERTY rather than the expression, deliberately. Three
// consecutive review rounds found a defect in this arithmetic, and each previous
// fix was checked by reasoning about one configuration — which is exactly how the
// adjacent configuration stayed broken. The first test below sweeps the whole
// space and would have caught every one of them.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BudgetExhaustedError,
  formatMinutes,
  grantDeadline,
} from "./bench-budget.mjs";

const FLOOR = 60 * 1000;

// The real ceilings, plus the degenerate ones around them.
const CEILINGS = [
  1,
  1000,
  30 * 1000, // settle barrier
  FLOOR,
  FLOOR + 1,
  5 * 60 * 1000, // prove
  10 * 60 * 1000, // setup
  60 * 60 * 1000,
];

test("every grant is refused, full, or clamped-and-flagged — never a fourth thing", () => {
  for (const ceiling of CEILINGS) {
    for (let remaining = 0; remaining <= ceiling + 2000; remaining += 250) {
      const got = grantDeadline({ ceiling, remaining, floorMs: FLOOR });

      if (got.refused) {
        // Only ever because there is less left than the smaller of the two.
        assert.ok(
          remaining < Math.min(ceiling, FLOOR),
          `refused with ${remaining}ms left against ceiling ${ceiling}`
        );
        continue;
      }

      assert.ok(got.ms > 0, `granted ${got.ms}ms for ceiling ${ceiling}`);
      assert.ok(
        got.ms <= ceiling,
        `granted ${got.ms}ms, more than the ${ceiling}ms ceiling`
      );
      assert.ok(
        got.ms <= remaining,
        `granted ${got.ms}ms with only ${remaining}ms left`
      );

      // THE invariant. A short deadline is survivable; a short deadline the
      // caller believes is the full ceiling is not, because the timeout under it
      // gets reported as a hang and costs the run its measurements.
      assert.equal(
        got.clamped,
        got.ms < ceiling,
        `ceiling ${ceiling} with ${remaining}ms left granted ${got.ms}ms but ` +
          `reported clamped=${got.clamped}`
      );
    }
  }
});

// The specific regression: a 600s ceiling with 61s left used to be granted 61ms
// short of the ceiling with nothing said about it, so the caller treated the
// inevitable timeout as a wedged process and discarded the artifact.
test("a ceiling far above the remaining budget is flagged, not silently squeezed", () => {
  const ceiling = 10 * 60 * 1000;
  for (const remaining of [61 * 1000, 70 * 1000, 120 * 1000, 400 * 1000]) {
    const got = grantDeadline({ ceiling, remaining, floorMs: FLOOR });
    assert.equal(got.refused, false);
    assert.equal(got.ms, remaining);
    assert.equal(
      got.clamped,
      true,
      `${remaining}ms granted against a ${ceiling}ms ceiling was not flagged`
    );
  }
});

test("a ceiling the budget can fully fund is not flagged", () => {
  const ceiling = 30 * 1000;
  for (const remaining of [ceiling, ceiling + 1, 20 * 60 * 1000]) {
    const got = grantDeadline({ ceiling, remaining, floorMs: FLOOR });
    assert.equal(got.refused, false);
    assert.equal(got.ms, ceiling);
    assert.equal(got.clamped, false);
  }
});

// The floor is compared against the ceiling, not applied flatly: a 30s barrier
// refused because 60s was not available was the round-12 defect.
test("the refusal scales to the ceiling, so small work is not blocked by the floor", () => {
  const settle = 30 * 1000;
  const got = grantDeadline({
    ceiling: settle,
    remaining: 31 * 1000,
    floorMs: FLOOR,
  });
  assert.equal(got.refused, false);
  assert.equal(got.ms, settle);
  assert.equal(got.clamped, false);

  // And a prove, whose ceiling exceeds the floor, IS refused at the same moment.
  assert.equal(
    grantDeadline({
      ceiling: 5 * 60 * 1000,
      remaining: 31 * 1000,
      floorMs: FLOOR,
    }).refused,
    true
  );
});

test("refusal reports what the work needed, for the diagnostic", () => {
  const got = grantDeadline({
    ceiling: 10 * 60 * 1000,
    remaining: 0,
    floorMs: FLOOR,
  });
  assert.equal(got.refused, true);
  assert.equal(got.need, FLOOR);

  const small = grantDeadline({
    ceiling: 10 * 1000,
    remaining: 0,
    floorMs: FLOOR,
  });
  assert.equal(small.need, 10 * 1000);
});

test("nonsensical inputs are refused rather than coerced", () => {
  const base = { ceiling: 1000, remaining: 1000, floorMs: FLOOR };
  for (const bad of [NaN, Infinity, -Infinity, "1000", null, undefined]) {
    for (const key of ["ceiling", "remaining", "floorMs"]) {
      assert.throws(
        () => grantDeadline({ ...base, [key]: bad }),
        TypeError,
        `accepted ${key}=${bad}`
      );
    }
  }
  assert.throws(() => grantDeadline({ ...base, ceiling: 0 }), RangeError);
  assert.throws(() => grantDeadline({ ...base, floorMs: -1 }), RangeError);
});

test("a zero remaining budget refuses rather than granting nothing", () => {
  const got = grantDeadline({ ceiling: 1000, remaining: 0, floorMs: FLOOR });
  assert.equal(got.refused, true);
});

test("formatMinutes states the budget it was given", () => {
  assert.equal(formatMinutes(20 * 60 * 1000), "20");
  assert.equal(formatMinutes(2.5 * 60 * 1000), "2.50");
  assert.equal(formatMinutes(5.5 * 60 * 1000), "5.50");
  // The bug it exists for: `.toFixed(0)` reported 2.5 as "3".
  assert.notEqual(formatMinutes(2.5 * 60 * 1000), "3");
});

test("the budget error is identifiable across the module boundary", () => {
  const error = new BudgetExhaustedError("out of time");
  assert.ok(error instanceof BudgetExhaustedError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "BudgetExhaustedError");
});
