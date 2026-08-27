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
  BUDGET_FLOOR_MS,
  BudgetExhaustedError,
  createDeadlineFor,
  DeadlineExceededError,
  evaluateWithDeadline,
  formatMinutes,
  grantDeadline,
  PROVE_CEILING_MS,
  SETTLE_CEILING_MS,
  SETUP_CEILING_MS,
} from "./bench-budget.mjs";

const FLOOR = 60 * 1000;
// The REAL profiles, imported rather than restated. They used to be declared here
// as copies of constants in bench-proving.mjs, which meant a retune that broke the
// scheme shipped with this suite green — the values under test and the values that
// ship could drift silently, and that is the one class of defect these tests could
// not see.
const SETUP = { ceiling: SETUP_CEILING_MS };
const PROVE = { ceiling: PROVE_CEILING_MS };
const SETTLE = { ceiling: SETTLE_CEILING_MS };

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
      const got = grantDeadline({
        ceiling,
        remaining,
        floorMs: FLOOR,
      });

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
    const got = grantDeadline({
      ceiling,
      remaining,
      floorMs: FLOOR,
    });
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
    const got = grantDeadline({
      ceiling,
      remaining,
      floorMs: FLOOR,
    });
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
  const base = {
    ceiling: 1000,
    remaining: 1000,
    floorMs: FLOOR,
  };
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
  const got = grantDeadline({
    ceiling: 1000,
    remaining: 0,
    floorMs: FLOOR,
  });
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

// ---------------------------------------------------------------------------
// The WIRING. This is the part that mattered.
//
// Four consecutive review rounds found a defect in the deadline logic, and every
// one of them was here rather than in the arithmetic: the pure function was
// checked each time and the way its answer got USED was not. The specific four:
//
//   1. A flat floor aborted a 1.5s prove at a 10s deadline and called it wedged.
//   2. The refusal was scaled to the ceiling but the grant was not, so work was
//      silently squeezed and the timeout still called it wedged.
//   3. `deadlineFor` returned a bare number on the unbudgeted path while the call
//      sites spread it, so `ms` was undefined and every step timed out instantly.
//   4. A timeout was classified by `clamped`, which says who chose the number
//      rather than whether it was big enough — so a deadlocked prover under a
//      294-second deadline was reported as the budget running out, and its run
//      was kept.
//
// Each test below fails if its defect is reintroduced.
// ---------------------------------------------------------------------------

const CONFIG = {
  budgetMs: 20 * 60 * 1000,
  marginMs: 90 * 1000,
  floorMs: FLOOR,
  startedAt: 0,
};

/** A clock the test drives. */
const at = (elapsedMs) => ({ ...CONFIG, now: () => elapsedMs });

/** A page whose evaluate takes `durationMs`, or never resolves. */
const fakePage = (durationMs) => ({
  evaluate: () =>
    durationMs === Infinity
      ? new Promise(() => {})
      : new Promise((resolve) => setTimeout(() => resolve("ok"), durationMs)),
});

/** Every deadlineFor path must produce something spreadable. Defect 3. */
test("every deadlineFor path returns a spreadable grant, never a bare number", () => {
  const cases = [
    ["no budget (local run)", { ...CONFIG, budgetMs: null, now: () => 0 }],
    ["budget with room", at(0)],
    ["budget nearly gone", at(CONFIG.budgetMs - CONFIG.marginMs - 70 * 1000)],
  ];
  for (const [name, config] of cases) {
    const deadlineFor = createDeadlineFor(config);
    for (const [work, label] of [
      [SETUP, "setup"],
      [PROVE, "prove"],
      [SETTLE, "settle"],
    ]) {
      const opts = { ...deadlineFor(work.ceiling), what: label };
      assert.ok(
        Number.isFinite(opts.ms) && opts.ms > 0,
        `${name}/${label}: ms is ${opts.ms} after spreading`
      );
      assert.equal(
        typeof opts.clamped,
        "boolean",
        `${name}/${label}: clamped is ${opts.clamped} after spreading`
      );
    }
  }
});

/** A malformed deadline must throw loudly, not time out instantly. Defect 3. */
test("a malformed deadline is rejected rather than treated as zero", async () => {
  for (const ms of [undefined, NaN, 0, -1, "1000", null]) {
    await assert.rejects(
      () =>
        evaluateWithDeadline(fakePage(1), () => 0, undefined, {
          ms,
          what: "setup",
        }),
      TypeError,
      `accepted ms=${ms}`
    );
  }
});
test("work that finishes returns its value on every budget path", async () => {
  for (const config of [{ ...CONFIG, budgetMs: null, now: () => 0 }, at(0)]) {
    const deadlineFor = createDeadlineFor(config);
    const value = await evaluateWithDeadline(fakePage(1), () => 0, undefined, {
      ...deadlineFor(PROVE.ceiling),
      what: "prove",
    });
    assert.equal(value, "ok");
  }
});

/** The budget-exhaustion refusal names the budget the user passed. */
test("the refusal names the real budget, not a rounded one", () => {
  const deadlineFor = createDeadlineFor({
    ...CONFIG,
    budgetMs: 5.5 * 60 * 1000,
    now: () => 5.5 * 60 * 1000,
  });
  assert.throws(
    () => deadlineFor(SETUP.ceiling),
    (error) => {
      assert.ok(error instanceof BudgetExhaustedError);
      assert.match(error.message, /5\.50-minute/);
      return true;
    }
  );
});
test("the budget floor leaves the settle barrier whole", () => {
  // bench-budget.mjs documents the settle barrier as never getting a squeezed
  // grant, and that rests entirely on the floor being at least its ceiling. Below
  // it the barrier starts being handed shortened deadlines, and a barrier that
  // trips is treated as a reason to distrust the repetition.
  assert.ok(
    BUDGET_FLOOR_MS >= SETTLE_CEILING_MS,
    `floor ${BUDGET_FLOOR_MS} is below the settle ceiling ${SETTLE_CEILING_MS}`
  );
  for (let remaining = 0; remaining <= 40_000; remaining += 250) {
    const got = grantDeadline({
      ceiling: SETTLE_CEILING_MS,
      remaining,
      floorMs: BUDGET_FLOOR_MS,
    });
    if (got.refused) continue;
    assert.equal(
      got.clamped,
      false,
      `settle was clamped at remaining=${remaining}`
    );
  }
});

// ---------------------------------------------------------------------------
// A timeout says what happened and draws no conclusion.
//
// Six rounds of review went into a flag that tried to classify a timeout as
// either a hang or the clock running out, and every version was wrong in one
// direction or the other. The tests below pin the replacement: one error class,
// carrying facts, and the caller keeping what it measured either way.
//
// Reintroducing a classification would mean adding a branch here, which is
// exactly what these assert is absent.
// ---------------------------------------------------------------------------

const hangingPage = { evaluate: () => new Promise(() => {}) };

test("a timeout raises one error class whatever the deadline was", async () => {
  // The old code raised BudgetExhaustedError or a plain Error depending on a
  // guess. Both a full ceiling and a squeezed grant must now land the same way,
  // because the difference between them says nothing about why work did not
  // finish.
  for (const clamped of [false, true]) {
    await assert.rejects(
      () =>
        evaluateWithDeadline(hangingPage, () => 0, undefined, {
          ms: 5,
          what: "setup",
          clamped,
        }),
      DeadlineExceededError,
      `clamped=${clamped} produced a different error class`
    );
  }
});

test("a timeout carries the facts a reader needs, and no verdict", async () => {
  const error = await evaluateWithDeadline(hangingPage, () => 0, undefined, {
    ms: 5,
    what: "head rep 3 setup",
    clamped: true,
  }).catch((caught) => caught);

  assert.deepEqual(error.facts, {
    what: "head rep 3 setup",
    deadlineMs: 5,
    clamped: true,
  });
  // The message must not assert WHICH it was. The old text did, in both
  // directions — "treating it as wedged" and "not a hang" — and each was
  // misleading exactly when the guess went the wrong way. Naming the possibility
  // ("whether it was stuck or just needed longer") is the opposite of claiming it.
  for (const claim of [
    "treating it as wedged",
    "not a hang",
    "the budget running out",
  ]) {
    assert.ok(
      !error.message.includes(claim),
      `the message still asserts "${claim}"`
    );
  }
  assert.match(error.message, /Whether it was stuck or just needed longer/);
  assert.match(error.message, /keeps the repetitions it already has/);
  // A sub-second deadline must not render as "0s".
  assert.match(error.message, /within 5ms/);
});

test("a refusal is still distinct from a timeout, because it is certain", async () => {
  // The one thing that IS knowable: the arithmetic was done before anything ran,
  // so "the budget could not fund this" is a fact. Keeping it separate is what
  // lets the diagnostic say which happened without guessing.
  const deadlineFor = createDeadlineFor({
    budgetMs: 10 * 60 * 1000,
    marginMs: 90 * 1000,
    floorMs: BUDGET_FLOOR_MS,
    startedAt: 0,
    now: () => 10 * 60 * 1000,
  });
  assert.throws(() => deadlineFor(SETUP_CEILING_MS), BudgetExhaustedError);
  assert.ok(
    !(new BudgetExhaustedError("x") instanceof DeadlineExceededError),
    "the two error classes must not be confusable"
  );
});

test("no grant carries a classification field any more", () => {
  // A regression guard on the deletion itself: if a `starved`-shaped flag comes
  // back, it will come back here first.
  const deadlineFor = createDeadlineFor({
    budgetMs: 45 * 60 * 1000,
    marginMs: 90 * 1000,
    floorMs: BUDGET_FLOOR_MS,
    startedAt: 0,
    now: () => 40 * 60 * 1000,
  });
  for (const ceiling of [
    SETUP_CEILING_MS,
    PROVE_CEILING_MS,
    SETTLE_CEILING_MS,
  ]) {
    const grant = grantDeadline({
      ceiling,
      remaining: 200_000,
      floorMs: BUDGET_FLOOR_MS,
    });
    assert.deepEqual(
      Object.keys(grant).sort(),
      ["clamped", "ms", "refused"],
      `grantDeadline grew a field for ceiling=${ceiling}`
    );
  }
  assert.deepEqual(Object.keys(deadlineFor(SETTLE_CEILING_MS)).sort(), [
    "clamped",
    "ms",
    "refused",
  ]);
});
