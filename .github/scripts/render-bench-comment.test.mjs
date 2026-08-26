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
  runner: "warp-ubuntu-latest-x64-8x",
  variant: "mt",
  profile: "release",
  threads: 8,
  reps: 6,
  provesPerRep: 3,
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
    value,
    min: value,
    median: value,
    max: value,
    samples: Array.from({ length: 40 }, () => [value, value, value, value]),
  });
  const input = results({
    top: {
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
