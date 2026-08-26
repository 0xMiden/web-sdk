#!/usr/bin/env node
/**
 * render-comment.mjs — renders the WASM proving benchmark report for a PR comment
 * and for the GitHub Actions job summary.
 *
 * TRUST MODEL
 * -----------
 * This module runs in the TRUSTED half of a `workflow_run` pipeline (it has a
 * write token). The benchmark JSON it renders was produced by the UNTRUSTED
 * `pull_request` half, which a fork controls end to end. Therefore:
 *
 *   - every string from the artifact is sanitized before it reaches the body,
 *   - every number from the artifact is validated as finite before it is used
 *     in arithmetic or formatting (a NaN silently renders as "NaN" and a
 *     crafted string renders as whatever the attacker typed),
 *   - malformed input throws instead of producing a plausible-looking comment.
 *     A missing comment is a visible failure; a wrong comment is not.
 *
 * The `ctx` object comes from the GitHub event, not the artifact, so it is
 * trusted — but it is still shape-checked so a typo yields an error rather
 * than a comment full of broken links.
 *
 * No external dependencies. Node 20+, ESM.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

/** Max benchmark rows rendered in a table. Beyond this the comment stops being readable. */
const MAX_ROWS = 50;

/** At or below this many rows the full table renders inline instead of inside <details>. */
const INLINE_TABLE_MAX_ROWS = 5;
/** Max chars of a sanitized benchmark name. */
const MAX_NAME_CHARS = 80;
/** GitHub rejects issue comment bodies over 65536 chars; leave headroom for the sticky header. */
const MAX_BODY_CHARS = 60000;
/** Job summaries allow ~1 MiB, so the summary variant does not need aggressive degradation. */
const MAX_SUMMARY_CHARS = 900000;
/** Repo-local runbook for turning the provisional noise floor into a measured one. */
const CALIBRATION_DOC_PATH = "docs/benchmarks/calibration.md";

const SCHEMA_VERSION = 1;

/**
 * Noise floor, in percent: a movement smaller than this is reported as noise.
 *
 * This lives on the TRUSTED side and is deliberately NOT read from the
 * artifact. It decides the verdict, and the artifact is fork-controlled — a
 * `thresholdPct: 1e9` would silence any regression, and a
 * `thresholdProvisional: false` would make the comment assert that a
 * fork-invented number is this runner's calibrated variance.
 *
 * 5.4% is 3σ of the estimator's measured spread: sd 1.79% over six calibration
 * runs of identical binaries, 3 × 1.79 = 5.37, rounded up. Still PROVISIONAL —
 * that sd was measured on a developer laptop, not on the CI runner. Replacing
 * it is the whole subject of docs/benchmarks/calibration.md.
 */
const THRESHOLD_PCT = 5.4;
const THRESHOLD_PROVISIONAL = true;

/**
 * Every benchmark in this suite is a timing, so lower is always better.
 *
 * Also deliberately not read from the artifact: a `lowerIsBetter: false` turned
 * a 4× regression into "🚀 faster" in a comment posted under this repo's token.
 */
const LOWER_IS_BETTER = true;

const NUM_FMT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Strip the characters that let artifact-controlled text escape its cell.
 *
 * WHY each class:
 *   `  — closes a code span and lets the rest of the name become markup
 *   |  — adds a column to the surrounding table, shifting every later cell
 *   <> — opens raw HTML (GitHub allows a subset, and it would also break the
 *        <details> blocks this comment is built from)
 *   @  — turns "@org/team" in a benchmark name into a real notification ping
 *   \  — a trailing backslash escapes the next delimiter
 *   &  — a numeric character reference re-introduces any glyph stripped above:
 *        GitHub decodes `&#96;` back into a backtick and `&#124;` into a pipe
 *   Cc — the C0 *and* C1 control blocks; a newline ends the table row entirely
 *   Cf — every format character: bidi overrides (U+202E, U+2066–U+2069) reverse
 *        the rest of the line a human reads, and zero-width chars / soft hyphen
 *        / BOM make two different names render identically
 *
 * Whitespace is then collapsed — including the blank-but-not-`\s` glyphs, since
 * without them a name of 80 Hangul fillers renders as an empty cell 160 columns
 * wide — and the result is truncated so one long name cannot dominate.
 *
 * Stripping is only half the job: text that survives this still has to go
 * through `codeSpan` before it reaches the body. See that function.
 */
function sanitizeText(value, maxLen = MAX_NAME_CHARS, fallback = "(unnamed)") {
  let raw;
  if (typeof value === "string") {
    raw = value;
  } else if (value == null) {
    raw = "";
  } else {
    // `String(x)` throws for an object with a non-callable `toString`, which
    // would escape the `fail()` contract with an error naming no field at all.
    try {
      raw = String(value);
    } catch {
      raw = "";
    }
  }
  const cleaned = raw
    .replace(/[`|<>@\\&]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[\u3164\u2800]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return fallback;
  // Count and slice by CODE POINT: `String.prototype.slice` splits surrogate
  // pairs, and an ill-formed string reaches the comment as U+FFFD and a JSON
  // API as a lone `\ud83d` escape.
  const points = [...cleaned];
  if (points.length <= maxLen) return cleaned;
  return `${points.slice(0, maxLen - 1).join("")}…`;
}

/**
 * Wrap artifact-controlled text in a code span.
 *
 * Removing the characters that break OUT of a cell is not sufficient, because
 * GitHub gives plain text a great deal of meaning on its own: it autolinks bare
 * URLs, expands `:shortcode:` emoji, renders `[text](url)` as a live link, and
 * turns `#12` or `org/repo#12` into an issue reference — which also writes a
 * cross-reference event onto the target issue and notifies its subscribers,
 * i.e. arbitrary-issue spam attributed to this repo's bot. Inside a code span
 * none of that happens, and `sanitizeText` has already removed every backtick
 * so the span cannot be closed from within.
 *
 * The one place this is not needed is the fenced samples block, where the fence
 * already suppresses all of it.
 */
function codeSpan(text) {
  return `\`${text}\``;
}

/**
 * Reduce a message to a single log line.
 *
 * Newlines are what make a workflow command load-bearing: `::error::` is only
 * honoured at the start of a line. V8's `JSON.parse` message quotes the
 * offending bytes verbatim, and on the reporting side those bytes came out of a
 * fork-controlled artifact — so every message this module writes to stderr goes
 * through here first, in the job that holds the write token.
 */
function logLine(text) {
  return sanitizeText(text, 200, "(no detail)");
}

/** Units are short tokens; anything else is a sign the artifact is not what we expect. */
function sanitizeUnit(value) {
  const cleaned = sanitizeText(value, 8, "");
  return /^[A-Za-z%/]{1,8}$/.test(cleaned) ? cleaned : "";
}

/** Used only in error messages, which also end up in logs a human reads. */
function describeValue(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return sanitizeText(text ?? String(value), 40, "undefined");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(message) {
  throw new TypeError(`benchmark results: ${message}`);
}

function requireFinite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number, got ${describeValue(value)}`);
  }
  return value;
}

function requireInt(value, path, { min = 0 } = {}) {
  requireFinite(value, path);
  if (!Number.isInteger(value) || value < min) {
    fail(`${path} must be an integer >= ${min}, got ${describeValue(value)}`);
  }
  return value;
}

function requireObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object, got ${describeValue(value)}`);
  }
  return value;
}

/**
 * Samples may arrive flat (`[a, b, c, d, e, f]`) or already grouped per rep
 * (`[[a, b, c], [d, e, f]]`). We normalize to per-rep groups because the raw
 * block reports per-rep spread — that is what tells a reader whether a delta
 * is a real shift or one slow rep dragging the median.
 */
function normalizeSamples(value, path, reps, provesPerRep) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    fail(`${path} must be an array, got ${describeValue(value)}`);

  if (value.length > 0 && Array.isArray(value[0])) {
    return (
      value
        .map((group, i) => {
          if (!Array.isArray(group))
            fail(`${path}[${i}] must be an array of numbers`);
          return group.map((n, j) => requireFinite(n, `${path}[${i}][${j}]`));
        })
        // An empty group would render as a labelled rep line with no values.
        .filter((group) => group.length > 0)
    );
  }

  const flat = value.map((n, i) => requireFinite(n, `${path}[${i}]`));
  if (reps > 0 && provesPerRep > 0 && flat.length === reps * provesPerRep) {
    const grouped = [];
    for (let i = 0; i < reps; i += 1) {
      grouped.push(flat.slice(i * provesPerRep, (i + 1) * provesPerRep));
    }
    return grouped;
  }
  // Shape we cannot attribute to reps: show it as one undifferentiated run
  // rather than inventing a grouping.
  return flat.length > 0 ? [flat] : [];
}

/**
 * Returns `null` for a side that was not measured.
 *
 * `summarize()` in bench-proving.mjs emits `null` for a side with no samples,
 * which is what happens when the base dist fails to build — bench.yml warns and
 * carries on deliberately, reporting head-only. Refusing that shape here would
 * turn the documented fallback into a hard failure.
 */
function normalizeSide(value, path, reps, provesPerRep) {
  if (value === undefined || value === null) return null;
  const side = requireObject(value, path);
  return {
    // `value` is the headline estimator the bench script computed (the mean of
    // each repetition's fastest prove). An artifact from an older bench script
    // has no such field, so fall back to the median — a schema skew should
    // degrade the statistic, not throw the whole comment away.
    value: requireFinite(
      side.value === undefined ? side.median : side.value,
      `${path}.value`
    ),
    median: requireFinite(side.median, `${path}.median`),
    min: requireFinite(side.min, `${path}.min`),
    max: requireFinite(side.max, `${path}.max`),
    samples: normalizeSamples(
      side.samples,
      `${path}.samples`,
      reps,
      provesPerRep
    ),
  };
}

function normalizeResults(input) {
  const results = requireObject(input, "root");

  // An unknown schema means the producer and this renderer disagree about what
  // the fields mean. Guessing would emit confident, wrong numbers.
  if (results.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${SCHEMA_VERSION}, got ${describeValue(results.schemaVersion)}`
    );
  }

  const reps = requireInt(results.reps, "reps", { min: 1 });
  const provesPerRep = requireInt(results.provesPerRep, "provesPerRep", {
    min: 1,
  });
  const threads = requireInt(results.threads, "threads", { min: 1 });

  if (!Array.isArray(results.benchmarks)) {
    fail(
      `benchmarks must be an array, got ${describeValue(results.benchmarks)}`
    );
  }

  // `thresholdPct`, `thresholdProvisional`, `lowerIsBetter` and `calibration`
  // are read from nowhere near here on purpose — see THRESHOLD_PCT above. They
  // are constants on the producing side too, so nothing is lost by pinning
  // them on the trusted side, and a fork loses the ability to author the
  // verdict this bot posts.
  const benchmarks = results.benchmarks.map((entry, i) => {
    const b = requireObject(entry, `benchmarks[${i}]`);
    const head = normalizeSide(
      b.head,
      `benchmarks[${i}].head`,
      reps,
      provesPerRep
    );
    if (head === null) fail(`benchmarks[${i}].head has no measurements`);
    return {
      name: sanitizeText(b.name, MAX_NAME_CHARS, `benchmark #${i + 1}`),
      unit: sanitizeUnit(b.unit),
      base: normalizeSide(b.base, `benchmarks[${i}].base`, reps, provesPerRep),
      head,
    };
  });

  return {
    runner: sanitizeText(results.runner, 60, "unknown runner"),
    profile: sanitizeText(results.profile, 24, "unknown"),
    variant: sanitizeText(results.variant, 24, "unknown"),
    threads,
    reps,
    provesPerRep,
    benchmarks,
  };
}

// Lowercase-only, matching what both `git rev-parse` and the GitHub API return,
// and matching the shell-side check in bench-comment.yml. An uppercase sha
// would render a link nobody can match against a `git log`.
const SHA_RE = /^[0-9a-f]{7,40}$/;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
// The exact shape both workflows build, rather than a loose path match: the
// looser form accepted `..`, which GitHub normalizes into a link to whatever
// repo the traversal lands on.
const RUN_URL_RE =
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;

function normalizeContext(input) {
  const ctx = requireObject(input, "ctx");
  const owner = String(ctx.owner ?? "");
  const repo = String(ctx.repo ?? "");
  if (!SLUG_RE.test(owner))
    fail(`ctx.owner is not a valid repo owner: ${describeValue(ctx.owner)}`);
  if (!SLUG_RE.test(repo))
    fail(`ctx.repo is not a valid repo name: ${describeValue(ctx.repo)}`);

  const headSha = String(ctx.headSha ?? "");
  const baseSha = String(ctx.baseSha ?? "");
  if (!SHA_RE.test(headSha))
    fail(`ctx.headSha is not a commit sha: ${describeValue(ctx.headSha)}`);
  if (!SHA_RE.test(baseSha))
    fail(`ctx.baseSha is not a commit sha: ${describeValue(ctx.baseSha)}`);

  const runUrl = String(ctx.runUrl ?? "");
  return {
    owner,
    repo,
    headSha,
    baseSha,
    baseRef: sanitizeText(ctx.baseRef, 60, "base"),
    runId: sanitizeText(ctx.runId, 24, "unknown"),
    // Whether this was a calibration run is knowable only from the triggering
    // event, so it comes from the caller's context and never from the artifact:
    // `calibration: true` on a real regression bolts a "this is all measurement
    // noise" banner onto it.
    calibration: ctx.calibration === true,
    // Only render a link for a URL we recognize; otherwise degrade to text.
    runUrl: RUN_URL_RE.test(runUrl) ? runUrl : "",
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatValue(value) {
  return NUM_FMT.format(value);
}

function formatSignedValue(value) {
  const rounded = Number(value.toFixed(1));
  if (rounded === 0) return `±${NUM_FMT.format(0)}`;
  return `${rounded > 0 ? "+" : "-"}${NUM_FMT.format(Math.abs(value))}`;
}

function formatSignedPct(pct) {
  if (pct === null) return "n/a";
  const rounded = Number(pct.toFixed(2));
  if (rounded === 0) return "±0.00%";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(pct).toFixed(2)}%`;
}

function formatPct(pct) {
  return `${Math.abs(pct).toFixed(2)}%`;
}

function shortSha(sha) {
  return sha.slice(0, 7);
}

function commitLink(ctx, sha) {
  return `[\`${shortSha(sha)}\`](https://github.com/${ctx.owner}/${ctx.repo}/commit/${sha})`;
}

function calibrationLink(ctx) {
  return `https://github.com/${ctx.owner}/${ctx.repo}/blob/HEAD/${CALIBRATION_DOC_PATH}`;
}

function plural(n, singular, pluralForm = `${singular}s`) {
  return n === 1 ? singular : pluralForm;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const EMOJI_WORSE = "🔺";
const EMOJI_BETTER = "🔻";
const EMOJI_NOISE = "➖";

function computeRows(results) {
  const rows = results.benchmarks.map((b) => {
    // `value` is the mean of per-rep minima — see the estimator comment in
    // bench-proving.mjs. Measured over six calibration runs of identical
    // binaries it holds sd 1.79% where a plain median holds 5.39%.
    //
    // `base` is null on a head-only run, which leaves nothing to compare.
    const deltaValue = b.base === null ? null : b.head.value - b.base.value;
    // A zero baseline makes a percentage meaningless; report it as n/a rather
    // than emitting Infinity.
    const deltaPct =
      deltaValue === null || b.base.value === 0
        ? null
        : (deltaValue / b.base.value) * 100;
    // Two finite doubles still subtract and divide into a non-finite one
    // (5e-324 against 1e300), so the derived values get the same check the
    // inputs got. This module promises no "Infinity" ever reaches a comment.
    if (deltaValue !== null && !Number.isFinite(deltaValue))
      fail(`${b.name}: head - base is not finite`);
    if (deltaPct !== null && !Number.isFinite(deltaPct))
      fail(`${b.name}: delta percentage is not finite`);
    const magnitude = deltaPct === null ? 0 : Math.abs(deltaPct);
    // `magnitude > 0` so a threshold of zero does not classify an exactly
    // unchanged benchmark as a movement — and then as an improvement.
    const beyond = magnitude > 0 && magnitude >= THRESHOLD_PCT;
    const isWorse = LOWER_IS_BETTER ? deltaValue > 0 : deltaValue < 0;
    return {
      ...b,
      deltaValue,
      deltaPct,
      magnitude,
      beyond,
      isWorse,
      emoji: beyond ? (isWorse ? EMOJI_WORSE : EMOJI_BETTER) : EMOJI_NOISE,
    };
  });

  // Sort by magnitude so the capped table keeps the rows that matter and the
  // reader's eye lands on the biggest movement first.
  rows.sort(
    (a, b) =>
      b.magnitude - a.magnitude ||
      Math.abs(b.deltaValue) - Math.abs(a.deltaValue) ||
      a.name.localeCompare(b.name)
  );
  return rows;
}

/** Non-empty only when every benchmark shares a unit; drives the column headers. */
function uniformUnit(rows) {
  if (rows.length === 0) return "";
  const first = rows[0].unit;
  return rows.every((r) => r.unit === first) ? first : "";
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildVerdict(rows) {
  if (rows.length === 0) {
    return "### ❔ No benchmarks reported — the bench job produced an empty result set";
  }

  const comparable = rows.filter((r) => r.deltaPct !== null);
  if (comparable.length === 0) {
    return "### ❔ Head-only run — no base measurements to compare against";
  }

  const thresholdText = `${THRESHOLD_PROVISIONAL ? "provisional " : ""}±${formatPct(THRESHOLD_PCT)}`;
  const moved = rows.filter((r) => r.beyond);
  const worst = comparable[0];

  if (moved.length === 0) {
    // The heading has to be readable at a glance in a notification list, so it
    // carries the verdict and one number; the threshold lives in the table.
    return `### ➖ No significant change (largest ${codeSpan(worst.name)} ${formatSignedPct(worst.deltaPct)}, floor ${thresholdText})`;
  }

  // Headline the worst REGRESSION whenever there is one. `moved` is sorted by
  // magnitude, so taking moved[0] lets a large improvement own the heading
  // while a smaller regression hides behind "(+N more)" — and this heading is
  // the only part of the comment most readers ever see.
  const regressions = moved.filter((r) => r.isWorse);
  const leader = regressions[0] ?? moved[0];
  const direction = leader.isWorse ? "slower" : "faster";
  const emoji = regressions.length > 0 ? "⚠️" : "🚀";
  const rest = moved.length > 1 ? ` (+${moved.length - 1} more)` : "";
  return `### ${emoji} ${formatSignedPct(leader.deltaPct)} ${direction}: ${codeSpan(leader.name)}${rest}`;
}

/**
 * bench.yml warns and carries on when the base dist fails to build, so an
 * artifact can legitimately carry head measurements and no base. Saying that
 * out loud beats a table of "n/a" the reader has to interpret.
 */
function buildHeadOnlyNote() {
  return [
    "> **No base measurements.** The base build did not produce a dist, so this run reports head",
    "> timings only and there is nothing to compare them against. See the run log for why.",
  ].join("\n");
}

/**
 * A calibration run benches one build against a copy of itself. Its true delta
 * is zero by construction, so whatever it reports is the measurement noise —
 * and without this banner that number reads as a regression.
 */
function buildCalibrationNote(ctx) {
  return [
    "> **Calibration run.** Base and head are the same build, so the true difference is zero.",
    "> Every number below is measurement noise, not a code change.",
    `> [How the noise floor is derived](${calibrationLink(ctx)})`,
  ].join("\n");
}

function buildProvisionalNote(results, ctx) {
  return [
    `> **The noise floor is provisional.** ±${formatPct(THRESHOLD_PCT)} is 3σ of this estimator measured on a`,
    `> developer laptop, not on \`${results.runner}\` — no calibration run has been recorded on this runner yet,`,
    `> and it is quieter, so the real floor is likely tighter. Treat movements near the threshold as unresolved.`,
    `> [How to calibrate the noise floor](${calibrationLink(ctx)})`,
  ].join("\n");
}

function buildContextTable(results, ctx, rows) {
  const unit = uniformUnit(rows);
  const workloadNames = rows.slice(0, 3).map((r) => codeSpan(r.name));
  const workloadTail =
    rows.length > workloadNames.length
      ? `, +${rows.length - workloadNames.length} more`
      : "";
  const workload =
    rows.length === 0
      ? "none"
      : `${rows.length} ${plural(rows.length, "benchmark")}${unit ? ` (${unit})` : ""} — ${workloadNames.join(", ")}${workloadTail}`;

  // `reps`/`provesPerRep` are the RETAINED counts, not the configured ones —
  // bench-proving.mjs discards a whole warm-up rep and the first prove of every
  // page, and reporting the configured numbers here overstated the sample size.
  const method =
    `mean of per-rep fastest, ${results.reps} ${plural(results.reps, "rep")} × ${results.provesPerRep} warm ${plural(results.provesPerRep, "prove")}, ` +
    `\`${results.profile}\` / \`${results.variant}\`, ${results.threads} ${plural(results.threads, "thread")} on \`${results.runner}\` — ` +
    `**lower is better**`;

  return [
    "| | |",
    "| :-- | :-- |",
    `| **Head** | ${commitLink(ctx, ctx.headSha)} |`,
    `| **Base** | ${commitLink(ctx, ctx.baseSha)} (\`${ctx.baseRef}\`) |`,
    `| **Method** | ${method} |`,
    `| **Workload** | ${workload} |`,
  ].join("\n");
}

function buildTable(rows, unit) {
  const valueHeader = (label) => (unit ? `${label} (${unit})` : label);
  const cell = (value, rowUnit) =>
    unit ? formatValue(value) : `${formatValue(value)} ${rowUnit || ""}`.trim();
  const deltaCell = (value, rowUnit) =>
    unit
      ? formatSignedValue(value)
      : `${formatSignedValue(value)} ${rowUnit || ""}`.trim();

  const lines = [
    `| | Benchmark | ${valueHeader("Base")} | ${valueHeader("Head")} | Δ | Δ % |`,
    // Right-align every numeric column so digits line up and a 4-digit value
    // reads as bigger than a 3-digit one at a glance.
    "| :-: | :-- | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    const baseCell = row.base === null ? "—" : cell(row.base.value, row.unit);
    const delta =
      row.deltaValue === null ? "n/a" : deltaCell(row.deltaValue, row.unit);
    lines.push(
      `| ${row.emoji} | ${codeSpan(row.name)} | ${baseCell} | ${cell(row.head.value, row.unit)} | ` +
        `${delta} | ${formatSignedPct(row.deltaPct)} |`
    );
  }
  return lines.join("\n");
}

function buildMovedSection(rows, unit) {
  const moved = rows.filter((r) => r.beyond);
  if (moved.length === 0) return "";

  const shown = moved.slice(0, MAX_ROWS);
  const parts = [
    "#### Moved beyond the noise floor",
    "",
    buildTable(shown, unit),
  ];
  if (shown.length < moved.length) {
    // Not "in the full table below": that table is capped by the same MAX_ROWS
    // over the same magnitude-sorted array, so it holds no extra rows.
    parts.push(
      "",
      `_Showing the ${shown.length} largest of ${moved.length} movements (row cap ${MAX_ROWS}); the remaining ${moved.length - shown.length} are in the \`results.json\` artifact on the run._`
    );
  }
  return parts.join("\n");
}

function buildAllBenchmarksSection(rows, unit) {
  const shown = rows.slice(0, MAX_ROWS);
  // Collapsing a short table leaves nothing above the fold to read — the whole
  // comment becomes a summary line and a disclosure triangle. Only fold it away
  // once the table is long enough to be in the way.
  if (rows.length > 0 && rows.length <= INLINE_TABLE_MAX_ROWS) {
    return buildTable(shown, unit);
  }
  const parts = [
    "<details>",
    `<summary><b>All ${rows.length} ${plural(rows.length, "benchmark")}</b> (sorted by |Δ %|)</summary>`,
    // GitHub's markdown renderer only re-enters markdown mode after a BLANK
    // LINE following </summary>. Without it the table below renders as one
    // literal line of pipes. This blank line is load-bearing — do not "tidy" it.
    "",
    shown.length > 0
      ? buildTable(shown, unit)
      : "_No benchmarks were reported._",
  ];
  if (shown.length < rows.length) {
    parts.push(
      "",
      `> ✂️ Row cap reached: showing the ${shown.length} largest movements of ${rows.length} benchmarks.`,
      `> The remaining ${rows.length - shown.length} are in the \`results.json\` artifact on the run.`
    );
  }
  parts.push("", "</details>");
  return parts.join("\n");
}

function buildSamplesBlock(rows, unit) {
  const lines = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
    const rowUnit = unit || row.unit;
    lines.push(row.name);
    for (const side of ["base", "head"]) {
      const data = row[side];
      const label = side.padEnd(4);
      if (data === null) {
        lines.push(`  ${label} (not measured)`);
        continue;
      }
      if (data.samples.length === 0) {
        lines.push(`  ${label} (no samples reported)`);
      }
      data.samples.forEach((group, i) => {
        const values = group.map((v) => formatValue(v)).join(", ");
        lines.push(`  ${label} rep ${String(i + 1).padStart(2)}: ${values}`);
      });
      lines.push(
        `  ${label} median ${formatValue(data.median)}${rowUnit ? ` ${rowUnit}` : ""}` +
          `  min ${formatValue(data.min)}  max ${formatValue(data.max)}`
      );
    }
    lines.push("");
  }
  // Safe to fence: every line here is either a validated finite number or an
  // already-sanitized name (backticks are stripped, so no fence can be closed).
  return ["```text", ...lines, "```"].join("\n");
}

function buildMethodologySection(results, ctx, rows, unit, includeSamples) {
  const parts = [
    "<details>",
    "<summary><b>Methodology and raw samples</b></summary>",
    // Same blank-line trap as above.
    "",
    `- Each benchmark keeps **${results.reps} ${plural(results.reps, "rep")} × ${results.provesPerRep} warm ${plural(results.provesPerRep, "prove")}** on \`${results.runner}\` (${results.threads} ${plural(results.threads, "thread")}, \`${results.profile}\` / \`${results.variant}\`). One extra repetition and the first prove of every page run first and are discarded.`,
    `- The reported figure is the **mean of each repetition's fastest prove**. Within one repetition every prove is bit-identical work, so interference — which only ever adds time — is all that varies, and the repetition's fastest prove is its clean compute cost. Across repetitions the faucet differs, which shifts the proof-of-work grind, so averaging the per-repetition minima cancels that lottery.`,
    `- Measured over six calibration runs of identical binaries, this estimator holds a standard deviation of 1.79%, against 2.96% for a global minimum and 5.39% for a plain median.`,
    `- Base and head are driven **one prove at a time, alternating**, with the order flipped every prove. Running each side's batch back to back let the second side pay a consistent penalty — measured at +1.19% before this was fixed, which is a bias no number of repetitions removes.`,
    `- A wide gap between the reported figure and the max means the runner was busy. It does not invalidate the comparison (both sides ran interleaved on the same machine) but it is worth a second look.`,
    `- Base and head are built and measured in the same job on the same runner, so runner-to-runner drift cancels out.`,
    `- Δ % = (head − base) / base on that figure. Lower is better for every benchmark in this suite.`,
    THRESHOLD_PROVISIONAL
      ? `- The ±${formatPct(THRESHOLD_PCT)} threshold is **provisional** — a placeholder, not a measured variance for this runner. [How to calibrate](${calibrationLink(ctx)}).`
      : `- The ±${formatPct(THRESHOLD_PCT)} threshold is the calibrated run-to-run variance for this runner.`,
    `- Full machine-readable results are attached to ${ctx.runUrl ? `[the run](${ctx.runUrl})` : "the workflow run"} as \`results.json\`.`,
  ];

  if (includeSamples && rows.length > 0) {
    parts.push("", "**Per-rep samples**", "", buildSamplesBlock(rows, unit));
  } else if (rows.length > 0) {
    parts.push(
      "",
      "_Per-rep samples omitted to fit the comment size limit — see `results.json` on the run._"
    );
  }

  parts.push("", "</details>");
  return parts.join("\n");
}

function buildLegend() {
  return `<sub>${EMOJI_WORSE} slower beyond the noise floor · ${EMOJI_BETTER} faster beyond the noise floor · ${EMOJI_NOISE} within the noise floor</sub>`;
}

function buildFooter(ctx) {
  const runLink = ctx.runUrl
    ? `[bench run ${ctx.runId}](${ctx.runUrl})`
    : `bench run ${ctx.runId}`;
  return [
    "---",
    `<sub>Generated by ${runLink} for \`${shortSha(ctx.headSha)}\`. ` +
      `This comment is informational only and never blocks merge.</sub>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Returns the body as an array of blocks so truncation can drop whole blocks. */
function assemble(
  results,
  ctx,
  rows,
  unit,
  { includeSamples, includeAllTable, notices }
) {
  const blocks = [];
  blocks.push(buildVerdict(rows));
  if (ctx.calibration) blocks.push(buildCalibrationNote(ctx));
  if (rows.length > 0 && rows.every((r) => r.base === null))
    blocks.push(buildHeadOnlyNote());
  if (THRESHOLD_PROVISIONAL) blocks.push(buildProvisionalNote(results, ctx));
  for (const notice of notices) blocks.push(notice);
  blocks.push(buildContextTable(results, ctx, rows));

  const moved = buildMovedSection(rows, unit);
  if (moved) blocks.push(moved);

  // When the table is short enough to render inline AND every row already
  // appears in the moved section, the "all benchmarks" table would be a
  // verbatim duplicate of the one directly above it.
  const movedCount = rows.filter((r) => r.beyond).length;
  const allTableWouldDuplicate =
    moved !== "" &&
    moved !== null &&
    moved !== undefined &&
    rows.length <= INLINE_TABLE_MAX_ROWS &&
    movedCount === rows.length;

  if (includeAllTable && !allTableWouldDuplicate) {
    blocks.push(buildAllBenchmarksSection(rows, unit));
  } else if (!includeAllTable) {
    blocks.push(
      `> ✂️ The full benchmark table was dropped to fit the comment size limit. ` +
        `No rows were discarded from the data — all ${rows.length} are in \`results.json\` on the run.`
    );
  }

  blocks.push(
    buildMethodologySection(results, ctx, rows, unit, includeSamples)
  );
  blocks.push(buildLegend());
  blocks.push(buildFooter(ctx));

  return blocks.filter(Boolean);
}

const BLOCK_SEP = "\n\n";

const TRUNCATION_NOTICES = {
  samples:
    "> ✂️ Per-rep raw samples were dropped to fit GitHub's comment size limit. They are in `results.json` on the run.",
  table:
    "> ✂️ Per-rep samples **and** the full benchmark table were dropped to fit GitHub's comment size limit. " +
    "Nothing was dropped from the data itself — the complete set is in `results.json` on the run.",
};

/**
 * Degrade in a fixed order — raw samples first, then the full table — so the
 * verdict, the context, and the rows that actually moved always survive.
 * Every step announces itself; rows are never dropped silently.
 */
function render(input, context, maxChars) {
  const results = normalizeResults(input);
  const ctx = normalizeContext(context);
  const rows = computeRows(results);
  const unit = uniformUnit(rows);

  const attempts = [
    { includeSamples: true, includeAllTable: true, notices: [] },
    {
      includeSamples: false,
      includeAllTable: true,
      notices: [TRUNCATION_NOTICES.samples],
    },
    {
      includeSamples: false,
      includeAllTable: false,
      notices: [TRUNCATION_NOTICES.table],
    },
  ];

  let blocks = [];
  for (const attempt of attempts) {
    blocks = assemble(results, ctx, rows, unit, attempt);
    const body = blocks.join(BLOCK_SEP);
    if (body.length <= maxChars) return body;
  }

  // Last resort: drop whole blocks off the END rather than slicing the joined
  // string. A mid-string cut lands inside a table row, inside a surrogate pair,
  // or — worst — inside the methodology `<details>`, and an unclosed `<details>`
  // collapses the entire remainder of the comment on GitHub. Reaching here means
  // the moved-rows table alone is enormous, which is itself worth surfacing.
  const marker =
    "> ✂️ Output truncated at the size limit — see `results.json` on the run for the complete data.";
  // The footer carries the "never blocks merge" disclaimer, so it survives the
  // cut even though it is the last block.
  const tail = [marker, buildFooter(ctx)];
  const budget = maxChars - tail.join(BLOCK_SEP).length - BLOCK_SEP.length;

  const kept = [];
  let used = 0;
  for (const block of blocks) {
    const cost =
      kept.length === 0 ? block.length : block.length + BLOCK_SEP.length;
    if (used + cost > budget) break;
    kept.push(block);
    used += cost;
  }
  return [...kept, ...tail].join(BLOCK_SEP);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the PR comment body.
 *
 * No hidden sticky marker is emitted: marocchino/sticky-pull-request-comment
 * owns comment identity via its `header:` input, and a second marker here
 * would just be dead weight in every comment.
 *
 * @param {unknown} results Parsed contents of the untrusted results artifact.
 * @param {unknown} ctx Trusted GitHub context: { owner, repo, headSha, baseSha, baseRef, runId, runUrl, calibration }.
 * @returns {string} Markdown body, at most 60000 chars.
 * @throws {TypeError} If the results or context are malformed.
 */
export function renderComment(results, ctx) {
  return render(results, ctx, MAX_BODY_CHARS);
}

/**
 * Render the job summary. Same content as the comment — the summary is the
 * fallback view when comment posting is unavailable (forks, permissions), so
 * divergence between the two would mean two different stories about one run.
 * Only the size budget differs.
 */
export function renderSummary(results, ctx) {
  return render(results, ctx, MAX_SUMMARY_CHARS);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "usage: node render-bench-comment.mjs [--summary] <results.json> <ctx.json>\n";

/** Usage: node render-bench-comment.mjs [--summary] <results.json> <ctx.json> */
export async function main(argv = process.argv.slice(2)) {
  // `--summary` selects the job-summary budget (~1 MiB) over the comment budget
  // (60 kB). Without it the step summary — the fallback surface on forks — was
  // degraded to the comment's limit for no reason.
  const summaryMode = argv.includes("--summary");
  const [resultsPath, ctxPath, ...extra] = argv.filter(
    (arg) => arg !== "--summary"
  );
  if (!resultsPath || !ctxPath || extra.length > 0) {
    process.stderr.write(USAGE);
    return 2;
  }

  let results;
  let ctx;
  try {
    results = JSON.parse(await readFile(resultsPath, "utf8"));
    ctx = JSON.parse(await readFile(ctxPath, "utf8"));
  } catch (error) {
    // `logLine`, not the raw message: V8's parse error quotes the offending
    // bytes verbatim, and those bytes are fork-controlled. Unsanitized, a
    // crafted results.json starts a log line in this write-token job with a
    // real `::error::` / `::add-mask::` workflow command.
    process.stderr.write(`failed to read inputs: ${logLine(error.message)}\n`);
    return 1;
  }

  try {
    const body = summaryMode
      ? renderSummary(results, ctx)
      : renderComment(results, ctx);
    process.stdout.write(`${body}\n`);
  } catch (error) {
    // Refusing loudly is the point: a wrong comment is worse than none.
    process.stderr.write(`refusing to render: ${logLine(error.message)}\n`);
    return 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
