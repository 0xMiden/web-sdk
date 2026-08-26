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

/** Must match the fixture's `reps` / `provesPerRep`: the shape is enforced. */
const REPS = 2;
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
  schemaVersion: 2,
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
  // base per-rep minima 1000, 1000 -> 1000. Median over all six is 1250 and
  // the global minimum is 1000, so a wrong estimator lands on a different %.
  const body = renderComment(
    results({
      benchmark: {
        base: {
          samples: [
            [1000, 3000, 3000],
            [1000, 3000, 3000],
          ],
        },
        head: {
          samples: [
            [1000, 1020, 5000],
            [1020, 5000, 5000],
          ],
        },
      },
    }),
    ctx()
  );
  // (mean(1000, 1020) - 1000) / 1000 = +1.00%
  assert.match(body, /\+1\.00%/);
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
          perRepMin: [1200, 1200],
          min: 1200,
          median: 1200,
          max: 1200,
          samples: [
            [1000, 1400, 1400],
            [1000, 1400, 1400],
          ],
        },
        head: {
          statistic: "mean-of-per-rep-minima",
          value: 1100,
          perRepMin: [1100, 1100],
          min: 1100,
          median: 1100,
          max: 1100,
          samples: [
            [1100, 1500, 1500],
            [1100, 1500, 1500],
          ],
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
  const wrongGroups = { samples: [[1000, 1000, 1000]] };
  const wrongWidth = {
    samples: [
      [1000, 1000],
      [1000, 1000],
    ],
  };
  // Length REPS, so it reaches the per-group check rather than being caught by
  // the group-COUNT guard first — that is the difference between testing "a flat
  // array is refused" and testing the group count twice.
  const flat = { samples: Array.from({ length: REPS }, () => 1000) };
  // Pinned per case, since a bare /samples/ passes on any of the three messages
  // and so cannot show that each guard is the one that fired.
  for (const [label, bad, pattern] of [
    ["group count", wrongGroups, /must hold 2 per-rep groups/],
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
  // revisions. v1 called `provesPerRep` the configured count and let the
  // artifact supply the statistics.
  assert.throws(
    () => renderComment(results({ top: { schemaVersion: 1 } }), ctx()),
    /schemaVersion 1 came from the bench script on the PR head/
  );
});

test("the schema rejection names both sides of the pipeline, not just the numbers", () => {
  // Whoever reads this is looking at a default-branch workflow log for a PR they
  // did not write. "must be 2, got 3" does not tell them which half to change.
  let message = "";
  try {
    renderComment(results({ top: { schemaVersion: 3 } }), ctx());
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
  // repetitions straddle the base badly — +50%, +50%, −38% — and average to a
  // movement that clears the floor. Calling that a regression asserts something
  // the repetitions do not support.
  const body = renderComment(
    results({
      top: {
        reps: 3,
        provesPerRep: 1,
        repsExecuted: 4,
        provesExecutedPerRep: 2,
      },
      benchmark: {
        base: { samples: [[100], [100], [100]] },
        head: { samples: [[150], [150], [62]] },
      },
    }),
    ctx()
  );
  const heading = body.split("\n")[0];
  assert.match(heading, /Unresolved/);
  assert.doesNotMatch(heading, /slower/);
  assert.match(body, /\*\*1 benchmark unresolved\.\*\*/);
  assert.match(body, /agrees in only\n> 2 of 3 repetitions/);
  assert.match(benchmarkRows(body)[0], /❔/u);
});

test("calls a consistent movement significant", () => {
  // Same aggregate size as the unresolved case above, but every repetition
  // agrees on the direction, so there is a result to report.
  const body = renderComment(
    results({
      top: {
        reps: 3,
        provesPerRep: 1,
        repsExecuted: 4,
        provesExecutedPerRep: 2,
      },
      benchmark: {
        base: { samples: [[100], [100], [100]] },
        head: { samples: [[120], [121], [119]] },
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
  assert.match(beyond, /Moved beyond the noise floor/);
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
  // summing two MAX_VALUEs overflows while recomputing the mean — so the pair no
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
  assert.doesNotMatch(body, /Base and head are built and measured in the same/);
  assert.doesNotMatch(body, /both sides ran interleaved/);

  // ... and still does when there IS a base.
  const compared = renderComment(results(), ctx());
  assert.match(compared, /one prove at a time, alternating/);
  assert.match(compared, /Base and head are built and measured in the same/);
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

  // The final block-dropping cut is not reachable through the artifact: rung 3
  // fits inside the budget for every input tried, up to 4000 benchmarks at 1e300
  // (~48 kB against a 60 kB cap). It stays as a structural guarantee for the
  // assemble() output growing, and is asserted here only to the extent that
  // nothing above it ever needs it.
  assert.ok(dropsTable.length <= MAX_BODY_CHARS);
  assert.doesNotMatch(dropsTable, /Output truncated at the size limit/);
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

  assert.equal(await main([resultsPath, ctxPath]), 1);
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

test("the CLI's exit codes distinguish a refused artifact from a renderer bug", async (t) => {
  // bench-comment.yml branches on these: 0 posts, 1 stays quiet because the
  // fork's payload was refused, 3 turns the reporter red because the fault is
  // first-party. Swapping 1 and 3 either reddens the default branch on every
  // fork PR, or silently blames PR authors for our own breakage — and until this
  // test existed, either inversion kept the suite green.
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

  assert.equal(await main([refusedResults, goodCtx]), 1, "refused artifact");
  assert.equal(
    await main([malformedResults, goodCtx]),
    1,
    "malformed artifact"
  );

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
  const flat = Array.from({ length: 5 }, () => [1000]);
  const body = renderComment(
    results({
      top: {
        reps: 6,
        provesPerRep: 1,
        repsExecuted: 7,
        provesExecutedPerRep: 2,
      },
      benchmark: {
        base: { samples: [...flat, [1000]] },
        head: { samples: [...flat, [400]] },
      },
    }),
    ctx()
  );
  assert.match(body, /❔/, "not reported as unresolved");
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
