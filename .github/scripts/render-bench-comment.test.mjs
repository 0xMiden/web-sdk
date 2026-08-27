// Tests for the benchmark comment renderer.
//
// Run with `node --test .github/scripts/render-bench-comment.test.mjs` or
// `make test-bench-scripts`.
//
// The renderer runs in the TRUSTED half of the workflow_run pipeline, holding a
// write token, over JSON that a fork controls end to end. Most of what is
// asserted here is that property: names cannot carry markup or autolinks,
// nothing in the artifact can author the verdict, malformed numbers are refused
// rather than rendered, and the statistic reported is the one the methodology
// claims.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { main, renderComment, renderSummary } from "./render-bench-comment.mjs";

/** Mirrors MAX_BODY_CHARS in the renderer — the invariant it actually enforces. */
const MAX_BODY_CHARS = 60000;

const ctx = (overrides = {}) => ({
  owner: "0xMiden",
  repo: "web-sdk",
  headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  baseSha: "89690ae2000000000000000000000000000000ab",
  baseRef: "next",
  runId: "32568739941",
  runUrl: "https://github.com/0xMiden/web-sdk/actions/runs/32568739941",
  ...overrides,
});

/**
 * Must match the fixture's `reps` / `provesPerRep`: the shape is enforced.
 *
 * Six is the calibrated default and also the smallest count that exercises the
 * real verdict path — below six the renderer declines to call any movement
 * significant, because both legs of the verdict weaken together there.
 * A fixture with fewer would silently test only the unresolved branch.
 */
const REPS = 6;
const PROVES_PER_REP = 3;

/**
 * A side whose RECOMPUTED statistic is exactly `value`.
 *
 * The renderer derives every figure from `samples` and ignores the artifact's
 * own `value` / `min` / `median` / `max`, so a fixture cannot simply assert a
 * number — it has to present samples whose mean-of-per-rep-minima is that
 * number. Each rep's fastest prove is `value`; the others only move the spread.
 *
 * Scaled by `|value|` rather than multiplied, and falling back to `value` itself
 * when the sum overflows, so the extremes the overflow tests use (5e-324,
 * ±Number.MAX_VALUE) stay finite. A tie leaves the rep's minimum at `value`.
 */
const side = (value) => {
  const slower = (k) => {
    const scaled = value + Math.abs(value) * k;
    return Number.isFinite(scaled) ? scaled : value;
  };
  // Derived from the constants rather than written out, so raising REPS or
  // PROVES_PER_REP cannot leave the fixture describing a shape the renderer
  // rejects. The rep's first prove is `value`, which makes it the minimum
  // whatever the offsets are.
  return {
    samples: Array.from({ length: REPS }, (_unused, rep) =>
      Array.from({ length: PROVES_PER_REP }, (_ignored, prove) =>
        prove === 0 ? value : slower(0.2 * (prove + rep))
      )
    ),
  };
};

const results = (overrides = {}) => ({
  schemaVersion: 3,
  status: "ok",
  runner: "warp-ubuntu-latest-x64-8x",
  variant: "mt",
  profile: "release",
  threads: 8,
  reps: REPS,
  provesPerRep: PROVES_PER_REP,
  // One discarded warm-up rep and one discarded first prove per page: the
  // renderer checks these against the retained counts rather than trusting the
  // methodology text it prints about them.
  repsExecuted: REPS + 1,
  provesExecutedPerRep: PROVES_PER_REP + 1,
  benchmarks: [
    {
      name: "prove / consume / ecdsa-k256-keccak",
      unit: "ms",
      base: side(1000),
      head: side(1010),
      ...overrides.benchmark,
    },
  ],
  ...overrides.top,
});

const bench = (name, base, head) => ({ name, unit: "ms", base, head });

test("reports the mean of per-rep minima, not the median or the global minimum", () => {
  // The methodology paragraph claims the mean of per-rep minima. If the
  // renderer used the median or the global minimum instead, that paragraph
  // would become a lie while the comment still looked plausible.
  //
  // Every base rep's fastest prove is 1000, so the base figure is 1000. Half the
  // head reps are fastest at 1000 and half at 1020, so the mean of per-rep
  // minima is 1010 — while the median over all head samples is 5000 and the
  // global minimum is 1000. Each wrong estimator lands on a different number.
  const body = renderComment(
    results({
      benchmark: {
        base: {
          samples: Array.from({ length: REPS }, () => [1000, 3000, 3000]),
        },
        head: {
          samples: Array.from({ length: REPS }, (_unused, rep) =>
            rep % 2 === 0 ? [1000, 5000, 5000] : [1020, 5000, 5000]
          ),
        },
      },
    }),
    ctx()
  );
  // (mean(1000, 1020, ...) - 1000) / 1000 = +1.00%
  assert.match(body, /\+1\.00%/);
  // The two wrong estimators, spelled out so this cannot pass by coincidence.
  assert.doesNotMatch(body, /\+400\.00%/, "median over all samples");
  assert.doesNotMatch(body, /\+0\.00%/, "global minimum");
});

test("recomputes the statistics and ignores the summary the artifact claims", () => {
  // Pinning the threshold and the direction on the trusted side was only half
  // the job. With the NUMBERS still trusted, a fork kept full control of the
  // verdict by arithmetic: samples showing head 10% slower, a `value` pair
  // claiming 8% faster, and a comment posted under this repo's token whose own
  // methodology section asserts the figure is the mean of those samples'
  // per-rep minima.
  const body = renderComment(
    results({
      benchmark: {
        base: {
          statistic: "mean-of-per-rep-minima",
          value: 1200,
          perRepMin: Array.from({ length: REPS }, () => 1200),
          min: 1200,
          median: 1200,
          max: 1200,
          samples: Array.from({ length: REPS }, () => [1000, 1400, 1400]),
        },
        head: {
          statistic: "mean-of-per-rep-minima",
          value: 1100,
          perRepMin: Array.from({ length: REPS }, () => 1100),
          min: 1100,
          median: 1100,
          max: 1100,
          samples: Array.from({ length: REPS }, () => [1100, 1500, 1500]),
        },
      },
    }),
    ctx()
  );
  const heading = body.split("\n")[0];
  assert.match(heading, /\+10\.00% slower/, "the claimed summary won");
  assert.doesNotMatch(heading, /faster/);
  // The recomputed spread has to come from the samples too, not from the
  // claimed min/max — otherwise the raw block contradicts its own numbers.
  assert.match(body, /min 1,000\.0 {2}max 1,400\.0/);
});

test("refuses a side with no samples to recompute from", () => {
  // A summary with no samples is unverifiable by construction, and the whole
  // point of v2 is that nothing unverifiable reaches the comment.
  for (const samples of [undefined, null, [], 1000]) {
    assert.throws(
      () =>
        renderComment(
          results({
            benchmark: {
              base: {
                value: 1000,
                min: 1000,
                median: 1000,
                max: 1000,
                samples,
              },
              head: side(1010),
            },
          }),
          ctx()
        ),
      /samples/
    );
  }
});

test("refuses samples that disagree with the declared retained counts", () => {
  // An artifact claiming six reps and shipping two groups is internally
  // inconsistent: every number derived from it would be mislabelled, and the
  // per-rep block would attribute samples to reps that never ran.
  const wrongGroups = {
    samples: Array.from({ length: REPS - 1 }, () => [1000, 1000, 1000]),
  };
  const wrongWidth = {
    samples: Array.from({ length: REPS }, () => [1000, 1000]),
  };
  // Length REPS, so it reaches the per-group check rather than being caught by
  // the group-COUNT guard first — that is the difference between testing "a flat
  // array is refused" and testing the group count twice.
  const flat = { samples: Array.from({ length: REPS }, () => 1000) };
  // Pinned per case, since a bare /samples/ passes on any of the three messages
  // and so cannot show that each guard is the one that fired.
  for (const [label, bad, pattern] of [
    [
      "group count",
      wrongGroups,
      new RegExp(`must hold ${REPS} per-rep groups`),
    ],
    ["group width", wrongWidth, /must hold 3 samples/],
    ["flat array", flat, /must be an array of numbers/],
  ]) {
    assert.throws(
      () =>
        renderComment(
          results({ benchmark: { base: bad, head: side(1000) } }),
          ctx()
        ),
      pattern,
      `${label} was accepted or refused by the wrong guard`
    );
  }
});

test("refuses an unbounded sample payload rather than exhausting memory", () => {
  // A ~200 KB artifact inflates to ~200 MB of JSON, and the renderer holds
  // every sample while building the raw block — an OOM in the job that carries
  // the write token, i.e. an unprivileged DoS of the reporter by any fork PR.
  const reps = 1000;
  const provesPerRep = 300;
  const wide = () => ({
    samples: Array.from({ length: reps }, () =>
      Array.from({ length: provesPerRep }, () => 1000)
    ),
  });
  assert.throws(
    () =>
      renderComment(
        results({
          top: {
            reps,
            provesPerRep,
            repsExecuted: reps + 1,
            provesExecutedPerRep: provesPerRep + 1,
          },
          benchmark: { base: wide(), head: wide() },
        }),
        ctx()
      ),
    /too many samples/
  );
});

test("refuses an artifact built against an older schema", () => {
  // The reporter always runs the DEFAULT branch's renderer against an artifact
  // built by the PR head's producer, so the two are routinely at different
  // revisions. v2 had no `stoppedEarlyKind`, so its truncated artifacts could not
  // say whether a run ran out of clock or overran a deadline — and the renderer
  // asserted the former for both.
  assert.throws(
    () => renderComment(results({ top: { schemaVersion: 2 } }), ctx()),
    /schemaVersion 2 came from the bench script on the PR head/
  );
});

test("the schema rejection names both sides of the pipeline, not just the numbers", () => {
  // Whoever reads this is looking at a default-branch workflow log for a PR they
  // did not write. "must be 3, got 4" does not tell them which half to change.
  let message = "";
  try {
    renderComment(results({ top: { schemaVersion: 4 } }), ctx());
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /PR head/);
  assert.match(message, /default\s+branch/);
  assert.match(message, /ACCEPTED_SCHEMA_VERSIONS/);
});

// --- Recomputed statistics: finite in, non-finite out ----------------------

test("refuses a recomputed mean that overflows even though every sample is finite", () => {
  // mean() sums before it divides, so two finite samples at the top of the
  // double range overflow to Infinity. A head-only run has no delta, so the
  // downstream delta checks never see it and the row renders as "∞".
  assert.throws(
    () =>
      renderComment(
        results({
          benchmark: { base: null, head: { samples: [[1e308], [1e308]] } },
          top: {
            reps: 2,
            provesPerRep: 1,
            repsExecuted: 3,
            provesExecutedPerRep: 2,
          },
        }),
        ctx()
      ),
    /value \(recomputed\) must be a finite number/
  );
});

test("no head-only report can render an infinity", () => {
  // The guard above is the mechanism; this is the property it exists for. Split
  // by expected outcome: a `catch { continue }` over a mixed list counted a
  // throw as a pass, so only one of the three fixtures ever reached the
  // assertion. 1e308 and MAX_VALUE overflow while recomputing the mean and are
  // refused; 1e307 survives and must render finite.
  for (const sample of [1e308, Number.MAX_VALUE]) {
    assert.throws(
      () =>
        renderComment(
          results({
            benchmark: {
              base: null,
              head: { samples: [[sample], [sample], [sample]] },
            },
            top: {
              reps: 3,
              provesPerRep: 1,
              repsExecuted: 4,
              provesExecutedPerRep: 2,
            },
          }),
          ctx()
        ),
      /must be a finite number/,
      `${sample} was not refused`
    );
  }
  for (const sample of [1e307]) {
    let body = "";
    body = renderComment(
      results({
        benchmark: {
          base: null,
          head: { samples: [[sample], [sample], [sample]] },
        },
        top: {
          reps: 3,
          provesPerRep: 1,
          repsExecuted: 4,
          provesExecutedPerRep: 2,
        },
      }),
      ctx()
    );
    assert.doesNotMatch(
      body,
      /∞|Infinity|NaN/,
      `${sample} rendered non-finite`
    );
  }
});

// --- Negative timings ------------------------------------------------------

test("refuses negative sample timings", () => {
  // A negative elapsed time is not a slow benchmark, it is not a measurement.
  assert.throws(
    () =>
      renderComment(
        results({
          benchmark: { base: null, head: { samples: [[-1], [-1]] } },
          top: {
            reps: 2,
            provesPerRep: 1,
            repsExecuted: 3,
            provesExecutedPerRep: 2,
          },
        }),
        ctx()
      ),
    /must be a non-negative duration/
  );
});

test("a negative baseline cannot invert the sign of the verdict", () => {
  // (-11 - -10) / -10 = +0.1, so a pair of negative sides rendered a 10%
  // SLOWER head as "+10.00% faster" — the sign of the percentage taken from the
  // sign of the baseline.
  assert.throws(
    () =>
      renderComment(
        results({
          benchmark: {
            base: { samples: [[-10], [-10]] },
            head: { samples: [[-11], [-11]] },
          },
          top: {
            reps: 2,
            provesPerRep: 1,
            repsExecuted: 3,
            provesExecutedPerRep: 2,
          },
        }),
        ctx()
      ),
    /must be a non-negative duration/
  );
});

// --- Verdict: the threshold is necessary but not sufficient ----------------

test("refuses to call a movement significant when the repetitions disagree", () => {
  // The threshold tests a ratio of two means and throws away the spread that
  // produced them, even though the samples are in the artifact. These head
  // repetitions straddle the base badly — five at +50%, one at −38% — and
  // average to a movement that clears the floor. Calling that a regression
  // asserts something the repetitions do not support.
  //
  // Six repetitions, not five: below the calibrated count the run is unresolved
  // for a DIFFERENT reason, which would let this test pass without exercising
  // the disagreement path at all.
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 6 }, () => [100, 100, 100]) },
        head: {
          samples: [
            [150, 150, 150],
            [150, 150, 150],
            [150, 150, 150],
            [150, 150, 150],
            [150, 150, 150],
            [62, 62, 62],
          ],
        },
      },
    }),
    ctx()
  );
  const heading = body.split("\n")[0];
  assert.match(heading, /Unresolved/);
  assert.doesNotMatch(heading, /slower/);
  // The reason has to be the disagreement, not the repetition count.
  assert.match(heading, /repetitions disagree/);
  assert.doesNotMatch(heading, /too few/);
  assert.match(body, /\*\*1 benchmark unresolved\.\*\*/);
  assert.match(body, /agrees in only\n> 5 of 6 repetitions/);
  assert.match(benchmarkRows(body)[0], /❔/u);
});

test("calls a consistent movement significant", () => {
  // Same aggregate size as the unresolved case above, but every repetition
  // agrees on the direction, so there is a result to report.
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 6 }, () => [100, 100, 100]) },
        head: {
          samples: [
            [120, 120, 120],
            [121, 121, 121],
            [119, 119, 119],
            [120, 120, 120],
            [120, 120, 120],
            [120, 120, 120],
          ],
        },
      },
    }),
    ctx()
  );
  const heading = body.split("\n")[0];
  assert.match(heading, /⚠️ \+20\.00% slower/);
  // The legend always names the unresolved state; the NOTE only appears when
  // something is actually in it.
  assert.doesNotMatch(body, /benchmark unresolved/);
  assert.match(benchmarkRows(body)[0], /🔺/u);
});

test("does not inherit the calibrated spread for a thinner run", () => {
  // The 1.79% figure was measured at 6 reps × 3 warm proves, and both counts are
  // artifact-authored. A single sample per side must not be dressed up in a
  // standard deviation measured over eighteen.
  const thin = renderComment(
    results({
      top: {
        reps: 1,
        provesPerRep: 1,
        repsExecuted: 2,
        provesExecutedPerRep: 2,
      },
      benchmark: {
        base: { samples: [[1000]] },
        head: { samples: [[1010]] },
      },
    }),
    ctx()
  );
  assert.doesNotMatch(thin, /holds a standard deviation of 1\.79%/);
  assert.match(thin, /does not use the 6 × 3/);

  const full = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 6 }, () => [1000, 1200, 1400]) },
        head: { samples: Array.from({ length: 6 }, () => [1010, 1200, 1400]) },
      },
    }),
    ctx()
  );
  assert.match(full, /holds a standard deviation of 1\.79%/);

  // More repetitions do not merely satisfy the claim, they invalidate the
  // arithmetic behind it: the spread narrows as 1/sqrt(reps), so at 24 reps the
  // real figure is nearer 0.90% and the fixed 5.40% cutoff stops being 3σ.
  const wide = renderComment(
    results({
      top: {
        reps: 24,
        provesPerRep: 3,
        repsExecuted: 25,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 24 }, () => [1000, 1200, 1400]) },
        head: { samples: Array.from({ length: 24 }, () => [1010, 1200, 1400]) },
      },
    }),
    ctx()
  );
  assert.doesNotMatch(wide, /holds a standard deviation of 1\.79%/);
  assert.match(wide, /does not use the 6 × 3/);
});

test("refuses artifact-authored counts no real run could produce", () => {
  // These three cannot be recomputed — the reporter has no independent
  // knowledge of the bench configuration — so the comment prints them as fact.
  // Bounding them is the most that can be done.
  for (const [field, value] of [
    ["reps", 1_000_000],
    ["provesPerRep", 1_000_000],
    ["threads", 1_000_000],
  ]) {
    assert.throws(
      () => renderComment(results({ top: { [field]: value } }), ctx()),
      new RegExp(`${field} must be an integer in`),
      `${field} was accepted at ${value}`
    );
  }
});

test("classifies movement against the threshold", () => {
  const within = renderComment(results(), ctx());
  assert.match(within, /No significant change/);

  const beyond = renderComment(
    results({ benchmark: { base: side(1000), head: side(1200) } }),
    ctx()
  );
  assert.match(beyond, /\+20\.00% slower/);
  assert.match(beyond, /Moved beyond a provisional noise floor/);
});

// The heading and the provisional note used to contradict each other: the
// heading asserted `+20.00% slower`, which reads as a claim of significance,
// directly above a note saying the floor here is unknown in both magnitude and
// direction. Whichever the reader believed, the comment had already denied it.
//
// Resolved by weakening the heading rather than withholding the row. A
// provisional floor leaves the ESTIMATE sound and only the cutoff uncertain,
// unlike the cases in verdictPreconditions, so the direction is still worth
// naming — it just must not be phrased as a verdict.
test("a provisional floor states an observation, never a verdict", () => {
  const beyond = renderComment(
    results({ benchmark: { base: side(1000), head: side(1200) } }),
    ctx()
  );
  const heading = beyond.split("\n")[0];
  assert.match(heading, /on this run/);
  assert.match(heading, /not yet a verdict/);
  assert.match(heading, /uncalibrated/);
  // And it must not read as the calibrated form, which claims significance.
  assert.doesNotMatch(heading, /^### .{0,4} \+20\.00% slower: /);
  // The movement itself is not suppressed — that is the whole point of not
  // treating this like a compromised estimate.
  assert.match(beyond, /\+20\.00%/);
  assert.match(beyond, /Moved beyond a provisional noise floor/);
});

test("says out loud when the threshold is provisional", () => {
  const body = renderComment(results(), ctx());
  assert.match(body, /provisional/i);
  assert.match(body, /docs\/benchmarks\/calibration\.md/);
});

test("labels a calibration run so its delta is not read as a regression", () => {
  // Sourced from the trusted context, never the artifact — see the next test.
  const body = renderComment(results(), ctx({ calibration: true }));
  assert.match(body, /Calibration run/);
  assert.match(body, /true difference is zero/);
});

test("never blocks merge, and says so", () => {
  const body = renderComment(results(), ctx());
  assert.match(body, /informational only and never blocks merge/);
});

// --- Untrusted input: the artifact must not author the verdict --------------

test("ignores artifact fields that would author the verdict", () => {
  // A 4x regression. Each of these fields is a hardcoded constant on the
  // producing side, so a value arriving here at all means the artifact was
  // tampered with — and each one used to change the verdict the bot posts under
  // this repo's write token.
  const regression = { benchmark: { base: side(1000), head: side(4000) } };
  const honest = renderComment(results(regression), ctx());
  assert.match(honest, /### ⚠️ \+300\.00% slower/);

  const hostile = [
    { lowerIsBetter: false },
    { thresholdPct: 1e9 },
    { thresholdProvisional: false },
    { calibration: true },
  ];
  for (const override of hostile) {
    const key = Object.keys(override)[0];
    const body = renderComment(
      results({
        benchmark: { ...regression.benchmark, ...override },
        top: override,
      }),
      ctx()
    );
    const heading = body.split("\n")[0];
    assert.match(
      heading,
      /### ⚠️ \+300\.00% slower/,
      `${key} changed the verdict`
    );
    assert.doesNotMatch(heading, /faster/, `${key} inverted the direction`);
    assert.doesNotMatch(
      body,
      /measurement noise, not a code change/,
      `${key} claimed the regression was noise`
    );
    assert.doesNotMatch(
      body,
      /is the calibrated run-to-run variance/,
      `${key} claimed an uncalibrated threshold was calibrated`
    );
    assert.match(
      body,
      /±5\.40% threshold is \*\*provisional\*\*/,
      `${key} replaced the trusted threshold`
    );
  }
});

test("headlines the worst regression, not the biggest mover", () => {
  // Sorting by magnitude alone let a large improvement own the heading while a
  // regression hid behind "(+1 more)". The heading is the only part of this
  // comment most readers ever see.
  const body = renderComment(
    results({
      top: {
        benchmarks: [
          bench("big-win", side(1000), side(600)),
          bench("regression", side(1000), side(1100)),
        ],
      },
    }),
    ctx()
  );
  const heading = body.split("\n")[0];
  assert.match(heading, /⚠️/);
  assert.match(heading, /slower/);
  assert.match(heading, /regression/);
  assert.doesNotMatch(heading, /faster/);
});

/** Benchmark result rows, as opposed to the context table's label/value rows. */
const benchmarkRows = (body) =>
  body.split("\n").filter((line) => /^\| (?:🔺|🔻|➖|❔) \|/u.test(line));

test("strips markup and mentions from fork-controlled benchmark names", () => {
  const hostile =
    "`|@everyone|` <img src=x onerror=alert(1)>\nSecurity review passed";
  const body = renderComment(results({ benchmark: { name: hostile } }), ctx());

  assert.doesNotMatch(body, /@everyone/, "mention survived sanitization");
  assert.doesNotMatch(body, /<img/, "raw HTML survived sanitization");

  // A stray pipe would break out of the markdown cell it sits in and shift
  // every column after it, so the row must still have the header's shape.
  const rows = benchmarkRows(body);
  assert.equal(rows.length, 1, "expected exactly one benchmark row");
  assert.equal(
    rows[0].split("|").length,
    8,
    "unescaped pipe changed the row's column count"
  );
});

test("no benchmark name can add a table column or a row", () => {
  // A newline in a name would end its row and turn the remainder into a new
  // one; a pipe would shift every later cell. Checked against the benchmark
  // table's own header and delimiter so the expected width is not hardcoded.
  const hostile = "a|b\nc|d\r\ne|f";
  const body = renderComment(results({ benchmark: { name: hostile } }), ctx());
  const lines = body.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| | Benchmark |"));
  assert.notEqual(header, -1, "benchmark table header not found");
  const width = lines[header].split("|").length;
  assert.equal(lines[header + 1].split("|").length, width, "delimiter width");

  const rows = benchmarkRows(body);
  assert.equal(rows.length, 1, "the name created an extra row");
  assert.equal(rows[0].split("|").length, width, "the name changed the width");
  assert.ok(!body.includes("a|b"), "a raw pipe survived into the body");
});

test("neutralizes every GitHub autolink and shortcode in a name", () => {
  // None of these need markdown syntax. `#1` and `org/repo#1` are the worst of
  // them: GitHub writes a cross-reference event onto the target issue and
  // notifies its subscribers, which is arbitrary-issue spam under this repo's
  // own bot identity.
  const payloads = [
    "[Security review passed](https://evil.example/x)",
    "![](https://evil.example/beacon.png)",
    "reverted in #1 and 0xMiden/miden-client#1965",
    "GH-1234 tracks this",
    "https://evil.example/pwn?x=1",
    ":white_check_mark: approved",
    "&#96;code&#96; &#64;everyone &#124;col&#124;",
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  ];
  for (const name of payloads) {
    const body = renderComment(results({ benchmark: { name } }), ctx());
    const rows = benchmarkRows(body);
    assert.equal(rows.length, 1, `${name}: expected one row`);
    // Every occurrence of the name must sit inside a code span, where GitHub
    // autolinks nothing and expands nothing.
    for (const line of body.split("\n")) {
      if (line.startsWith("```")) break;
      const cleaned = line.replace(/`[^`]*`/g, "");
      assert.doesNotMatch(
        cleaned,
        /https?:\/\/evil\.example|:white_check_mark:|&#\d+;|GH-\d|#1\b/,
        `${name}: escaped its code span on line: ${line}`
      );
    }
  }
});

test("renders no invisible or control characters", () => {
  // Bidi overrides reverse the row a human reads (Trojan Source); zero-width
  // and blank-but-not-whitespace glyphs make two different names render
  // identically or stretch a column with nothing in it.
  const invisible = [
    "\u202E",
    "\u2066",
    "\u2069",
    "\u200B",
    "\u200E",
    "\u00AD",
    "\uFEFF",
    "\u0085",
    "\u009F",
    "\u3164",
    "\u2800",
    "\u115F",
    "\u1160",
    "\uFFA0",
    "\uE000",
    "\uFFFF",
  ];
  const body = renderComment(
    results({ benchmark: { name: `a${invisible.join("")}b` } }),
    ctx()
  );
  assert.match(
    body,
    /^[\P{C}\n]*$/u,
    "an invisible code point reached the body"
  );
  for (const ch of invisible) {
    assert.ok(
      !body.includes(ch),
      `U+${ch.codePointAt(0).toString(16).toUpperCase()} survived`
    );
  }
});

test("caps stacked combining marks without mangling legitimate text", () => {
  // Unbounded stacking renders as a cell many lines tall that pushes the rest of
  // the table off the screen — the same failure the blank-glyph strip exists for.
  const zalgo = renderComment(
    results({ benchmark: { name: `a${"\u0301".repeat(60)}b` } }),
    ctx()
  );
  const row = benchmarkRows(zalgo)[0];
  assert.ok(
    (row.match(/\p{M}/gu) ?? []).length <= 2,
    `combining marks survived: ${JSON.stringify(row)}`
  );

  // Stripping marks outright would break real names, so the cap must not.
  const legit = renderComment(
    results({ benchmark: { name: "café / naïve / 日本語 / 😀" } }),
    ctx()
  );
  assert.match(benchmarkRows(legit)[0], /café \/ naïve \/ 日本語 \/ 😀/);
});

test("strips a lone surrogate rather than returning ill-formed UTF-16", () => {
  // JSON can encode an UNPAIRED surrogate ("\ud800"), which survives
  // JSON.parse. Code-point-aware truncation does not help — the lone surrogate
  // IS a code point — and the GitHub API rejects or mangles the request.
  for (const name of ["a\ud800b", "\udfffonly", `${"x".repeat(79)}\ud83d`]) {
    const body = renderComment(results({ benchmark: { name } }), ctx());
    assert.ok(body.isWellFormed(), `${JSON.stringify(name)}: ill-formed`);
    assert.doesNotMatch(body, /[\p{Cs}]/u, "a surrogate reached the body");
  }
});

test("returns a well-formed string even when truncating a name", () => {
  // Slicing by UTF-16 unit split surrogate pairs, which reaches the comment as
  // U+FFFD and a JSON API payload as a lone `\ud83d` escape.
  const body = renderComment(
    results({ benchmark: { name: `${"a".repeat(76)}😀😀😀😀` } }),
    ctx()
  );
  assert.ok(body.isWellFormed(), "renderer returned ill-formed UTF-16");
});

test("refuses to render non-finite measurements rather than printing NaN", () => {
  for (const bad of [Number.NaN, Infinity, "1000", null, undefined]) {
    assert.throws(
      () =>
        renderComment(
          results({
            benchmark: {
              base: {
                samples: [
                  [1000, bad, 1000],
                  [1000, 1000, 1000],
                ],
              },
              head: side(1000),
            },
          }),
          ctx()
        ),
      `expected a throw for ${String(bad)}`
    );
  }
});

test("refuses a delta that overflows to a non-finite number", () => {
  // Both sides are individually finite, so per-field validation passes; the
  // subtraction and the division are what overflow.
  assert.throws(
    () =>
      renderComment(
        results({ benchmark: { base: side(5e-324), head: side(1e300) } }),
        ctx()
      ),
    /not finite/
  );
  // The other half of this test used to pair side(-Number.MAX_VALUE) against
  // side(Number.MAX_VALUE). Both inputs are now refused before any delta is
  // computed — the negative one as not a duration, the positive one because
  // summing two MAX_VALUE entries overflows while recomputing the mean — so the pair no
  // longer reaches the delta at all. Each guard is covered on its own above.
  assert.throws(
    () =>
      renderComment(
        results({ benchmark: { base: side(1), head: side(Number.MAX_VALUE) } }),
        ctx()
      ),
    /must be a finite number, got Infinity/
  );
});

test("falls back to a positional name when coercion throws", () => {
  // `String({toString: 1})` throws a bare TypeError, which used to escape the
  // `fail()` contract with an error naming no field.
  const body = renderComment(
    results({ benchmark: { name: { toString: 1 } } }),
    ctx()
  );
  assert.match(body, /benchmark #1/);
});

test("refuses a context whose shas or slugs are not well formed", () => {
  assert.throws(() => renderComment(results(), ctx({ headSha: "not-a-sha" })));
  assert.throws(() =>
    renderComment(results(), ctx({ owner: "bad owner/../.." }))
  );
  // A bare dot segment passes a naive character class and then normalizes
  // inside a commit URL into a link to a different repo.
  for (const slug of ["..", "."]) {
    assert.throws(
      () => renderComment(results(), ctx({ owner: slug })),
      undefined,
      `owner "${slug}" was accepted`
    );
    assert.throws(
      () => renderComment(results(), ctx({ repo: slug })),
      undefined,
      `repo "${slug}" was accepted`
    );
  }
  assert.throws(
    () => renderComment(results(), ctx({ baseSha: "A1B2C3D4E5F6071" })),
    undefined,
    "an uppercase sha must be refused, matching the shell-side check"
  );
});

test("degrades an unrecognized run URL to text instead of linking it", () => {
  // The old pattern accepted `..`, which GitHub normalizes into a link to
  // whatever repo the traversal lands on.
  for (const runUrl of [
    "https://github.com/0xMiden/web-sdk/actions/runs/../../../evil/repo",
    "https://github.com/../../evil",
    "https://ghe.example.com/0xMiden/web-sdk/actions/runs/1",
  ]) {
    const body = renderComment(results(), ctx({ runUrl }));
    assert.ok(!body.includes(runUrl), `${runUrl} was rendered as a link`);
    // Assert the positive shape: the fallback is bare text, so it must appear
    // and must not be sitting inside a markdown link target. `doesNotMatch` on
    // `](the workflow run)` alone could never fail, since the renderer has no
    // code path that would emit it.
    assert.match(body, /attached to the workflow run as/);
    assert.doesNotMatch(body, /\((?:the workflow run|bench run)/);
  }
});

// --- Head-only runs --------------------------------------------------------

test("renders a head-only run instead of refusing it", () => {
  // bench.yml warns and carries on when the base dist fails to build, so
  // `summarize()` emits a null base. Refusing it turned the documented
  // fallback into a hard failure on both the comment and the summary.
  const body = renderComment(
    results({ benchmark: { base: null, head: side(1000) } }),
    ctx()
  );
  assert.match(body, /Head-only run/);
  assert.match(body, /No base measurements/);
  const rows = benchmarkRows(body);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /\| — \|/, "base cell should be an em dash");
  assert.match(rows[0], /n\/a/, "delta should be n/a");
  assert.match(body, /base \(not measured\)/);
});

test("a head-only run does not claim the two sides were interleaved", () => {
  // Every sentence about alternating proves, flipping the order and building
  // both sides in one job describes something that did not happen, and it sat
  // directly under the "no base measurements" banner.
  const body = renderComment(
    results({ benchmark: { base: null, head: side(1000) } }),
    ctx()
  );
  assert.doesNotMatch(body, /one prove at a time, alternating/);
  assert.doesNotMatch(
    body,
    /Base and head are \*\*measured\*\* in the same job/
  );
  assert.doesNotMatch(body, /both sides ran interleaved/);

  // ... and still does when there IS a base.
  const compared = renderComment(results(), ctx());
  assert.match(compared, /one prove at a time, alternating/);
  assert.match(compared, /Base and head are \*\*measured\*\* in the same job/);
  // The base dist can come from cache, so the claim must not say both were BUILT
  // in this job — only that both were measured in it.
  assert.doesNotMatch(compared, /built and measured in the same job/);
});

test("still refuses an artifact with no head measurements", () => {
  assert.throws(
    () =>
      renderComment(
        results({ benchmark: { base: side(1000), head: null } }),
        ctx()
      ),
    /head has no measurements/
  );
});

// --- Markdown mechanics ----------------------------------------------------

test("leaves a blank line after every </summary>", () => {
  // GitHub only re-enters markdown mode after a blank line following
  // </summary>; without it a table inside <details> renders as literal pipes.
  const body = renderComment(results(), ctx());
  const lines = body.split("\n");
  const summaries = lines
    .map((line, i) => (line.includes("</summary>") ? i : -1))
    .filter((i) => i !== -1);
  assert.ok(summaries.length > 0, "no <details> block rendered");
  for (const i of summaries) {
    assert.equal(
      lines[i + 1],
      "",
      `missing blank line after </summary> at line ${i}`
    );
  }
});

test("does not print the same table twice when every row moved", () => {
  // A short suite renders its table inline rather than inside <details>. When
  // every row also cleared the threshold, the "moved" table and the "all
  // benchmarks" table would otherwise be byte-identical neighbours.
  const body = renderComment(
    results({ benchmark: { base: side(1000), head: side(1200) } }),
    ctx()
  );
  assert.equal(
    benchmarkRows(body).length,
    1,
    "benchmark row appeared in more than one table"
  );
});

const manyBenchmarks = (count, scale = 1) =>
  Array.from({ length: count }, (_, i) =>
    bench(`bench-${i}`, side(1000 + i), side((1200 + i) * scale))
  );

test("stays within the size limit it enforces", () => {
  const body = renderComment(
    results({ top: { benchmarks: manyBenchmarks(200) } }),
    ctx()
  );
  assert.ok(
    body.length <= MAX_BODY_CHARS,
    `body was ${body.length} chars, cap is ${MAX_BODY_CHARS}`
  );
  // Rows may be capped, but never silently.
  assert.match(body, /Row cap reached/);
});

test("truncation never leaves an unbalanced <details> or a broken row", () => {
  // The last-resort cut used to slice the joined string, which landed inside a
  // table row or inside the methodology <details> — and an unclosed <details>
  // collapses the whole remainder of the comment on GitHub.
  for (const count of [200, 600, 2000]) {
    for (const scale of [1, 1e12, 1e100, 1e250, 1e300]) {
      const body = renderComment(
        results({ top: { benchmarks: manyBenchmarks(count, scale) } }),
        ctx()
      );
      assert.ok(
        body.length <= MAX_BODY_CHARS,
        `${count}/${scale}: body was ${body.length}`
      );
      assert.equal(
        (body.match(/<details>/g) ?? []).length,
        (body.match(/<\/details>/g) ?? []).length,
        `${count}/${scale}: unbalanced <details>`
      );
      assert.equal(
        (body.match(/```/g) ?? []).length % 2,
        0,
        `${count}/${scale}: unbalanced code fence`
      );
      assert.ok(body.isWellFormed(), `${count}/${scale}: ill-formed UTF-16`);
      for (const line of body.split("\n")) {
        if (!line.startsWith("| ")) continue;
        assert.ok(
          line.endsWith("|"),
          `${count}/${scale}: truncated table row: ${line.slice(-40)}`
        );
      }
      // The disclaimer has to survive every degradation step.
      assert.match(
        body,
        /never blocks merge/,
        `${count}/${scale}: lost the footer`
      );
      // And every degradation must SAY it degraded. Silently shipping a shorter
      // comment is the one outcome worse than a truncated one.
      if (body.length > MAX_BODY_CHARS - 200) {
        assert.match(
          body,
          /✂️/,
          `${count}/${scale}: truncated without saying so`
        );
      }
    }
  }
});

test("the degradation ladder reaches every rung it defines", () => {
  // Attempt 3 and the last-resort block drop were both unreachable from the
  // fixtures above, so a regression that broke either — including replacing the
  // block drop with the mid-string slice it exists to avoid — kept the suite
  // green. These fixtures pin each rung by the notice only it emits.
  // Rung 2: samples dropped, table kept. Benchmark COUNT alone never gets here —
  // the moved-rows table and the samples block are each capped, so the body
  // plateaus near 24 kB however many benchmarks arrive. It takes many samples
  // per benchmark, which is the retained-count dimension.
  const wide = (value) => ({
    samples: Array.from({ length: 40 }, () => [value, value, value, value]),
  });
  const dropsSamples = renderComment(
    results({
      top: {
        reps: 40,
        provesPerRep: 4,
        repsExecuted: 41,
        provesExecutedPerRep: 5,
        benchmarks: Array.from({ length: 60 }, (_unused, i) =>
          bench(`bench-${i}`, wide(1000 + i), wide(1200 + i))
        ),
      },
    }),
    ctx()
  );
  assert.match(dropsSamples, /Per-rep raw samples were dropped/);
  assert.doesNotMatch(dropsSamples, /full benchmark table were dropped/);

  // Rung 3: samples AND the full table dropped. Needs values wide enough that
  // each row is enormous, not merely numerous rows.
  const dropsTable = renderComment(
    results({ top: { benchmarks: manyBenchmarks(2000, 1e300) } }),
    ctx()
  );
  assert.match(dropsTable, /full benchmark table were dropped/);
  assert.ok(dropsTable.isWellFormed());
  assert.equal(
    (dropsTable.match(/<details>/g) ?? []).length,
    (dropsTable.match(/<\/details>/g) ?? []).length
  );

  // Rung 3 still fits here, so the last rung below it must not have fired.
  assert.ok(dropsTable.length <= MAX_BODY_CHARS);
  assert.doesNotMatch(dropsTable, /Output truncated at the size limit/);
});

test("the last-resort cut fires without leaving broken markup", () => {
  // This rung drops whole blocks, and it IS reachable from artifact data: a
  // single value near the top of the double range formats to ~310 characters, so
  // once there are enough rows even the table-less rung 3 overflows. Values are
  // kept at 1e307 rather than 1.7e308 because six of the latter sum past
  // MAX_VALUE and the renderer refuses the artifact outright — a different
  // guard, and not the one under test.
  const wide = () => ({
    samples: Array.from({ length: REPS }, () =>
      Array.from({ length: PROVES_PER_REP }, () => 1e307)
    ),
  });
  const body = renderComment(
    results({
      top: {
        benchmarks: Array.from({ length: 60 }, (_unused, i) => ({
          name: `benchmark-${i}`,
          unit: "ms",
          base: wide(),
          head: {
            samples: Array.from({ length: REPS }, () =>
              Array.from({ length: PROVES_PER_REP }, () => 2e307)
            ),
          },
        })),
      },
    }),
    ctx()
  );

  assert.ok(body.length <= MAX_BODY_CHARS);
  // The cut has to be announced — a silently shortened report is the one thing
  // the ladder exists to avoid.
  assert.match(body, /Output truncated at the size limit/);
  // And it must not cut through markup. An unbalanced <details> swallows the
  // rest of the comment in GitHub's renderer.
  assert.equal(
    (body.match(/<details>/g) ?? []).length,
    (body.match(/<\/details>/g) ?? []).length
  );
  assert.ok(body.isWellFormed());
  // The verdict survives: whatever else is dropped, the reader must still learn
  // the outcome.
  assert.match(body.split("\n")[0], /^### /);
});

test("the summary variant keeps content the comment has to drop", () => {
  // renderSummary had no caller, so the job summary — the fallback surface on
  // forks, where ~1 MiB is allowed — was silently held to the comment's 60 kB
  // limit and degraded identically.
  const wide = (value) => ({
    samples: Array.from({ length: 40 }, () => [value, value, value, value]),
  });
  const input = results({
    top: {
      reps: 40,
      provesPerRep: 4,
      repsExecuted: 41,
      provesExecutedPerRep: 5,
      benchmarks: Array.from({ length: 60 }, (_, i) =>
        bench(`bench-${i}`, wide(1000 + i), wide(1200 + i))
      ),
    },
  });

  const comment = renderComment(input, ctx());
  const summary = renderSummary(input, ctx());
  assert.ok(comment.length <= MAX_BODY_CHARS);
  assert.match(comment, /Per-rep raw samples were dropped/);
  assert.ok(
    summary.length > MAX_BODY_CHARS,
    `summary was only ${summary.length} chars`
  );
  assert.match(summary, /\*\*Per-rep samples\*\*/);
});

// --- CLI -------------------------------------------------------------------

test("the CLI rejects a bad argument list", async () => {
  assert.equal(await main([]), 2);
  assert.equal(await main(["only-one.json"]), 2);
  assert.equal(await main(["a.json", "b.json", "c.json"]), 2);
});

test("the CLI never emits a workflow command from untrusted bytes", async (t) => {
  // V8's JSON parse error quotes the offending bytes verbatim, so an artifact
  // beginning with a newline and `::error::` used to put a real workflow
  // command at the start of a log line in the job holding the write token.
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "bench-render-test-"));
  const resultsPath = join(dir, "results.json");
  const ctxPath = join(dir, "ctx.json");
  await writeFile(
    resultsPath,
    "\n::error title=Injected::fake\n::add-mask::x{"
  );
  await writeFile(ctxPath, JSON.stringify(ctx()));

  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });

  assert.equal(await main([resultsPath, ctxPath]), 64);
  const text = written.join("");
  for (const line of text.split("\n")) {
    assert.doesNotMatch(line, /^::/, `workflow command emitted: ${line}`);
  }
  assert.equal(
    text.split("\n").filter(Boolean).length,
    1,
    "message spans lines"
  );
});

test("the CLI neutralizes the legacy workflow-command form too", async (t) => {
  // The test above pins the `::name::` form, which only counts at the start of a
  // line — so keeping every message on one line, behind a fixed prefix, was
  // taken to be enough. It is not: the runner also accepts the legacy `##[name]`
  // form and finds it by substring search ANYWHERE in the line
  // (`ActionCommand.TryParse` uses `IndexOf`). `add-mask`, `error`, `notice`,
  // `debug`, `group` and `stop-commands` are all registered unconditionally —
  // only `set-env`, `set-output`, `save-state` and `add-path` sit behind the
  // unsecure-commands gate. So a benchmark name quoted into a refusal message
  // could silence this job's annotations or forge one under the repository's
  // name, from the job that holds the write token.
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "bench-render-legacy-"));
  const resultsPath = join(dir, "results.json");
  const ctxPath = join(dir, "ctx.json");
  // A refusal that quotes the offending value back: `reps` has to be a number,
  // and `describeValue` puts the string in the message.
  await writeFile(
    resultsPath,
    JSON.stringify(
      results({
        top: {
          reps: "##[stop-commands]6f2d1c9a8b ##[error]forged ###[add-mask]s",
        },
      })
    )
  );
  await writeFile(ctxPath, JSON.stringify(ctx()));

  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });

  assert.equal(await main([resultsPath, ctxPath]), 64);
  const text = written.join("");
  // The diagnostic still names the field, so neutralizing has not turned the
  // message into "(no detail)".
  assert.match(text, /reps must be/);
  assert.doesNotMatch(text, /##\[/, "legacy workflow command reached stderr");
  for (const line of text.split("\n")) {
    assert.doesNotMatch(line, /^::/, `workflow command emitted: ${line}`);
  }
});

test("the CLI's exit codes distinguish a refused artifact from a renderer bug", async (t) => {
  // bench-comment.yml branches on these: 0 posts, 64 stays quiet because the
  // fork's payload was refused, anything else nonzero turns the reporter red
  // because the fault is first-party. Swapping the two either reddens the
  // default branch on every fork PR, or silently blames PR authors for our own
  // breakage — and until this test existed, either inversion kept the suite
  // green.
  //
  // 64 rather than 1 because node exits 1 on an uncaught exception, including
  // one thrown while loading this module, which never reaches `main()`. The
  // codes must not overlap or the workflow cannot tell those apart.
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "bench-render-exit-"));
  const write = async (name, body) => {
    const target = join(dir, name);
    await writeFile(
      target,
      typeof body === "string" ? body : JSON.stringify(body)
    );
    return target;
  };

  const goodCtx = await write("ctx.json", ctx());
  const goodResults = await write("results.json", results());
  const refusedResults = await write(
    "refused.json",
    results({ top: { reps: 0 } })
  );
  const malformedResults = await write("malformed.json", "{not json");
  const malformedCtx = await write("bad-ctx.json", "{not json");
  const invalidCtx = await write("invalid-ctx.json", {
    ...ctx(),
    headSha: "nope",
  });

  const out = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = () => true;
  t.after(() => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  });

  assert.equal(await main([goodResults, goodCtx]), 0, "valid input renders");
  assert.match(
    out.join(""),
    /No significant change|slower|faster/,
    "no body on stdout"
  );

  assert.equal(await main([refusedResults, goodCtx]), 64, "refused artifact");
  assert.equal(
    await main([malformedResults, goodCtx]),
    64,
    "malformed artifact"
  );
  // The refusal code must stay clear of everything node assigns itself, or the
  // workflow's "not 64 means it was our bug" branch silently stops working.
  for (const nodeOwn of [1, 3, 4, 5, 6, 7, 8, 9, 12, 13]) {
    assert.notEqual(
      64,
      nodeOwn,
      "the refusal code collides with a code node uses itself"
    );
  }

  // ctx.json is written by the reporter's own jq from trusted event fields, so
  // every failure on it is ours, whatever its shape.
  assert.equal(
    await main([goodResults, join(dir, "absent.json")]),
    3,
    "missing ctx"
  );
  assert.equal(await main([goodResults, malformedCtx]), 3, "malformed ctx");
  assert.equal(await main([goodResults, invalidCtx]), 3, "invalid ctx");
});

test("every fork-controlled string is sanitized, not just the benchmark name", () => {
  // `name` had seven tests; `unit`, `runner`, `profile` and `variant` come from
  // the same artifact and had none. `unit` is the one that never passes through
  // codeSpan, so markup in it reaches the table cell directly.
  const hostile =
    "`x`</summary></details>\n\n### Injected @everyone |extra| [l](https://evil.test)";
  const body = renderComment(
    results({
      top: { runner: hostile, profile: hostile, variant: hostile },
      benchmark: { unit: hostile },
    }),
    ctx()
  );

  // The payload survives as inert TEXT inside a code span, which is fine — what
  // must not happen is it becoming structure. So: no line may START a heading
  // except the one legitimate verdict heading, no backtick may escape the span
  // the value is interpolated into, and no mention may survive.
  const headings = body
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line)).length;
  assert.equal(headings, 1, "a fork-authored value opened a heading");
  assert.doesNotMatch(body, /@everyone/, "mention survived");
  assert.equal(
    (body.match(/<\/summary>/g) ?? []).length,
    (body.match(/<summary>/g) ?? []).length,
    "summary tags unbalanced"
  );
  assert.equal(
    (body.match(/<\/details>/g) ?? []).length,
    (body.match(/<details>/g) ?? []).length,
    "details tags unbalanced"
  );

  // The comment carries two tables of different widths, so uniformity across all
  // rows is the wrong invariant. The right one is that a hostile value changes
  // NOTHING about the shape: same rows, same widths as a benign render.
  const shape = (text) =>
    text
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((row) => row.split("|").length)
      .join(",");
  assert.equal(
    shape(body),
    shape(renderComment(results(), ctx())),
    "a fork-authored value changed the table shape"
  );
});

test("caps a name that exceeds the limit without splitting a surrogate pair", () => {
  // The previous fixture was exactly MAX_NAME_CHARS code points, so it returned
  // at the early exit and never reached the slice. With the cap actually
  // exercised, a UTF-16 slice would leave a lone surrogate in a comment the
  // trusted job posts.
  const body = renderComment(
    results({ benchmark: { name: `${"a".repeat(78)}😀😀😀` } }),
    ctx()
  );
  assert.ok(body.isWellFormed(), "lone surrogate in the body");
  assert.match(body, /…/, "nothing was truncated");
});

test("the run URL becomes a link when it is one we recognize", () => {
  // Only the rejecting half of RUN_URL_RE was covered, so hardcoding runUrl to
  // "" — dropping the link from every real comment — kept the suite green.
  const body = renderComment(results(), ctx());
  assert.match(
    body,
    /\[bench run 32568739941\]\(https:\/\/github\.com\/0xMiden\/web-sdk\/actions\/runs\/32568739941\)/
  );
});

test("zero-difference repetitions cannot manufacture a consistent verdict", () => {
  // Exempting exact zeroes from contradicting is right — they carry no direction
  // — but on its own it let five zero deltas plus one large one pass as
  // "consistent", which is the single dominating repetition the guard exists to
  // catch, arriving through the exemption instead of a sign flip.
  //
  // `provesPerRep` is the CALIBRATED count, not 1. At one prove
  // `verdictPreconditions` returns `tooFewProves` and `computeRows` clears
  // `consistent` regardless of the majority rule — so deleting the majority
  // check from `pairedAgreement` left this test green, testing a precondition
  // instead of the thing it is named for.
  const flat = Array.from({ length: 5 }, () => [1000, 1000, 1000]);
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: PROVES_PER_REP,
        repsExecuted: 7,
        provesExecutedPerRep: PROVES_PER_REP + 1,
      },
      benchmark: {
        base: { samples: [...flat, [1000, 1000, 1000]] },
        head: { samples: [...flat, [400, 400, 400]] },
      },
    }),
    ctx()
  );
  // Asserted on the benchmark's own ROW. The legend always names the unresolved
  // state, so matching ❔ anywhere in the body is satisfied by text that is
  // present on every report and cannot fail.
  assert.match(benchmarkRows(body)[0], /❔/u, "not reported as unresolved");
  assert.doesNotMatch(body, /faster: /, "a dominated aggregate was headlined");
});

test("refuses shapes that are not a benchmark report at all", () => {
  for (const [input, pattern] of [
    [null, /root must be an object/],
    [[], /root must be an object/],
    ["nope", /root must be an object/],
  ]) {
    assert.throws(() => renderComment(input, ctx()), pattern);
  }
  assert.throws(
    () => renderComment(results({ top: { benchmarks: "nope" } }), ctx()),
    /benchmarks must be an array/
  );
  assert.throws(
    () => renderComment(results({ top: { benchmarks: [42] } }), ctx()),
    /benchmarks\[0\] must be an object/
  );
});

test("refuses an artifact whose executed counts contradict the discard policy", () => {
  // The methodology text states the discard policy as fact about a producer a
  // fork controls. The executed counts are in the artifact, so it can be checked.
  assert.throws(
    () => renderComment(results({ top: { repsExecuted: REPS } }), ctx()),
    /repsExecuted must be one more than/
  );
  assert.throws(
    () =>
      renderComment(
        results({ top: { provesExecutedPerRep: PROVES_PER_REP + 4 } }),
        ctx()
      ),
    /provesExecutedPerRep must be one more than/
  );
});

// --- pipeline wiring -------------------------------------------------------

test("the reporter's trigger still names the workflow that produces the artifact", async () => {
  // `workflow_run.workflows` matches bench.yml by its `name:` field, not by its
  // filename, so renaming that workflow disables the entire reporter with no
  // error anywhere — no failed run, no annotation, just silence on every PR.
  // The coupling is a comment in both files; this is the part that can fail.
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const workflows = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "workflows"
  );
  const bench = await readFile(join(workflows, "bench.yml"), "utf8");
  const reporter = await readFile(join(workflows, "bench-comment.yml"), "utf8");

  const producerName = bench.match(/^name:\s*(.+)$/m)?.[1].trim();
  assert.ok(producerName, "bench.yml has no name:");

  const triggerNames = reporter.match(/^\s*workflows:\s*\[(.+)\]$/m)?.[1];
  assert.ok(triggerNames, "bench-comment.yml has no workflow_run.workflows");
  const wanted = triggerNames
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""));

  assert.ok(
    wanted.includes(producerName),
    `bench-comment.yml triggers on [${wanted.join(", ")}] but bench.yml is named "${producerName}"`
  );
});

test("surfaces a slowdown that missed every repetition's fastest prove", () => {
  // The headline estimator takes a minimum per repetition, so a change that
  // slows two proves in three by 50% leaves it at ±0.00% — the untouched prove
  // is still the minimum. That is the shape of a collection pause, a lock, or a
  // retry, and it was completely invisible: verdict "no significant change",
  // nothing else in the comment. The mean is too noisy to be the verdict, so it
  // is reported as a disagreement instead.
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 6 }, () => [1000, 1000, 1000]) },
        head: { samples: Array.from({ length: 6 }, () => [1000, 1500, 1500]) },
      },
    }),
    ctx()
  );

  assert.match(body, /moved on the mean but not on the reported figure/);
  assert.match(body, /\+33\.33% on the mean of \*every\* prove/);
  // The heading has to agree with the note directly beneath it. It used to read
  // "No significant change (largest ±0.00%)" above a note reporting +33.33% —
  // self-contradictory, and the heading is the part most readers ever see. It is
  // still not a verdict: unresolved, naming the statistic that moved.
  const heading = body.split("\n")[0];
  assert.doesNotMatch(heading, /No significant change/);
  assert.match(heading, /^### ❔ Unresolved: nothing clears the/);
  assert.match(heading, /mean of all proves is \+33\.33% slower/);

  // And an improvement on the mean must not be announced as a slowdown.
  const faster = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 6 }, () => [1000, 1500, 1500]) },
        head: { samples: Array.from({ length: 6 }, () => [1000, 1000, 1000]) },
      },
    }),
    ctx()
  );
  assert.match(faster.split("\n")[0], /mean of all proves is -25\.00% faster/);
});

test("does not cry mean-only when the two statistics agree", () => {
  // The note must not appear on an ordinary run, or it becomes the thing readers
  // learn to skip past.
  const agreeing = renderComment(results(), ctx());
  assert.doesNotMatch(agreeing, /moved on the mean but not/);

  // Nor when the headline itself already cleared the floor — the movement is
  // reported normally in that case and a second note would just be noise.
  const clear = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 6 }, () => [1000, 1000, 1000]) },
        head: { samples: Array.from({ length: 6 }, () => [1200, 1200, 1200]) },
      },
    }),
    ctx()
  );
  assert.match(clear, /slower/);
  assert.doesNotMatch(clear, /moved on the mean but not/);
});

test("will not call a movement significant on too few repetitions", () => {
  // `reps` is artifact-authored, and the paired sign test's any-direction
  // false-positive rate is 1/2^(reps-1) — at one repetition it passes
  // unconditionally. So a fork wanting a verdict it had not earned only had to
  // send fewer repetitions: one rep, one prove, any magnitude, and the comment
  // said "+40.00% slower" with a straight face.
  //
  // The floor is the CALIBRATED repetition count, not the point where the sign
  // test alone starts to bite. ±5.40% is 3σ of the estimator measured at six
  // repetitions and the estimator's spread shrinks with 1/√reps, so below six
  // the magnitude leg quietly weakens at the same time as the sign leg: at four
  // the joint false-positive rate would be 1.07% against six's 0.15%, measured
  // with the floor lifted so four can produce a verdict at all.
  for (const reps of [1, 2, 3, 4, 5]) {
    const body = renderComment(
      results({
        top: {
          reps,
          provesPerRep: 3,
          repsExecuted: reps + 1,
          provesExecutedPerRep: 4,
        },
        benchmark: {
          base: {
            samples: Array.from({ length: reps }, () => [100, 100, 100]),
          },
          head: {
            samples: Array.from({ length: reps }, () => [140, 140, 140]),
          },
        },
      }),
      ctx()
    );
    const heading = body.split("\n")[0];
    assert.match(heading, /Unresolved/, `reps=${reps} produced a verdict`);
    assert.doesNotMatch(heading, /slower/, `reps=${reps} named a direction`);
    // And it says WHY. "its repetitions disagree" would be a description of a
    // disagreement that cannot exist in a one-repetition run.
    assert.match(heading, /too few to tell a real movement from noise/);
    assert.doesNotMatch(heading, /repetitions disagree/);
    assert.match(benchmarkRows(body)[0], /❔/u);
  }

  // Six is where a verdict becomes publishable, so the same movement IS a result
  // there. Without this the assertions above would also pass if the renderer had
  // simply stopped reporting movements altogether.
  const six = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 6 }, () => [100, 100, 100]) },
        head: {
          samples: [
            [140, 140, 140],
            [141, 141, 141],
            [139, 139, 139],
            [140, 140, 140],
            [142, 142, 142],
            [138, 138, 138],
          ],
        },
      },
    }),
    ctx()
  );
  assert.match(six.split("\n")[0], /⚠️ \+4[01]\.\d\d% slower/);
});

test("a traversal run url degrades to text instead of linking elsewhere", () => {
  // The guard's comment claimed it was tightened against `..` while the regex
  // still accepted it, so a run url of https://github.com/../../actions/runs/N
  // would have rendered as a link GitHub normalizes to a different repo. Both
  // values are trusted, so this is defence in depth — but a guard that does not
  // do what it says is worse than no guard.
  for (const runUrl of [
    "https://github.com/../../actions/runs/12",
    "https://github.com/../web-sdk/actions/runs/12",
    "https://github.com/0xMiden/../actions/runs/12",
    "http://github.com/0xMiden/web-sdk/actions/runs/12",
  ]) {
    const body = renderComment(results(), ctx({ runUrl }));
    assert.doesNotMatch(body, /\.\.\//, `linked a traversal: ${runUrl}`);
    assert.doesNotMatch(
      body,
      new RegExp(`\\(${runUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`)
    );
  }
  // The real shape still links.
  const ok = renderComment(
    results(),
    ctx({ runUrl: "https://github.com/0xMiden/web-sdk/actions/runs/12" })
  );
  assert.match(
    ok,
    /https:\/\/github\.com\/0xMiden\/web-sdk\/actions\/runs\/12/
  );
});

test("a run that leaked resources says so above its numbers", () => {
  const body = renderComment(
    results({ top: { teardownFailures: ["base context: Error: boom"] } }),
    ctx()
  );
  assert.match(body, /Treat these numbers with suspicion/);
  assert.match(body, /reported 1 teardown failure/);
  assert.match(body, /base context: Error: boom/);
  // Above the comparison notes, so it qualifies what follows.
  assert.ok(
    body.indexOf("Treat these numbers with suspicion") <
      body.indexOf("Methodology")
  );
});

test("teardown failures are fork-controlled and treated as such", () => {
  const hostile = [
    "`rm -rf /` <img src=x onerror=alert(1)>",
    "x".repeat(500),
    "::error::spoofed",
    ...Array.from({ length: 40 }, (_unused, i) => `filler ${i}`),
  ];
  const body = renderComment(
    results({ top: { teardownFailures: hostile } }),
    ctx()
  );
  assert.match(body, /reported 8 teardown failures/); // capped
  assert.doesNotMatch(body, /<img/);
  assert.doesNotMatch(body, /^::error::/m);
  for (const line of body.split("\n").filter((l) => l.startsWith("> - "))) {
    // Wrapped in a code span, and the two backticks are part of the budget.
    assert.match(line, /^> - `.*`$/, `entry not in a code span: ${line}`);
    assert.ok(line.length <= 4 + 120 + 2, `entry not capped: ${line.length}`);
  }
});

test("no rendered line can be read as a workflow command", () => {
  // The renderer writes the comment body to stdout in a job holding a write
  // token. A `::`-prefixed line at column 0 is a workflow command, and the only
  // fork-controlled strings that reach column 0 are the benchmark name (inside
  // the samples fence) and the teardown entries.
  const hostile = "::error title=Injected::fake";
  const body = renderComment(
    results({
      benchmark: { name: hostile },
      top: { teardownFailures: [hostile] },
    }),
    ctx()
  );
  for (const line of body.split("\n")) {
    assert.ok(
      !line.startsWith("::"),
      `line reads as a workflow command: ${line}`
    );
  }
});

test("teardown failures cannot carry an autolink into the comment", () => {
  // The same payloads the benchmark-name test uses, against the other
  // fork-controlled string this file renders. These entries were interpolated as
  // raw GFM, so every one of them reached the privileged comment live: a link
  // reading "Security review passed", a remote image, and `#1` — which makes
  // GitHub write a cross-reference onto the target issue under this repo's own
  // bot identity. `sanitizeText` does not touch markdown link, image, autolink,
  // cross-reference or emoji syntax; only the code span does.
  const payloads = [
    "[Security review passed](https://evil.example/x)",
    "![](https://evil.example/beacon.png)",
    "reverted in #1 and 0xMiden/miden-client#1965",
    "GH-1234 tracks this",
    "https://evil.example/pwn?x=1",
    ":white_check_mark: approved",
    "[x] pwned",
  ];
  const body = renderComment(
    results({ top: { teardownFailures: payloads } }),
    ctx()
  );
  assert.match(body, /reported 7 teardown failures/);
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) break;
    const cleaned = line.replace(/`[^`]*`/g, "");
    assert.doesNotMatch(
      cleaned,
      /https?:\/\/evil\.example|:white_check_mark:|GH-\d|#1\b|\[x\]/,
      `a teardown entry escaped its code span on line: ${line}`
    );
  }
});

test("a garbage teardownFailures field is ignored, not fatal", () => {
  for (const value of [null, "boom", 7, {}, [{}, [], null]]) {
    const body = renderComment(
      results({ top: { teardownFailures: value } }),
      ctx()
    );
    if (Array.isArray(value) && value.length > 0) {
      // Non-strings become placeholders rather than being dropped: the COUNT is
      // the load-bearing part and dropping entries would understate it.
      assert.match(body, /reported 3 teardown failures/);
      assert.match(body, /teardown failure #1 \(not a string\)/);
      assert.doesNotMatch(body, /\[object Object\]/);
    } else {
      assert.doesNotMatch(body, /Treat these numbers with suspicion/);
    }
  }
});

test("a mixed null-base and zero-base report says so", () => {
  // Three ways to have no comparable row, and they were sharing two sentences.
  // "No base measurements" is false when some rows HAVE a base, and "every
  // benchmark's base figure is zero" is false when some rows have no base side
  // at all. The old regex for the zero-base heading also matched the mixed
  // string, so the branch could have fallen through undetected.
  const body = renderComment(
    results({
      top: {
        benchmarks: [
          bench("no-base", null, side(10)),
          bench("zero-base", side(0), side(10)),
        ],
      },
    }),
    ctx()
  );
  const heading = body.split("\n")[0];
  assert.match(
    heading,
    /some benchmarks have no base measurement and the rest have a base figure of zero/
  );
  // And the mixed row still gets a note explaining what its ❔ means, which the
  // head-only note cannot supply because it is gated on EVERY row lacking a base.
  assert.match(body, /1 of 2 benchmarks have no base measurement/);
  assert.match(body, /nothing to compare against — not that the repetitions/);
});

test("a mean-only row carries the emoji its heading claims", () => {
  // The heading for a mean-only movement says ❔, and the legend glosses ❔. If
  // the row itself renders ➖ ("within the noise floor") the reader is sent to
  // find a ❔ that appears nowhere in the report.
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
      },
      benchmark: {
        base: { samples: Array.from({ length: 6 }, () => [1000, 1000, 1000]) },
        head: { samples: Array.from({ length: 6 }, () => [1000, 1500, 1500]) },
      },
    }),
    ctx()
  );
  assert.match(body.split("\n")[0], /❔/u);
  assert.match(benchmarkRows(body)[0], /❔/u);
  assert.doesNotMatch(benchmarkRows(body)[0], /➖/u);
});

test("a zero base figure is not reported as a head-only run", () => {
  // deltaPct is null both when there is no base side and when the base figure is
  // zero, and the verdict keyed on that while the head-only BANNER keyed on
  // `base === null`. A zero base therefore printed "no base measurements to
  // compare against" directly above a table of base measurements.
  const body = renderComment(
    results({
      benchmark: {
        base: { samples: Array.from({ length: REPS }, () => [0, 1000, 1000]) },
        head: {
          samples: Array.from({ length: REPS }, () => [500, 2000, 2000]),
        },
      },
    }),
    ctx()
  );

  assert.doesNotMatch(body, /no base measurements to compare against/);
  // Anchored on the ALL-zero wording: /base figure is zero/ alone also matches
  // the mixed heading ("…and the rest have a base figure of zero"), so this
  // assertion would have passed even if the mixed case fell through to here.
  assert.match(body.split("\n")[0], /every benchmark's base figure is zero/);
  // And it is not dressed up as an unchanged benchmark either: there is no
  // comparison here, which is ❔, not ➖.
  assert.match(benchmarkRows(body)[0], /❔/u);
  assert.doesNotMatch(benchmarkRows(body)[0], /➖/u);
});

test("the mean cross-check follows the direction it found", () => {
  // The note fires on |mean movement|, so it has to explain both signs. An
  // optimisation that only helps the SLOW proves lands here too, and calling
  // that an invisible slowdown is exactly backwards.
  const faster = renderComment(
    results({
      benchmark: {
        base: {
          samples: Array.from({ length: REPS }, () => [1000, 2000, 2000]),
        },
        head: {
          samples: Array.from({ length: REPS }, () => [1000, 1000, 1000]),
        },
      },
    }),
    ctx()
  );
  assert.match(faster, /moved on the mean but not on the reported figure/);
  assert.match(faster, /an improvement that only helps the SLOWER/);
  assert.doesNotMatch(faster, /think a collection pause/);

  // No borrowed sigma IN THE NOTE: the old copy quoted 5.39% as this
  // statistic's spread, but 5.39% is the measured spread of a MEDIAN over all
  // samples. The methodology table still cites it correctly, hence scoping the
  // assertion to the note rather than the whole body.
  const note = faster
    .split("\n\n")
    .find((block) => block.includes("moved on the mean but not"));
  assert.doesNotMatch(note, /5\.39%/);
  assert.match(note, /never been calibrated on this workload/);
});

test("the mean cross-check holds itself to the same sign test", () => {
  // One repetition carrying the whole mean movement is the same defect the
  // headline verdict was fixed for in an earlier round. Gating the note on
  // magnitude alone would have reintroduced it on the cross-check.
  const oneRepDominates = renderComment(
    results({
      benchmark: {
        base: {
          samples: Array.from({ length: REPS }, () => [1000, 1000, 1000]),
        },
        head: {
          samples: Array.from({ length: REPS }, (_unused, rep) =>
            rep === 0 ? [1000, 9000, 9000] : [1000, 1000, 1000]
          ),
        },
      },
    }),
    ctx()
  );
  // The mean over all proves moved far past the floor, but only one repetition
  // moved at all, so there is nothing to report.
  assert.doesNotMatch(oneRepDominates, /moved on the mean but not/);
});

// A change that moves the fastest prove of each repetition one way and the rest
// of the distribution the other satisfies BOTH estimators, in opposite
// directions — and nothing was checking that they agreed. `meanOnly` and
// `meanLarge` are `!clearsFloor` by construction, so once the headline ruled the
// contradicting figure vanished from the comment entirely and the reader saw
// "🚀 6.00% faster" over a run whose mean prove time had risen by two thirds.
test("a mean that contradicts the headline withdraws the direction", () => {
  const body = renderComment(
    results({
      benchmark: {
        // Fastest prove 6% faster in every repetition, the other two 100%
        // slower in every repetition: both directions hold in 6 of 6.
        base: {
          samples: Array.from({ length: REPS }, () => [1000, 1000, 1000]),
        },
        head: {
          samples: Array.from({ length: REPS }, () => [940, 2000, 2000]),
        },
      },
    }),
    ctx()
  );
  const heading = body.split("\n")[0];
  // The heading is the only part of this comment most readers see, so it is the
  // part that must not name a direction.
  assert.match(heading, /Unresolved: the two estimators disagree/);
  assert.doesNotMatch(heading, /faster|slower/);
  assert.doesNotMatch(heading, /🚀|⚠️/);
  // Both figures present, so the reader can see what disagreed.
  assert.match(body, /-6\.00%/);
  assert.match(body, /\+64\.67%/);
  assert.match(body, /moved both ways/);
  // The row withholds its verdict too, rather than showing a clean improvement
  // under a heading that declined to rule.
  assert.match(body, /^\| ❔ \| `prove \/ consume \/ ecdsa-k256-keccak`/m);
});

// The mirror case: the two estimators agree on the direction, so the headline
// keeps it. Without this the fix above could pass by never ruling at all.
test("a mean that agrees with the headline leaves the direction alone", () => {
  const body = renderComment(
    results({
      benchmark: {
        base: {
          samples: Array.from({ length: REPS }, () => [1000, 1000, 1000]),
        },
        head: {
          samples: Array.from({ length: REPS }, () => [1100, 2000, 2000]),
        },
      },
    }),
    ctx()
  );
  assert.match(body.split("\n")[0], /\+10\.00% slower/);
  assert.doesNotMatch(body, /moved both ways/);
});

// The mean cross-check was gated on `agreement.blocked`, which covers only one
// of the two reasons a run cannot rule. Below six repetitions
// `pairedMeanAgreement` answers `tooShort` and can never be `consistent`, so
// `meanOnly` is unreachable and `meanLarge` was filtered out — leaving a run
// whose mean prove time had risen by two thirds headlined "No significant
// change", above a methodology section pointing at a cross-check that was not
// in the comment.
test("a short run still reports a mean that moved", () => {
  const shortReps = 4;
  const body = renderComment(
    results({
      top: {
        reps: shortReps,
        repsExecuted: shortReps + 1,
        repsRequested: shortReps,
      },
      benchmark: {
        base: {
          samples: Array.from({ length: shortReps }, () => [1000, 1000, 1000]),
        },
        head: {
          samples: Array.from({ length: shortReps }, () => [1000, 2000, 2000]),
        },
      },
    }),
    ctx()
  );
  assert.doesNotMatch(body, /No significant change/);
  assert.match(body, /Unresolved/);
  assert.match(body, /\+66\.67%/);
  assert.match(body, /moved on the mean of every prove/);
  // The reason has to be stated in the note: a short run carries no other note
  // saying why it cannot rule, so "for the reason above" would point at nothing.
  assert.match(body, /4 repetitions is too few to rule on either figure/);
});

// On a calibration run base and head are the SAME build, so the true difference
// is zero and any movement is this runner's noise. `ctx.calibration` reached only
// the note, which left the heading asserting a direction directly above a banner
// saying every number below it is measurement noise — and a movement past the
// floor is the EXPECTED outcome of these runs, not an exotic one, since reading
// the delta off twenty to thirty of them is how the floor gets set.
test("a calibration run never headlines a direction", () => {
  const artifact = results({
    benchmark: { base: side(1000), head: side(1080) },
  });
  const calibrated = renderComment(artifact, ctx({ calibration: true }));
  const heading = calibrated.split("\n")[0];
  assert.doesNotMatch(heading, /slower|faster/);
  assert.doesNotMatch(heading, /🚀|⚠️/);
  assert.match(heading, /Unresolved/);
  // The magnitude survives — the run exists to measure it.
  assert.match(calibrated, /\+8\.00%/);
  assert.match(calibrated, /moved past the floor on a calibration run/);
  assert.match(calibrated, /\*\*Calibration run\.\*\*/);

  // Same artifact without the flag still rules, so the gate has not simply been
  // made to always fire.
  assert.match(
    renderComment(artifact, ctx()).split("\n")[0],
    /\+8\.00% slower/
  );
});

// The contradiction heading was returned ahead of every other branch, so a
// SECOND benchmark that regressed cleanly vanished from the heading — not even
// counted in "(+N more)". That is the exact failure the regression branch below
// it was written to prevent.
test("a clean regression outranks a contradicted benchmark in the heading", () => {
  const flat = (v) => ({
    samples: Array.from({ length: REPS }, () => [v, v, v]),
  });
  const contradicting = {
    samples: Array.from({ length: REPS }, () => [900, 2000, 2000]),
  };
  const withRegression = renderComment(
    results({
      benchmark: {},
      top: {
        benchmarks: [
          bench("A-contradicting", flat(1000), contradicting),
          bench("B-real-regression", flat(1000), flat(1250)),
        ],
      },
    }),
    ctx()
  );
  const heading = withRegression.split("\n")[0];
  assert.match(heading, /\+25\.00% slower/);
  assert.match(heading, /B-real-regression/);
  // The contradicted benchmark is still counted, so nothing that cleared the
  // floor disappears from the heading.
  assert.match(heading, /\(\+1 more\)/);
  // And the contradiction is still explained below.
  assert.match(withRegression, /moved both ways/);

  // With no regression to defer to, the contradiction owns the heading again.
  const withoutRegression = renderComment(
    results({
      benchmark: {},
      top: {
        benchmarks: [bench("A-contradicting", flat(1000), contradicting)],
      },
    }),
    ctx()
  );
  assert.match(
    withoutRegression.split("\n")[0],
    /Unresolved: the two estimators disagree/
  );
});

// `reps` is the RETAINED count, so `repsRequested - reps` mixes repetitions the
// budget never funded with one that ran to completion and was then discarded to
// keep the setup order balanced. `repsExecuted` is the discriminator — it was
// validated and then dropped from `normalizeResults`, so the note asserted "never
// attempted" for both.
test("a repetition dropped for balance is not called never attempted", () => {
  const stopped = (repsExecuted) =>
    results({
      top: {
        reps: REPS,
        repsRequested: REPS + 2,
        repsExecuted,
        stoppedEarly: "the step budget is exhausted",
        stoppedEarlyKind: "budget",
      },
    });

  // reps + 2: one repetition finished and was discarded for parity, so only one
  // of the two dropped was never attempted.
  const withBalanceDrop = renderComment(stopped(REPS + 2), ctx());
  assert.match(withBalanceDrop, /One repetition was never attempted/);
  assert.match(withBalanceDrop, /discarded, because retaining it would have/);
  assert.doesNotMatch(withBalanceDrop, /2 repetitions were never attempted/);

  // reps + 1: nothing was dropped for parity, so both really were unfunded.
  const withoutBalanceDrop = renderComment(stopped(REPS + 1), ctx());
  assert.match(withoutBalanceDrop, /2 repetitions were never attempted/);
  assert.doesNotMatch(withoutBalanceDrop, /discarded, because retaining/);
});

// `setupCount` is the sample size the deadline note presents as the evidence for
// whether the work was stuck. A standalone ceiling of 10,000 let a
// seven-repetition run claim a median "over 4,000 samples"; every executed
// repetition sets up at most both sides, which is a bound the renderer has
// already cross-checked.
test("setupCount is bounded by the repetitions that ran", () => {
  const withSetupCount = (setupCount) =>
    results({
      top: {
        reps: REPS,
        repsRequested: REPS + 2,
        repsExecuted: REPS + 1,
        stoppedEarly: "prove overran",
        stoppedEarlyKind: "deadline",
        stoppedEarlyDeadlineMs: 320_000,
        setupMsMedian: 90_900,
        setupCount,
      },
    });
  // 2 × 7 executed repetitions is the ceiling.
  assert.doesNotThrow(() =>
    renderComment(withSetupCount(2 * (REPS + 1)), ctx())
  );
  assert.throws(
    () => renderComment(withSetupCount(2 * (REPS + 1) + 1), ctx()),
    /setupCount must be at most 14/
  );
  assert.throws(() => renderComment(withSetupCount(4000), ctx()), /setupCount/);
});

// A median setup cost ABOVE the reported deadline is the expected shape of a
// late-run overrun — the grant is clamped to the budget's remainder — and neither
// "well under" nor "close to" describes it.
test("a setup median past the deadline gets its own reading", () => {
  const body = renderComment(
    results({
      top: {
        reps: REPS,
        repsRequested: REPS + 2,
        repsExecuted: REPS + 1,
        stoppedEarly: "setup overran",
        stoppedEarlyKind: "deadline",
        stoppedEarlyDeadlineMs: 70_000,
        setupMsMedian: 90_000,
        setupCount: 5,
      },
    }),
    ctx()
  );
  assert.match(body, /already exceeds the deadline, so the clock was short/);
  assert.doesNotMatch(body, /Well under the deadline means it was stuck/);
});

// Every other field on the trusted context gets a shape check; `runId` was
// sanitized instead, and it is interpolated as markdown link TEXT where
// `sanitizeText` leaves `](` intact.
test("a malformed run id is a first-party error, not sanitized text", () => {
  for (const runId of ["12](https://evil.example/", "", "abc", null]) {
    assert.throws(
      () => renderComment(results(), ctx({ runId })),
      /rendering context: ctx\.runId is not a run id/
    );
  }
  // And a real one still renders as a link.
  assert.match(renderComment(results(), ctx()), /\[bench run 32568739941\]/);
});

// The renderer decides whether it was invoked as a script by comparing its own
// module URL against argv[1]. Node derives the former from the resolved path and
// leaves the latter as typed, so an unresolved comparison silently declined to
// run behind any symlink — exiting 0 having rendered nothing, which the reporting
// workflow reads as success with nothing to say. A refusal must look like a
// refusal.
test("invoking the renderer through a symlink still runs it", () => {
  const script = fileURLToPath(
    new URL("./render-bench-comment.mjs", import.meta.url)
  );
  const dir = mkdtempSync(join(tmpdir(), "render-symlink-"));
  const link = join(dir, "linked-renderer.mjs");
  symlinkSync(script, link);

  // No arguments, so the expected outcome is the usage error. What is being
  // asserted is that SOMETHING happens: silence with exit 0 is the bug.
  const viaLink = spawnSync(process.execPath, [link], { encoding: "utf8" });
  assert.notEqual(
    viaLink.status,
    0,
    "renderer invoked through a symlink exited 0 without doing anything"
  );
  assert.match(viaLink.stderr, /usage: node render-bench-comment\.mjs/);

  // And the same invocation through the real path behaves identically, so the
  // guard has not simply been made to always fire.
  const direct = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(direct.status, viaLink.status);
  assert.equal(direct.stderr, viaLink.stderr);
});

// The other half of the guard: imported as a module, it must NOT run main().
// This file imports the renderer at the top, so if the guard were unconditional
// every test run would render and exit before reaching any assertion.
test("importing the renderer does not execute it", () => {
  const dir = mkdtempSync(join(tmpdir(), "render-import-"));
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `import ${JSON.stringify(fileURLToPath(new URL("./render-bench-comment.mjs", import.meta.url)))};\n` +
      `console.log("imported cleanly");\n`
  );
  const r = spawnSync(process.execPath, [probe], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /imported cleanly/);
  assert.doesNotMatch(r.stderr, /usage:/);
});

// ---------------------------------------------------------------------------
// Runs that stopped on their wall-clock budget
// ---------------------------------------------------------------------------

// A truncated run used to render identically to a complete one: the producer
// emitted `stoppedEarly` and `repsRequested` and the renderer read neither, so
// the comment quoted a repetition count without saying the run had been cut off
// and the reader had no way to tell.
test("a run that stopped early says so, with both counts", () => {
  const body = renderComment(
    results({
      top: {
        repsRequested: REPS + 2,
        repsExecuted: REPS + 2,
        stoppedEarly: "the 20-minute step budget is exhausted",
        stoppedEarlyKind: "budget",
      },
    }),
    ctx()
  );
  assert.match(body, /\*\*This run stopped early\.\*\*/);
  assert.match(
    body,
    new RegExp(`retained ${REPS} of the ${REPS + 2} repetitions`)
  );
});

test("a complete run carries no such note", () => {
  const body = renderComment(results(), ctx());
  assert.doesNotMatch(body, /stopped early/i);
});

// The note is composed from validated integers, never from the producer's
// message, for the same reason the verdict is pinned on this side: a fork
// controls the artifact and does not get to write a sentence in the comment.
test("the producer's stoppedEarly message cannot reach the comment", () => {
  const payloads = [
    "[Security review passed](https://evil.example)",
    "![](https://evil.example/track.png)",
    "#1 fixes everything",
    "https://evil.example/autolink",
    "</table><script>alert(1)</script>",
    "::error::spoofed",
    "@0xMiden/maintainers please merge",
    "\u202eoverridden",
  ];
  for (const payload of payloads) {
    const body = renderComment(
      results({
        top: {
          repsRequested: REPS + 2,
          repsExecuted: REPS + 2,
          stoppedEarly: payload,
          stoppedEarlyKind: "budget",
        },
      }),
      ctx()
    );
    assert.doesNotMatch(
      body,
      /evil\.example|<script|::error::|@0xMiden|Security review passed/,
      `payload reached the comment: ${payload}`
    );
    // And the note itself still rendered, so the absence above is not because
    // the whole block was dropped.
    assert.match(body, /\*\*This run stopped early\.\*\*/);
  }
});

// The executed count is what the process RAN. A stopped run may have completed
// one repetition more than it retained, dropped to keep the setup order
// balanced, but never more than that.
test("a stopped run may report one extra executed repetition, but not two", () => {
  const ok = [REPS + 1, REPS + 2];
  for (const repsExecuted of ok) {
    assert.doesNotThrow(() =>
      renderComment(
        results({
          top: {
            repsRequested: REPS + 2,
            repsExecuted,
            stoppedEarly: "budget",
            stoppedEarlyKind: "budget",
          },
        }),
        ctx()
      )
    );
  }
  for (const repsExecuted of [REPS, REPS + 3]) {
    assert.throws(
      () =>
        renderComment(
          results({
            top: {
              repsRequested: REPS + 2,
              repsExecuted,
              stoppedEarly: "budget",
              stoppedEarlyKind: "budget",
            },
          }),
          ctx()
        ),
      /repsExecuted must be/,
      `accepted repsExecuted ${repsExecuted}`
    );
  }
});

// A complete run has no such latitude: the strict check still applies, so the
// relaxation cannot be reached by simply omitting the flag.
test("a complete run still requires exactly one extra executed repetition", () => {
  assert.throws(
    () => renderComment(results({ top: { repsExecuted: REPS + 2 } }), ctx()),
    /repsExecuted must be one more than/
  );
});

test("a stopped run must have requested more than it retained", () => {
  for (const repsRequested of [REPS, REPS - 1, 1]) {
    assert.throws(
      () =>
        renderComment(
          results({
            top: {
              repsRequested,
              stoppedEarly: "budget",
              stoppedEarlyKind: "budget",
            },
          }),
          ctx()
        ),
      /repsRequested must exceed/,
      `accepted repsRequested ${repsRequested}`
    );
  }
});

test("a stopped run without a requested count is refused", () => {
  assert.throws(
    () =>
      renderComment(
        results({
          top: { stoppedEarly: "budget", stoppedEarlyKind: "budget" },
        }),
        ctx()
      ),
    /repsRequested/
  );
});

// The advice on a short run has to match why it was short. A truncated run
// already used the default repetition count, so "re-run with the default
// `--reps`" told its author to do what they had already done — and more
// repetitions would miss the budget by more, so the advice was also circular.
// The calibrated 3 retained proves, so that a test about repetitions is not
// silently answered by the prove floor instead.
const shortRun = (reps, top = {}) => ({
  top: {
    reps,
    provesPerRep: 3,
    repsExecuted: reps + 1,
    provesExecutedPerRep: 4,
    ...top,
  },
  benchmark: {
    base: { samples: Array.from({ length: reps }, () => [100, 100, 100]) },
    head: { samples: Array.from({ length: reps }, () => [140, 140, 140]) },
  },
});

// A run whose length was decided by the clock is a selected sample: it ran until
// the machine was too slow to continue, and how slow the machine was is the
// quantity being measured. That selection cancels out of the PAIRED delta only
// when both sides have equal run-level variance — the correlation between the
// total duration and the difference is Var(head) - Var(base). Simulated over this
// producer's interleave, symmetric run-level noise leaves the truncated estimate
// unbiased to -0.19pp while a 12% factor on ONE side moves it -18.90pp or
// +22.66pp — several times the 5.40% floor, not a fraction of it. Nothing has
// measured that equality on this workload, so a
// truncated run reports its numbers and withholds the ruling.
test("a run that stopped early never publishes a verdict, at any length", () => {
  // Well ABOVE the repetition floor, which is the case the floor cannot catch:
  // truncating the calibrated request of six cannot leave more than four, but a
  // dispatch at a higher --reps truncates to a count that clears six easily.
  for (const [retained, requested] of [
    [6, 8],
    [8, 12],
    [12, 20],
    [30, 40],
  ]) {
    const body = renderComment(
      results(
        shortRun(retained, {
          repsRequested: requested,
          repsExecuted: retained + 1,
          stoppedEarly: "the 20-minute step budget is exhausted",
          stoppedEarlyKind: "budget",
        })
      ),
      ctx()
    );
    assert.match(
      body,
      /Unresolved/,
      `retained ${retained} of ${requested} was ruled on`
    );
    assert.doesNotMatch(
      body,
      /### (⚠️|✅)/,
      `retained ${retained} of ${requested} published a confident verdict`
    );
    assert.match(body, /stopped early/);
    // And it must say the numbers are still real, so the note does not read as
    // "the run failed".
    assert.match(body, /real measurements/);
  }
});

// Same rule, second channel. The mean-of-all-proves cross-check is also a
// directional claim, so a truncated run must not make it either — a comment whose
// headline declined to rule while its note asserted a mean movement would be
// contradicting itself.
// A blocked run does not get a second confident channel — but suppressing the
// mean entirely meant a head 46% worse on the mean of every prove rendered as
// "No significant change" with nothing else on the page, which is a stronger
// claim than the one being withheld. So the figure is reported and the ruling is
// not: no direction, no repetition-agreement count, no verdict emoji.
test("a stopped run reports a moved mean without ruling on it", () => {
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
        repsRequested: 10,
        stoppedEarly: "the 20-minute step budget is exhausted",
        stoppedEarlyKind: "budget",
      },
      benchmark: {
        // Below the floor on the headline (minima are equal) but far beyond it on
        // the mean of all proves — the exact shape that triggers the mean-only
        // note.
        base: { samples: Array.from({ length: 6 }, () => [100, 100, 100]) },
        head: { samples: Array.from({ length: 6 }, () => [100, 200, 200]) },
      },
    }),
    ctx()
  );
  // The figure survives.
  assert.match(body, /mean of all proves is \+66\.67%/);
  assert.match(body, /not as a finding/);
  // The claims do not.
  assert.doesNotMatch(body, /### (⚠️|✅)/);
  assert.doesNotMatch(body, /in the same direction in \d+ of \d+/);
  assert.doesNotMatch(body, /No significant change/);
  // And it is still blocked from a verdict for the original reason.
  assert.match(body, /cannot be ruled on/);
});

// The producer stopped guessing why a run ran past a deadline; for one commit this
// file was still asserting one, telling every truncated run — a rayon deadlock in
// the head build included — that it "ran out of its wall-clock budget" and to raise
// `timeout-minutes`. The kind now comes from the artifact as a closed enum and the
// wording follows it.
test("a deadline overrun is not reported as the budget running out", () => {
  const stopped = (extra) => ({
    top: {
      reps: 6,
      provesPerRep: 3,
      repsExecuted: 7,
      provesExecutedPerRep: 4,
      repsRequested: 10,
      stoppedEarly: "whatever the producer wrote here",
      ...extra,
    },
  });

  const overran = renderComment(
    results(
      stopped({
        stoppedEarlyKind: "deadline",
        stoppedEarlyDeadlineMs: 320_000,
        setupMsMedian: 90_900,
        setupCount: 7,
      })
    ),
    ctx()
  );
  // States both possibilities and hands over the two numbers that separate them.
  assert.match(overran, /ran past its 320s deadline/);
  assert.match(overran, /took 91s at the median over 7 samples/);
  assert.match(overran, /stuck or simply/);
  // And gives none of the advice that only fits the other cause.
  assert.doesNotMatch(overran, /ran out of its wall-clock budget/);
  assert.doesNotMatch(overran, /budget is too tight/);
  assert.doesNotMatch(overran, /raise the benchmark step's/i);

  // The budget case is the certain one, so it keeps the definite advice.
  const ranOut = renderComment(
    results(stopped({ stoppedEarlyKind: "budget" })),
    ctx()
  );
  assert.match(ranOut, /never attempted/);
  assert.match(ranOut, /budget is too tight/);
  assert.doesNotMatch(ranOut, /deadline/);
});

// Both of these are wall-clock durations derived from `performance.now()`, which
// is fractional: a clamped deadline carries the fraction through, and a median
// over an even number of setups is the average of the two middle ones. Requiring
// an integer therefore refused the entire artifact — exit 64, no comment at all
// — on every deadline overrun that had completed a setup, which is the one case
// where the comment is carrying the diagnostic the reader needs.
test("fractional millisecond durations are rendered, not refused", () => {
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
        repsRequested: 10,
        stoppedEarly: "prove overran its deadline",
        stoppedEarlyKind: "deadline",
        stoppedEarlyDeadlineMs: 320_000.5678,
        setupMsMedian: 90_900.4321,
        setupCount: 8,
      },
    }),
    ctx()
  );
  assert.match(body, /ran past its 320s deadline/);
  assert.match(body, /took 91s at the median over 8 samples/);
});

test("too few setup samples to lean on is disclosed rather than implied", () => {
  // The manual read the comment suggests — deadline well above the median means
  // stuck — is the rule that failed seven rounds when the sample was one. So the
  // comment says when there is not enough to lean on.
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 3,
        repsExecuted: 7,
        provesExecutedPerRep: 4,
        repsRequested: 10,
        stoppedEarly: "x",
        stoppedEarlyKind: "deadline",
        stoppedEarlyDeadlineMs: 320_000,
        setupMsMedian: 310_000,
        setupCount: 1,
      },
    }),
    ctx()
  );
  assert.match(body, /too few to lean on/);
  assert.doesNotMatch(body, /means it was stuck/);
});

test("an unrecognized stop kind refuses the artifact rather than guessing", () => {
  for (const kind of ["", "Budget", "hang", 0, null, {}, ["budget"]]) {
    assert.throws(
      () =>
        renderComment(
          results({
            top: {
              repsRequested: 10,
              stoppedEarly: "x",
              stoppedEarlyKind: kind,
            },
          }),
          ctx()
        ),
      /stoppedEarlyKind must be one of/,
      `kind ${JSON.stringify(kind)} was accepted`
    );
  }
});

// `reps` is artifact-authored, so the producer refusing an odd count does not stop
// one arriving. An odd count sets one side up first once more than the other, a
// fixed positional difference repetitions cannot average away, and it is above the
// floor from seven up — so without this it bought a fully confident verdict.
test("an odd repetition count never publishes a verdict", () => {
  for (const reps of [7, 9, 15]) {
    const body = renderComment(results(shortRun(reps)), ctx());
    assert.match(body, /Unresolved/, `${reps} reps was ruled on`);
    assert.doesNotMatch(
      body,
      /### (⚠️|✅)/,
      `${reps} reps published a confident verdict`
    );
    assert.match(body, /odd repetition count/);
  }
});

// The threshold is 3σ of an estimator measured over the fastest of three warm
// proves. The minimum of fewer proves is noisier, so the same fixed floor is under
// 3σ there — the identical argument that blocks a verdict below the repetition
// floor, on the other axis. `provesPerRep` is artifact-authored, so before this a
// one-rep-one-prove artifact was the cheapest route to a confident verdict.
test("too few proves per repetition never publishes a verdict", () => {
  for (const proves of [1, 2]) {
    const body = renderComment(
      results({
        top: {
          reps: 6,
          provesPerRep: proves,
          repsExecuted: 7,
          provesExecutedPerRep: proves + 1,
        },
        benchmark: {
          base: {
            samples: Array.from({ length: 6 }, () =>
              Array.from({ length: proves }, () => 100)
            ),
          },
          head: {
            samples: Array.from({ length: 6 }, () =>
              Array.from({ length: proves }, () => 140)
            ),
          },
        },
      }),
      ctx()
    );
    assert.match(body, /Unresolved/, `${proves} proves was ruled on`);
    assert.doesNotMatch(
      body,
      /### (⚠️|✅)/,
      `${proves} proves published a confident verdict`
    );
    assert.match(body, /too few proves per repetition/);
  }
});

// Upward is safe and must stay allowed: more proves lower the variance of each
// repetition's minimum, so the fixed floor becomes MORE than 3σ, not less.
test("more proves than calibrated still publishes a verdict", () => {
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 7,
        repsExecuted: 7,
        provesExecutedPerRep: 8,
      },
      benchmark: {
        base: {
          samples: Array.from({ length: 6 }, () =>
            Array.from({ length: 7 }, () => 100)
          ),
        },
        head: {
          samples: Array.from({ length: 6 }, () =>
            Array.from({ length: 7 }, () => 140)
          ),
        },
      },
    }),
    ctx()
  );
  assert.match(body, /### ⚠️ \+40\.00% slower/);
  assert.doesNotMatch(body, /Unresolved/);
});

// The floor outranks the block: a one-repetition run is also an odd-repetition
// run, and "one repetition is too few" is the reason its author can act on.
test("a run below the floor is told it is short, not that it is odd", () => {
  for (const reps of [1, 3, 5]) {
    const body = renderComment(results(shortRun(reps)), ctx());
    assert.match(body, /too few to tell a real movement from noise/);
    assert.doesNotMatch(body, /odd repetition count/);
  }
});

// The guard must not swallow the ordinary case, which is the whole point of the
// bot: a complete, even, calibrated run still rules.
test("a complete even run still publishes a verdict", () => {
  for (const reps of [6, 8, 12]) {
    const body = renderComment(results(shortRun(reps)), ctx());
    assert.match(body, /### ⚠️ \+40\.00% slower/, `${reps} reps did not rule`);
    assert.doesNotMatch(body, /Unresolved/);
    assert.doesNotMatch(body, /stopped early/);
  }
});

test("a truncated unresolved run is told to raise the budget, not the reps", () => {
  const body = renderComment(
    results(
      shortRun(4, {
        repsRequested: 6,
        repsExecuted: 6,
        stoppedEarly: "the 20-minute step budget is exhausted",
        stoppedEarlyKind: "budget",
      })
    ),
    ctx()
  );
  assert.match(body, /Unresolved/);
  assert.match(body, /ran out of its time budget/);
  assert.doesNotMatch(body, /Re-run with the default/);
});

test("a configured-short run keeps the repetition advice", () => {
  const body = renderComment(results(shortRun(4)), ctx());
  assert.match(body, /Unresolved/);
  assert.match(body, /Re-run with the default `--reps`/);
  assert.doesNotMatch(body, /ran out of its time budget/);
});

// ---------------------------------------------------------------------------
// The floor comparison happens at the DISPLAYED precision, which is a deliberate
// choice with a visible consequence either way, so it is pinned here.
//
// Comparing the unrounded magnitude instead would classify a 5.396% movement as
// noise while the same line prints it as "+5.40%" against a floor printed as
// "±5.40%" — a self-contradiction exactly at the boundary a reader stops to
// check. Comparing at the shown precision instead calls that movement a
// movement, which overstates it by 0.004pp.
//
// The shown precision wins because THRESHOLD_PCT is itself rounded: 3 x 1.79%
// is 5.37%, rounded up to 5.4%. The threshold's own precision is ~0.03pp, so
// exactness at 0.004pp is spurious rigour, while the contradiction is real and
// costs the reader's trust in everything else the comment says.
//
// If a future change makes the floor a measured, unrounded number, revisit this:
// the argument depends on the threshold being coarser than the comparison.
// ---------------------------------------------------------------------------

/** Head value whose delta against 1000 displays as `pct` to two decimals. */
const headFor = (pct) => 1000 * (1 + pct / 100);

test("a movement that displays as the floor is treated as reaching it", () => {
  const body = renderComment(
    results({ benchmark: { base: side(1000), head: side(headFor(5.396)) } }),
    ctx()
  );
  assert.match(body, /\+5\.40%/);
  assert.match(
    body,
    /Moved beyond a provisional noise floor/,
    "5.396% displays as +5.40% against a ±5.40% floor; calling it noise would " +
      "contradict the line printing it"
  );
});

test("a movement that displays below the floor is noise", () => {
  const body = renderComment(
    results({ benchmark: { base: side(1000), head: side(headFor(5.394)) } }),
    ctx()
  );
  assert.match(body, /\+5\.39%/);
  assert.doesNotMatch(body, /Moved beyond a provisional noise floor/);
});

test("an exactly unchanged benchmark is never a movement", () => {
  // `magnitude > 0` guards this: with a zero threshold an unchanged benchmark
  // would otherwise clear the floor, and then be labelled an improvement.
  const body = renderComment(
    results({ benchmark: { base: side(1000), head: side(1000) } }),
    ctx()
  );
  assert.doesNotMatch(body, /Moved beyond a provisional noise floor/);
});

test("the unit is a trusted-side claim, not a fork-authored one", () => {
  // A shape check passes `s`, which relabels millisecond samples as seconds while
  // leaving every figure and percentage internally consistent — so nothing in the
  // comment contradicts it. `%` is worse: it presents absolute timings as ratios.
  for (const unit of ["s", "%", "min", "hr", "x", "pct"]) {
    const body = renderComment(
      results({ benchmark: { unit, base: side(1000), head: side(1010) } }),
      ctx()
    );
    assert.doesNotMatch(
      body,
      new RegExp(`\\(${unit}\\)`),
      `the artifact's unit "${unit}" reached the comment`
    );
  }
  // What the producer actually emits still renders.
  assert.match(
    renderComment(
      results({
        benchmark: { unit: "ms", base: side(1000), head: side(1010) },
      }),
      ctx()
    ),
    /\(ms\)/
  );
});
