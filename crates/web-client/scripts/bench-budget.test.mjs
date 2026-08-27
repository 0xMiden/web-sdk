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
  evaluateWithDeadline,
  expectedFrom,
  formatMinutes,
  grantDeadline,
  PROVE_WORK,
  SETTLE_WORK,
  SETUP_WORK,
  STARVATION_FACTOR,
} from "./bench-budget.mjs";

const FLOOR = 60 * 1000;
// The REAL profiles, imported rather than restated. They used to be declared here
// as copies of constants in bench-proving.mjs, which meant a retune that broke the
// scheme shipped with this suite green — the values under test and the values that
// ship could drift silently, and that is the one class of defect these tests could
// not see.
const SETUP = SETUP_WORK;
const PROVE = PROVE_WORK;
const SETTLE = SETTLE_WORK;

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
        expected: ceiling / 4,
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
      expected: ceiling / 4,
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
      expected: ceiling / 4,
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
    expected: 2000,
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
      expected: 5000,
    }).refused,
    true
  );
});

// `starved` is what the caller actually needs to know, and it is a different
// question from `clamped`. These are separated because conflating them was a live
// defect in both directions: reading `clamped` as a shortfall reclassified a real
// hang as the budget running out (and kept a run built around a deadlock), while
// reading it as a full ceiling threw away complete measurements over a genuine
// shortfall.
test("starved is about the work's real duration, not about who chose the number", () => {
  // A prove's ceiling is 300s for a 5s prove, and the floor guarantees at least
  // 60s. So a prove can be clamped across almost the whole band while never once
  // being short of time — every clamped prove grant is at least 12x what it needs.
  for (const remaining of [60 * 1000, 120 * 1000, 299 * 1000]) {
    const got = grantDeadline({ ...PROVE, remaining, floorMs: FLOOR });
    assert.equal(got.clamped, true, `${remaining}ms was not clamped`);
    assert.equal(
      got.starved,
      false,
      `a ${got.ms}ms grant for a ${PROVE.expected}ms prove was called starved`
    );
  }
});

test("a grant genuinely short of the work's duration is starved", () => {
  // A setup needs ~90s, so anything under 180s is not evidence about the process.
  for (const remaining of [60 * 1000, 100 * 1000, 179 * 1000]) {
    const got = grantDeadline({ ...SETUP, remaining, floorMs: FLOOR });
    assert.equal(got.starved, true, `${got.ms}ms for a setup was not starved`);
  }
  // And above the slack factor it is not.
  for (const remaining of [181 * 1000, 400 * 1000, 599 * 1000]) {
    const got = grantDeadline({ ...SETUP, remaining, floorMs: FLOOR });
    assert.equal(got.clamped, true, `${got.ms}ms was not clamped`);
    assert.equal(got.starved, false, `${got.ms}ms for a setup was starved`);
  }
});

test("starved is exactly the slack threshold, over the whole space", () => {
  for (const work of [SETUP, PROVE, SETTLE]) {
    for (
      let remaining = 0;
      remaining <= work.ceiling + 2000;
      remaining += 250
    ) {
      const got = grantDeadline({ ...work, remaining, floorMs: FLOOR });
      if (got.refused) continue;
      // Asserted against the definition, independently of the expression.
      assert.equal(
        got.starved,
        got.ms < work.expected * STARVATION_FACTOR,
        `ceiling ${work.ceiling} expected ${work.expected} granted ${got.ms} ` +
          `reported starved=${got.starved}`
      );
      // The two flags are independent: neither implies the other.
      if (got.starved) {
        assert.ok(
          got.ms < work.expected * STARVATION_FACTOR,
          "starved without being short"
        );
      }
    }
  }
});

// The full ceiling is never starved, for any of the real work. If it were, the
// ceiling would be too tight to bound a hang and the whole scheme would be
// unable to call anything a hang.
test("a full ceiling is never starved", () => {
  for (const work of [SETUP, PROVE, SETTLE]) {
    const got = grantDeadline({
      ...work,
      remaining: 60 * 60 * 1000,
      floorMs: FLOOR,
    });
    assert.equal(got.clamped, false);
    assert.equal(got.starved, false);
  }
});

test("an expected duration above the ceiling is a configuration error", () => {
  assert.throws(
    () =>
      grantDeadline({
        ceiling: 1000,
        expected: 2000,
        remaining: 5000,
        floorMs: FLOOR,
      }),
    RangeError
  );
});

// Above ceiling / STARVATION_FACTOR the FULL CEILING is starved, so no timeout can
// ever be called a hang — which resurrects the defect the flag exists to prevent.
// Guarded rather than merely tested, because a test only covers the profiles
// someone thought to add, and this is reachable by following the repo's own
// instructions to resize `expected` from a real run's measurements.
test("an expected duration past the slack ratio is refused, not silently accepted", () => {
  // Just inside is fine; just past is not.
  assert.doesNotThrow(() =>
    grantDeadline({
      ceiling: 600 * 1000,
      expected: 300 * 1000,
      remaining: 600 * 1000,
      floorMs: FLOOR,
    })
  );
  for (const expected of [300 * 1000 + 1, 320 * 1000, 599 * 1000]) {
    assert.throws(
      () =>
        grantDeadline({
          ceiling: 600 * 1000,
          expected,
          remaining: 600 * 1000,
          floorMs: FLOOR,
        }),
      RangeError,
      `expected=${expected} was accepted against a 600s ceiling`
    );
  }
});

// The profiles that actually ship have to satisfy the invariant, or the producer
// throws on its first deadline request.
test("every shipped work profile leaves room to detect a hang", () => {
  for (const [name, work] of Object.entries({
    SETUP_WORK,
    PROVE_WORK,
    SETTLE_WORK,
  })) {
    assert.ok(
      work.expected * STARVATION_FACTOR <= work.ceiling,
      `${name}: expected ${work.expected} x ${STARVATION_FACTOR} exceeds ceiling ${work.ceiling}`
    );
    // And the full ceiling must not be starved, which is the same statement from
    // the caller's side.
    const got = grantDeadline({
      ...work,
      remaining: 10 * 60 * 60 * 1000,
      floorMs: FLOOR,
    });
    assert.equal(
      got.starved,
      false,
      `${name}: full ceiling reported as starved`
    );
  }
});

test("refusal reports what the work needed, for the diagnostic", () => {
  const got = grantDeadline({
    ceiling: 10 * 60 * 1000,
    remaining: 0,
    floorMs: FLOOR,
    expected: 90 * 1000,
  });
  assert.equal(got.refused, true);
  assert.equal(got.need, FLOOR);

  const small = grantDeadline({
    ceiling: 10 * 1000,
    remaining: 0,
    floorMs: FLOOR,
    expected: 5 * 1000,
  });
  assert.equal(small.need, 10 * 1000);
});

test("nonsensical inputs are refused rather than coerced", () => {
  const base = {
    ceiling: 1000,
    remaining: 1000,
    floorMs: FLOOR,
    expected: 500,
  };
  for (const bad of [NaN, Infinity, -Infinity, "1000", null, undefined]) {
    for (const key of ["ceiling", "remaining", "floorMs", "expected"]) {
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
    expected: 500,
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
      const opts = { ...deadlineFor(work.ceiling, work.expected), what: label };
      assert.ok(
        Number.isFinite(opts.ms) && opts.ms > 0,
        `${name}/${label}: ms is ${opts.ms} after spreading`
      );
      assert.equal(
        typeof opts.starved,
        "boolean",
        `${name}/${label}: starved is ${opts.starved} after spreading`
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

/**
 * A hang under a generous deadline is a hang, however the number was chosen.
 * Defect 4 — this is the one that let a deadlocked prover be reported as a budget
 * stop and its measurements kept.
 */
test("a hang under a generous deadline is a wedge, even when clamped", async () => {
  // 200 seconds left. A prove needs 5, so this is clamped (the budget chose 200
  // rather than the 300s ceiling) but 40x what the work needs.
  const deadlineFor = createDeadlineFor(
    at(CONFIG.budgetMs - CONFIG.marginMs - 200 * 1000)
  );
  const grant = deadlineFor(PROVE.ceiling, PROVE.expected);
  assert.equal(grant.clamped, true, "expected this grant to be clamped");
  assert.equal(
    grant.starved,
    false,
    "a 200s grant for a 5s prove is not starved"
  );

  // Shrink the deadline for test speed while keeping the classification.
  const error = await evaluateWithDeadline(
    fakePage(Infinity),
    () => 0,
    undefined,
    { ...grant, ms: 20, what: "head rep 3 prove" }
  ).then(
    () => null,
    (e) => e
  );
  assert.ok(error, "a permanent hang resolved");
  assert.ok(
    !(error instanceof BudgetExhaustedError),
    `a deadlocked prover was classified as a budget stop: ${error.message}`
  );
  assert.match(error.message, /wedged/);
});

/** A genuine shortfall stops the run cleanly. Defects 1 and 2. */
test("a timeout under a starved deadline is a budget stop, not a wedge", async () => {
  // 100 seconds left against a setup that needs 90 — under the slack factor, so
  // the overrun says nothing about the process.
  const deadlineFor = createDeadlineFor(
    at(CONFIG.budgetMs - CONFIG.marginMs - 100 * 1000)
  );
  const grant = deadlineFor(SETUP.ceiling, SETUP.expected);
  assert.equal(grant.starved, true, "a 100s grant for a 90s setup is starved");

  const error = await evaluateWithDeadline(
    fakePage(Infinity),
    () => 0,
    undefined,
    { ...grant, ms: 20, what: "head rep 3 setup" }
  ).then(
    () => null,
    (e) => e
  );
  assert.ok(
    error instanceof BudgetExhaustedError,
    `got ${error?.constructor.name}`
  );
  // And it must not claim to know which it was.
  assert.doesNotMatch(error.message, /not a hang/);
});

/** A prove is never aborted below its own duration. Defect 1. */
test("no grant is ever below the work's own duration for the real ceilings", () => {
  for (const work of [SETUP, PROVE, SETTLE]) {
    for (let leftS = 0; leftS <= 1200; leftS += 1) {
      const deadlineFor = createDeadlineFor(
        at(CONFIG.budgetMs - CONFIG.marginMs - leftS * 1000)
      );
      let grant;
      try {
        grant = deadlineFor(work.ceiling, work.expected);
      } catch (error) {
        assert.ok(error instanceof BudgetExhaustedError);
        continue;
      }
      // Either the work got a usable deadline, or it was refused outright. What
      // must never happen is being started under a deadline below the floor.
      assert.ok(
        grant.ms >= Math.min(work.ceiling, FLOOR),
        `${work.ceiling}ms ceiling granted ${grant.ms}ms with ${leftS}s left`
      );
    }
  }
});

/** Work that completes in time is unaffected by any of this. */
test("work that finishes returns its value on every budget path", async () => {
  for (const config of [{ ...CONFIG, budgetMs: null, now: () => 0 }, at(0)]) {
    const deadlineFor = createDeadlineFor(config);
    const value = await evaluateWithDeadline(fakePage(1), () => 0, undefined, {
      ...deadlineFor(PROVE.ceiling, PROVE.expected),
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
    () => deadlineFor(SETUP.ceiling, SETUP.expected),
    (error) => {
      assert.ok(error instanceof BudgetExhaustedError);
      assert.match(error.message, /5\.50-minute/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// expectedFrom — the duration a timeout is judged against.
//
// This rule decides whether a timeout discards a run's measurements or keeps
// them, and it previously lived in the producer, which is a top-level script
// nothing can import. So it had no coverage at all: reverting it to the hardcoded
// estimate, swapping its statistic, or deleting its clamp each left the suite
// green. These tests exist so none of that is true again.
// ---------------------------------------------------------------------------

test("with nothing measured yet, the seed estimate is used", () => {
  // The first setup of a run has no measurements to draw on. Must not degenerate
  // to -Infinity (an empty `Math.max`) or 0 (an empty median), either of which
  // makes every subsequent timeout a hang.
  const got = expectedFrom([], SETUP_WORK);
  assert.equal(got, SETUP_WORK.expected);
  assert.ok(Number.isFinite(got) && got > 0);
});

test("measurements override the seed once the run has them", () => {
  // A machine slower than the guess. The whole point of reading measurements: on
  // the seed alone a legitimately slow setup has its timeout called a hang.
  assert.equal(expectedFrom([200_000, 200_000, 200_000], SETUP_WORK), 200_000);
});

test("the seed is a floor, so a fast machine cannot shrink the threshold", () => {
  // Otherwise ordinary variance on a quick runner starts reading as a hang.
  assert.equal(
    expectedFrom([1_000, 1_200, 900], SETUP_WORK),
    SETUP_WORK.expected
  );
});

// The defect this rule was rewritten for. `STARVATION_FACTOR`'s slack is sized for
// a central estimate, so an extremum spends it twice: one slow-but-completing
// sample would raise the threshold to twice that outlier for every later grant,
// and a real deadlock underneath it gets reported as the budget running out — run
// kept, measurements published, and the comment advising a bigger timeout.
test("one slow sample does not move the threshold", () => {
  const clean = Array(11).fill(150_000);
  const withOutlier = [...clean];
  withOutlier[2] = 310_000;
  assert.equal(
    expectedFrom(withOutlier, SETUP_WORK),
    expectedFrom(clean, SETUP_WORK),
    "a single outlier changed the expectation"
  );
});

test("a deadlock stays a hang when a slow sample is present", () => {
  // The consequence of the property above, stated at the level that matters.
  const durations = Array(11).fill(150_000);
  durations[2] = 310_000;
  const got = grantDeadline({
    ceiling: SETUP_WORK.ceiling,
    expected: expectedFrom(durations, SETUP_WORK),
    remaining: 560_000,
    floorMs: BUDGET_FLOOR_MS,
  });
  assert.equal(
    got.starved,
    false,
    "a 560s grant for 150s of work was called starved, so a deadlock under it " +
      "would be reported as the budget running out and the run kept"
  );
});

test("a majority of slow samples does move the threshold", () => {
  // The flip side: this must track a genuinely slow machine, not just ignore
  // outliers. Six of eleven at 250s is the machine, not a transient.
  const durations = Array(11).fill(150_000);
  for (let i = 0; i < 6; i++) durations[i] = 250_000;
  assert.equal(expectedFrom(durations, SETUP_WORK), 250_000);
});

test("the expectation never leaves room for grantDeadline to refuse the profile", () => {
  // The clamp is the only reason the `expected * STARVATION_FACTOR > ceiling`
  // guard cannot fire from this path, and a RangeError mid-run costs a completed
  // run its artifact. Swept well past the ceiling.
  for (const slowest of [
    1,
    SETUP_WORK.expected,
    299_000,
    300_000,
    301_000,
    599_000,
    SETUP_WORK.ceiling,
    SETUP_WORK.ceiling * 10,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const expected = expectedFrom(Array(5).fill(slowest), SETUP_WORK);
    assert.ok(
      expected * STARVATION_FACTOR <= SETUP_WORK.ceiling,
      `slowest=${slowest} produced expected=${expected}, which grantDeadline refuses`
    );
    assert.doesNotThrow(() =>
      grantDeadline({
        ceiling: SETUP_WORK.ceiling,
        expected,
        remaining: SETUP_WORK.ceiling,
        floorMs: BUDGET_FLOOR_MS,
      })
    );
  }
});

test("a full-ceiling grant is a hang no matter what was measured", () => {
  // The backstop. However slow the machine looks, a timeout at the work's own
  // ceiling must remain a hang, or nothing can ever be diagnosed as stuck.
  for (const slowest of [1_000, 150_000, 300_000, 900_000]) {
    const got = grantDeadline({
      ceiling: SETUP_WORK.ceiling,
      expected: expectedFrom(Array(9).fill(slowest), SETUP_WORK),
      remaining: 10 * 60 * 60 * 1000,
      floorMs: BUDGET_FLOOR_MS,
    });
    assert.equal(got.clamped, false);
    assert.equal(
      got.starved,
      false,
      `slowest=${slowest} made the full ceiling starved`
    );
  }
});

test("a corrupt measurement is refused rather than silently skewing the threshold", () => {
  for (const bad of [NaN, Infinity, -1, 0, "90000", null, undefined]) {
    assert.throws(
      () => expectedFrom([90_000, bad], SETUP_WORK),
      TypeError,
      `accepted ${bad}`
    );
  }
  assert.throws(() => expectedFrom(null, SETUP_WORK), TypeError);
});

test("the budget floor leaves the settle barrier whole", () => {
  // bench-budget.mjs documents the settle profile as never clamped and never
  // starved, and that rests entirely on the floor being at least its ceiling.
  // Below it, a budget-shortened settle timeout becomes a plain Error, which the
  // producer records as a page fault and reports against the prover.
  assert.ok(
    BUDGET_FLOOR_MS >= SETTLE_WORK.ceiling,
    `floor ${BUDGET_FLOOR_MS} is below the settle ceiling ${SETTLE_WORK.ceiling}`
  );
  for (let remaining = 0; remaining <= 40_000; remaining += 250) {
    const got = grantDeadline({
      ...SETTLE_WORK,
      remaining,
      floorMs: BUDGET_FLOOR_MS,
    });
    if (got.refused) continue;
    assert.equal(
      got.clamped,
      false,
      `settle was clamped at remaining=${remaining}`
    );
    assert.equal(
      got.starved,
      false,
      `settle was starved at remaining=${remaining}`
    );
  }
});
