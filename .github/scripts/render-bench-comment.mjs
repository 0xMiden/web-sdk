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
 *   control chars / newlines — a newline ends the table row entirely
 *
 * Whitespace is then collapsed so a name padded with tabs cannot stretch a
 * column, and the result is truncated so one long name cannot dominate.
 */
function sanitizeText(value, maxLen = MAX_NAME_CHARS, fallback = "(unnamed)") {
  const raw =
    typeof value === "string" ? value : value == null ? "" : String(value);
  const cleaned = raw
    .replace(/[`|<>@\\]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return fallback;
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
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
    return value.map((group, i) => {
      if (!Array.isArray(group))
        fail(`${path}[${i}] must be an array of numbers`);
      return group.map((n, j) => requireFinite(n, `${path}[${i}][${j}]`));
    });
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

function normalizeSide(value, path, reps, provesPerRep) {
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
  const thresholdPct = requireFinite(results.thresholdPct, "thresholdPct");
  if (thresholdPct < 0)
    fail(
      `thresholdPct must be >= 0, got ${describeValue(results.thresholdPct)}`
    );

  if (!Array.isArray(results.benchmarks)) {
    fail(
      `benchmarks must be an array, got ${describeValue(results.benchmarks)}`
    );
  }

  const benchmarks = results.benchmarks.map((entry, i) => {
    const b = requireObject(entry, `benchmarks[${i}]`);
    return {
      name: sanitizeText(b.name, MAX_NAME_CHARS, `benchmark #${i + 1}`),
      unit: sanitizeUnit(b.unit),
      // Default to "lower is better": every timing benchmark in this suite is,
      // and a missing flag should not silently invert a regression verdict.
      lowerIsBetter: b.lowerIsBetter !== false,
      base: normalizeSide(b.base, `benchmarks[${i}].base`, reps, provesPerRep),
      head: normalizeSide(b.head, `benchmarks[${i}].head`, reps, provesPerRep),
    };
  });

  return {
    runner: sanitizeText(results.runner, 60, "unknown runner"),
    profile: sanitizeText(results.profile, 24, "unknown"),
    variant: sanitizeText(results.variant, 24, "unknown"),
    threads,
    reps,
    provesPerRep,
    thresholdPct,
    thresholdProvisional: results.thresholdProvisional === true,
    calibration: results.calibration === true,
    benchmarks,
  };
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

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
    prNumber:
      ctx.prNumber === undefined
        ? null
        : requireInt(ctx.prNumber, "ctx.prNumber", { min: 1 }),
    headSha,
    baseSha,
    baseRef: sanitizeText(ctx.baseRef, 60, "base"),
    runId: sanitizeText(ctx.runId, 24, "unknown"),
    // Only render a link for a URL we recognize; otherwise degrade to text.
    runUrl: /^https:\/\/github\.com\/[\w./-]+$/.test(runUrl) ? runUrl : "",
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
    const deltaValue = b.head.value - b.base.value;
    // A zero baseline makes a percentage meaningless; report it as n/a rather
    // than emitting Infinity.
    const deltaPct =
      b.base.value === 0 ? null : (deltaValue / b.base.value) * 100;
    const magnitude = deltaPct === null ? 0 : Math.abs(deltaPct);
    const beyond = deltaPct !== null && magnitude >= results.thresholdPct;
    const isWorse = b.lowerIsBetter ? deltaValue > 0 : deltaValue < 0;
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

function buildVerdict(results, rows) {
  if (rows.length === 0) {
    return "### ❔ No benchmarks reported — the bench job produced an empty result set";
  }

  const thresholdText = `${results.thresholdProvisional ? "provisional " : ""}±${formatPct(results.thresholdPct)}`;
  const moved = rows.filter((r) => r.beyond);
  const worst = rows[0];
  const worstText = `${worst.name} ${formatSignedPct(worst.deltaPct)}`;

  if (moved.length === 0) {
    // The heading has to be readable at a glance in a notification list, so it
    // carries the verdict and one number; the threshold lives in the table.
    return `### ➖ No significant change (largest ${formatSignedPct(worst.deltaPct)}, floor ${thresholdText})`;
  }

  const leader = moved[0];
  const direction = leader.isWorse ? "slower" : "faster";
  const emoji = moved.some((r) => r.isWorse) ? "⚠️" : "🚀";
  const rest = moved.length > 1 ? ` (+${moved.length - 1} more)` : "";
  return `### ${emoji} ${formatSignedPct(leader.deltaPct)} ${direction}: ${leader.name}${rest}`;
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
    `> **The noise floor is provisional.** ±${formatPct(results.thresholdPct)} is 3σ of this estimator measured on a`,
    `> developer laptop, not on \`${results.runner}\` — no calibration run has been recorded on this runner yet,`,
    `> and it is quieter, so the real floor is likely tighter. Treat movements near the threshold as unresolved.`,
    `> [How to calibrate the noise floor](${calibrationLink(ctx)})`,
  ].join("\n");
}

function buildContextTable(results, ctx, rows) {
  const unit = uniformUnit(rows);
  const workloadNames = rows.slice(0, 3).map((r) => r.name);
  const workloadTail =
    rows.length > workloadNames.length
      ? `, +${rows.length - workloadNames.length} more`
      : "";
  const workload =
    rows.length === 0
      ? "none"
      : `${rows.length} ${plural(rows.length, "benchmark")}${unit ? ` (${unit})` : ""} — ${workloadNames.join(", ")}${workloadTail}`;

  const method =
    `mean of per-rep fastest, ${results.reps} ${plural(results.reps, "rep")} × ${results.provesPerRep} ${plural(results.provesPerRep, "prove")}, ` +
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
    lines.push(
      `| ${row.emoji} | ${row.name} | ${cell(row.base.value, row.unit)} | ${cell(row.head.value, row.unit)} | ` +
        `${deltaCell(row.deltaValue, row.unit)} | ${formatSignedPct(row.deltaPct)} |`
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
    parts.push(
      "",
      `_Showing the ${shown.length} largest of ${moved.length} movements (row cap ${MAX_ROWS}); the rest are in the full table below._`
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
    `- Each benchmark runs **${results.reps} ${plural(results.reps, "rep")} × ${results.provesPerRep} ${plural(results.provesPerRep, "prove")}** on \`${results.runner}\` (${results.threads} ${plural(results.threads, "thread")}, \`${results.profile}\` / \`${results.variant}\`).`,
    `- The reported figure is the **mean of each repetition's fastest prove**. Within one repetition every prove is bit-identical work, so interference — which only ever adds time — is all that varies, and the repetition's fastest prove is its clean compute cost. Across repetitions the faucet differs, which shifts the proof-of-work grind, so averaging the per-repetition minima cancels that lottery.`,
    `- Measured over six calibration runs of identical binaries, this estimator holds a standard deviation of 1.79%, against 2.96% for a global minimum and 5.39% for a plain median.`,
    `- Base and head are driven **one prove at a time, alternating**, with the order flipped every prove. Running each side's batch back to back let the second side pay a consistent penalty — measured at +1.19% before this was fixed, which is a bias no number of repetitions removes.`,
    `- A wide gap between the reported figure and the max means the runner was busy. It does not invalidate the comparison (both sides ran interleaved on the same machine) but it is worth a second look.`,
    `- Base and head are built and measured in the same job on the same runner, so runner-to-runner drift cancels out.`,
    `- Δ % = (head − base) / base on that figure. Lower is better for every benchmark in this suite.`,
    results.thresholdProvisional
      ? `- The ±${formatPct(results.thresholdPct)} threshold is **provisional** — a placeholder, not a measured variance for this runner. [How to calibrate](${calibrationLink(ctx)}).`
      : `- The ±${formatPct(results.thresholdPct)} threshold is the calibrated run-to-run variance for this runner.`,
    `- Full machine-readable results are attached to [the run](${ctx.runUrl || "the workflow run"}) as \`results.json\`.`,
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

function assemble(
  results,
  ctx,
  rows,
  unit,
  { includeSamples, includeAllTable, notices }
) {
  const blocks = [];
  blocks.push(buildVerdict(results, rows));
  if (results.calibration) blocks.push(buildCalibrationNote(ctx));
  if (results.thresholdProvisional)
    blocks.push(buildProvisionalNote(results, ctx));
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

  return blocks.filter(Boolean).join("\n\n");
}

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

  let body = "";
  for (const attempt of attempts) {
    body = assemble(results, ctx, rows, unit, attempt);
    if (body.length <= maxChars) return body;
  }

  // Last resort: a hard cut with a visible marker. Reaching here means the
  // moved-rows table alone is enormous, which is itself worth surfacing.
  const marker =
    "\n\n> ✂️ Output truncated at the size limit — see `results.json` on the run for the complete data.\n";
  return `${body.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
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
 * @param {unknown} ctx Trusted GitHub context: { owner, repo, prNumber, headSha, baseSha, baseRef, runId, runUrl }.
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

/** Usage: node render-comment.mjs <results.json> <ctx.json> */
export async function main(argv = process.argv.slice(2)) {
  const [resultsPath, ctxPath] = argv;
  if (!resultsPath || !ctxPath) {
    process.stderr.write(
      "usage: node render-comment.mjs <results.json> <ctx.json>\n"
    );
    return 2;
  }

  let results;
  let ctx;
  try {
    results = JSON.parse(await readFile(resultsPath, "utf8"));
    ctx = JSON.parse(await readFile(ctxPath, "utf8"));
  } catch (error) {
    process.stderr.write(`failed to read inputs: ${error.message}\n`);
    return 1;
  }

  try {
    process.stdout.write(`${renderComment(results, ctx)}\n`);
  } catch (error) {
    // Refusing loudly is the point: a wrong comment is worse than none.
    process.stderr.write(`refusing to render: ${error.message}\n`);
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
