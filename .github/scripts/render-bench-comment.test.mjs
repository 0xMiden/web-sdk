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
  return {
    samples: [
      [value, slower(0.4), slower(0.2)],
      [slower(0.3), value, slower(0.5)],
    ],
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
  const flat = { samples: [1000, 1000, 1000, 1000, 1000, 1000] };
  for (const [label, bad] of [
    ["group count", wrongGroups],
    ["group width", wrongWidth],
    ["flat array", flat],
  ]) {
    assert.throws(
      () =>
        renderComment(
          results({ benchmark: { base: bad, head: side(1000) } }),
          ctx()
        ),
      /samples/,
      `${label} was accepted`
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
            benchmarks: [
              { name: "wide", unit: "ms", base: wide(), head: wide() },
            ],
          },
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
    /schemaVersion must be 2/
  );
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
  assert.throws(
    () =>
      renderComment(
        results({
          benchmark: {
            base: side(-Number.MAX_VALUE),
            head: side(Number.MAX_VALUE),
          },
        }),
        ctx()
      ),
    /not finite/
  );
});

test("refuses a name whose coercion throws", () => {
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
    assert.doesNotMatch(body, /\]\(the workflow run\)/, "malformed link");
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
    for (const scale of [1, 1e12, 1e100]) {
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
    }
  }
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
