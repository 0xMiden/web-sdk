// Tests for the benchmark comment renderer.
//
// Run with `node --test .github/scripts/` or `make test-bench-scripts`.
//
// The renderer runs in the TRUSTED half of the workflow_run pipeline, holding a
// write token, over JSON that a fork controls end to end. Most of what is
// asserted here is that property: names get sanitized, malformed numbers are
// refused rather than rendered, and the statistic reported is the one the
// methodology claims.

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderComment } from "./render-bench-comment.mjs";

const ctx = () => ({
  owner: "0xMiden",
  repo: "web-sdk",
  prNumber: 321,
  headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  baseSha: "89690ae2000000000000000000000000000000ab",
  baseRef: "next",
  runId: "32568739941",
  runUrl: "https://github.com/0xMiden/web-sdk/actions/runs/32568739941",
});

const side = (value, median = value, max = value) => ({
  statistic: "mean-of-per-rep-minima",
  value,
  perRepMin: [value],
  min: value,
  median,
  max,
  samples: [[value, median, max]],
});

const results = (overrides = {}) => ({
  schemaVersion: 1,
  status: "ok",
  calibration: false,
  runner: "warp-ubuntu-latest-x64-8x",
  variant: "mt",
  profile: "release",
  threads: 8,
  reps: 5,
  provesPerRep: 4,
  thresholdPct: 10,
  thresholdProvisional: true,
  benchmarks: [
    {
      name: "prove / consume / ecdsa-k256-keccak",
      unit: "ms",
      lowerIsBetter: true,
      base: side(1000),
      head: side(1010),
      ...overrides.benchmark,
    },
  ],
  ...overrides.top,
});

test("reports `value`, not the median or the raw minimum", () => {
  // The methodology paragraph claims the mean of per-rep minima. If the
  // renderer quietly used median (-20%) or min (-50%) instead, that paragraph
  // would become a lie while the comment still looked plausible.
  const body = renderComment(
    results({
      benchmark: {
        base: {
          value: 1000,
          min: 900,
          median: 2000,
          max: 3000,
          samples: [[900, 2000]],
        },
        head: {
          value: 1010,
          min: 450,
          median: 1600,
          max: 3000,
          samples: [[450, 1600]],
        },
      },
    }),
    ctx()
  );
  assert.match(body, /\+1\.00%/);
  assert.doesNotMatch(body, /-20\.00%/, "fell back to the median");
  assert.doesNotMatch(body, /-50\.00%/, "fell back to the raw minimum");
});

test("falls back to the median when `value` is absent", () => {
  // Schema skew (an old artifact, a rolled-back bench script) should degrade
  // to a slightly worse statistic, not throw away the whole comment.
  const body = renderComment(
    results({
      benchmark: {
        base: { min: 900, median: 1000, max: 1100, samples: [[900, 1100]] },
        head: { min: 900, median: 1100, max: 1300, samples: [[900, 1300]] },
      },
    }),
    ctx()
  );
  assert.match(body, /\+10\.00%/);
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
  const body = renderComment(results({ top: { calibration: true } }), ctx());
  assert.match(body, /Calibration run/);
  assert.match(body, /true difference is zero/);
});

test("never blocks merge, and says so", () => {
  const body = renderComment(results(), ctx());
  assert.match(body, /informational only and never blocks merge/);
});

// --- Untrusted input -------------------------------------------------------

/** Benchmark result rows, as opposed to the context table's label/value rows. */
const benchmarkRows = (body) =>
  body.split("\n").filter((line) => /^\| (?:🔺|🔻|➖) \|/u.test(line));

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
  assert.doesNotMatch(rows[0], /\n/, "newline survived into a table row");
});

test("refuses to render non-finite measurements rather than printing NaN", () => {
  for (const bad of [Number.NaN, Infinity, "1000", null, undefined]) {
    assert.throws(
      () =>
        renderComment(
          results({
            benchmark: {
              base: { min: bad, median: bad, max: bad, samples: [[1]] },
              head: side(1000),
            },
          }),
          ctx()
        ),
      `expected a throw for ${String(bad)}`
    );
  }
});

test("refuses a context whose shas or slugs are not well formed", () => {
  assert.throws(() =>
    renderComment(results(), { ...ctx(), headSha: "not-a-sha" })
  );
  assert.throws(() =>
    renderComment(results(), { ...ctx(), owner: "bad owner/../.." })
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

test("stays within GitHub's comment size limit", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    name: `bench-${i}`,
    unit: "ms",
    lowerIsBetter: true,
    base: side(1000 + i),
    head: side(1200 + i),
  }));
  const body = renderComment(results({ top: { benchmarks: many } }), ctx());
  assert.ok(body.length <= 65536, `body was ${body.length} chars`);
  // Rows may be capped, but never silently.
  assert.match(body, /✂️|Row cap/);
});
