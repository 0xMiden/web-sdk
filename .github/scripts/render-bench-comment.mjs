#!/usr/bin/env node
/**
 * render-bench-comment.mjs — renders the WASM proving benchmark report for a PR comment
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
import { realpathSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
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

/**
 * Bumped whenever the MEANING of a field changes, not merely when one is added.
 *
 * v2: the summary statistics are no longer read from the artifact at all — they
 * are recomputed here from `samples`, which is now mandatory — and
 * `reps`/`provesPerRep` became the RETAINED counts rather than the configured
 * ones. Both halves of the pipeline are routinely at different revisions (the
 * reporter always runs the default branch's renderer against an artifact built
 * by the PR head's producer), so a version that does not move when the contract
 * moves lets a stale producer's numbers be relabelled by a newer renderer.
 *
 * Version 1 covers the truncation fields (`repsRequested`, `stoppedEarly`, `reps`
 * as the count MEASURED, `repsExecuted` allowing `reps + 2` when a repetition was
 * dropped for parity) because this renderer and the producer reach the default
 * branch together: the first artifact a deployed renderer sees is the first one
 * the current producer writes.
 *
 * THAT NO LONGER HOLDS ONCE THIS SHIPS. From then on the two halves run at
 * different revisions routinely — the producer from a pull request, the renderer
 * from the default branch — so any new field, or any widening of an existing
 * field's range or meaning, needs the bump procedure below. Widening without a
 * bump is silence on the PR, because a renderer that predates the change refuses
 * the artifact outright rather than ignoring the part it does not know.
 *
 * A SET, not a single number, and that is the whole point. The two halves live
 * in different trees — `crates/web-client/scripts/` and `.github/scripts/` — so
 * bumping them in one commit is not something the layout encourages, and with an
 * exact-match check either split order silences the bot for every open PR in the
 * interval: a producer-first split emits v3 at a v2 renderer, a renderer-first
 * split emits v2 at a v3 renderer.
 *
 * HOW TO BUMP THE SCHEMA, in this order:
 *   1. Add the new version here alongside the old one, and teach this file to
 *      read both. Merge to the DEFAULT BRANCH — nothing else takes effect,
 *      because `workflow_run` only ever runs the default branch's copy.
 *   2. Bump `schemaVersion` in bench-proving.mjs to the new version.
 *   3. Once no open PR can still be carrying the old producer, drop the old
 *      version from this set and delete the compatibility branch.
 */
const ACCEPTED_SCHEMA_VERSIONS = new Set([2]);

/**
 * Total sample values accepted across all benchmarks.
 *
 * The artifact is fork-controlled and the renderer holds every sample in memory
 * while building the raw block, so an inflated results.json is an OOM in the
 * job that carries the write token. A real run reports a few hundred values;
 * this is three orders of magnitude of headroom and still bounded.
 */
const MAX_SAMPLE_VALUES = 200000;

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

/**
 * The configuration the 1.79% estimator spread was measured at.
 *
 * `reps` and `provesPerRep` come from the artifact, so a run that reports one
 * repetition of one prove must not inherit a standard deviation measured over
 * six of three. Below EITHER count no verdict is published — see
 * `verdictPreconditions` and `MIN_REPS_FOR_SIGN_TEST` — because the fixed
 * threshold is 3σ of this estimator at these counts and is less than that for any
 * shorter run, on either axis. Above them the comment notes that the measured
 * spread does not apply while still gating on the threshold, which is the
 * conservative direction.
 */
const CALIBRATED_REPS = 6;
const CALIBRATED_PROVES_PER_REP = 3;

/**
 * Fewest repetitions at which a verdict is published at all.
 *
 * Pinned to CALIBRATED_REPS, and that is the whole argument: THRESHOLD_PCT is 3σ
 * of this estimator measured AT that repetition count, and the spread of a mean
 * of per-repetition minima shrinks with 1/√reps, so the floor does not transfer
 * downward. Applied to a four-repetition run it is only about 2.5σ of that run's
 * own estimator — the magnitude leg silently weakens exactly where the sign leg
 * is weakest too, since unanimity across four signs happens by chance one run in
 * eight. Simulated with the floor lifted, four repetitions carry a joint
 * false-positive rate of 1.07% against the calibrated six's 0.15% — seven times
 * the noise for a shorter job. (Historical figures: with the floor in place a
 * four-repetition run produces no verdict at all, so the simulator now reports
 * 0.00% there.) Above the floor both legs move the safe way — the fixed threshold becomes
 * MORE than 3σ of a longer run's tighter estimator — so only the downward
 * direction needs blocking.
 *
 * Shorter runs still render; they report the movement and say the run was too
 * short to judge it. See docs/benchmarks/calibration.md.
 */
const MIN_REPS_FOR_SIGN_TEST = CALIBRATED_REPS;

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
 *   Cs — surrogates. JSON can encode a LONE one (`"\ud800"`), which survives
 *        `JSON.parse` and makes the returned body ill-formed UTF-16; the GitHub
 *        API then rejects the request or stores a replacement char. Code-point
 *        truncation does not help — the lone surrogate IS a code point.
 *   Default_Ignorable_Code_Point — the blank-but-not-`\s` glyphs, as a property
 *        rather than a hand-written list. Hangul fillers (U+115F, U+1160,
 *        U+3164), U+FFA0, variation selectors and the rest are all covered;
 *        without this a name of 80 fillers renders as an empty cell 160 columns
 *        wide. U+2800 BRAILLE PATTERN BLANK is not default-ignorable, so it is
 *        still listed by hand.
 *
 * Whitespace is then collapsed and the result truncated so one long name cannot
 * dominate.
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
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, " ")
    .replace(/[\p{Default_Ignorable_Code_Point}\u2800]/gu, " ")
    // Keep at most two combining marks per base character. Unbounded stacking
    // ("zalgo") renders as a cell many lines tall that pushes the rest of the
    // table off the screen, and no real benchmark name needs a third. Stripping
    // marks outright would instead mangle legitimate text, so this caps rather
    // than removes.
    .replace(/(\p{M}\p{M})\p{M}+/gu, "$1")
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
  // JSON.stringify turns Infinity, -Infinity and NaN all into the string
  // "null", so every non-finite diagnostic this file emits — the case where the
  // actual value is the whole point — read "got null" and sent the reader
  // looking for a missing field instead of an overflow.
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
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

/**
 * Every rejection of artifact content goes through here, and the marker it sets
 * is what lets `main` tell "the fork sent us garbage" apart from "this renderer
 * has a bug". Both used to surface as the same generic notice, so a TypeError in
 * first-party code — or an EACCES reading a path — silently disabled benchmark
 * reporting for every PR while the trusted workflow stayed green.
 */
function fail(message) {
  const error = new TypeError(`benchmark results: ${message}`);
  error.rejectedArtifact = true;
  throw error;
}

function requireFinite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number, got ${describeValue(value)}`);
  }
  return value;
}

function requireInt(
  value,
  path,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {}
) {
  requireFinite(value, path);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(
      `${path} must be an integer in [${min}, ${max}], got ${describeValue(value)}`
    );
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
 * Samples arrive grouped per rep: `[[a, b, c], [d, e, f]]`.
 *
 * The grouping is not cosmetic — it is what the headline estimator is defined
 * over (the mean of each rep's fastest prove) — so a flat array is refused
 * rather than guessed at. It also has to agree with the declared retained
 * counts: an artifact that says six reps and ships two groups is internally
 * inconsistent, and every number derived from it would be mislabelled.
 */
function normalizeSamples(value, path, reps, provesPerRep, budget) {
  if (!Array.isArray(value))
    fail(
      `${path} must be an array of per-rep arrays, got ${describeValue(value)}`
    );
  if (value.length !== reps)
    fail(`${path} must hold ${reps} per-rep groups, got ${value.length}`);

  return value.map((group, i) => {
    if (!Array.isArray(group))
      fail(`${path}[${i}] must be an array of numbers`);
    if (group.length !== provesPerRep) {
      fail(
        `${path}[${i}] must hold ${provesPerRep} ${plural(provesPerRep, "sample")}, got ${group.length}`
      );
    }
    budget.remaining -= group.length;
    if (budget.remaining < 0) {
      fail(`too many samples; the cap is ${MAX_SAMPLE_VALUES} values`);
    }
    return group.map((n, j) => {
      // Every sample is a duration in milliseconds measured by
      // `performance.now()`, so a negative one is not a slow benchmark — it is
      // not a measurement at all. Accepting them let a pair of negative sides
      // render `+10.00% faster` off `(-11 - -10) / -10`, with the sign of the
      // percentage flipped by the sign of the baseline.
      const value = requireFinite(n, `${path}[${i}][${j}]`);
      if (value < 0) {
        fail(
          `${path}[${i}][${j}] must be a non-negative duration, got ${describeValue(value)}`
        );
      }
      return value;
    });
  });
}

const mean = (xs) => xs.reduce((total, x) => total + x, 0) / xs.length;
const minOf = (xs) => xs.reduce((lo, x) => (x < lo ? x : lo), Infinity);
const maxOf = (xs) => xs.reduce((hi, x) => (x > hi ? x : hi), -Infinity);

function medianOf(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Returns `null` for a side that was not measured.
 *
 * `summarize()` in bench-proving.mjs emits `null` for a side with no samples,
 * which is what happens when the base dist fails to build — bench.yml warns and
 * carries on deliberately, reporting head-only. Refusing that shape here would
 * turn the documented fallback into a hard failure.
 *
 * EVERY STATISTIC IS RECOMPUTED FROM `samples`. The artifact's own `value`,
 * `min`, `median`, `max`, `statistic` and `perRepMin` are ignored outright.
 *
 * Pinning the threshold and the direction on this side was only half the job:
 * with the NUMBERS still trusted, a fork kept full control of the verdict by
 * arithmetic instead of by flag — samples showing head 10% slower, a `value`
 * pair claiming 8% faster, and a comment posted under this repo's token that
 * asserts in its own methodology section that the figure is the mean of the
 * per-rep minima of exactly those samples. Recomputing makes that sentence
 * true. The producer rounds `samples` to 3 decimals and computes its own
 * summary from the unrounded values, so the two differ in the sub-microsecond
 * digits; nothing here compares them.
 */
function normalizeSide(value, path, reps, provesPerRep, budget) {
  if (value === undefined || value === null) return null;
  const side = requireObject(value, path);
  const samples = normalizeSamples(
    side.samples,
    `${path}.samples`,
    reps,
    provesPerRep,
    budget
  );
  const flat = samples.flat();
  // Each input is finite and the arithmetic still is not: mean() sums before it
  // divides, so two samples of 1e308 overflow to Infinity and the row renders
  // as "∞". The delta checks in computeRows do not catch it, because a
  // head-only run has no delta to check. This module promises no non-finite
  // value ever reaches a comment; that promise has to be kept where the values
  // are produced, not only where they are combined.
  return {
    // The mean of each rep's fastest prove — see the estimator comment in
    // bench-proving.mjs for why both levels are there.
    value: requireFinite(
      mean(samples.map(minOf)),
      `${path}.value (recomputed)`
    ),
    median: requireFinite(medianOf(flat), `${path}.median (recomputed)`),
    min: requireFinite(minOf(flat), `${path}.min (recomputed)`),
    max: requireFinite(maxOf(flat), `${path}.max (recomputed)`),
    samples,
  };
}

function normalizeResults(input) {
  const results = requireObject(input, "root");

  // An unknown schema means the producer and this renderer disagree about what
  // the fields mean. Guessing would emit confident, wrong numbers.
  //
  // The message names both SIDES, not just both numbers. Whoever reads this is
  // looking at a default-branch workflow log for a PR they did not write, and
  // "must be 2, got 3" tells them nothing about why two numbers that should
  // match do not.
  if (!ACCEPTED_SCHEMA_VERSIONS.has(results.schemaVersion)) {
    const accepted = [...ACCEPTED_SCHEMA_VERSIONS].join(", ");
    fail(
      `schemaVersion ${describeValue(results.schemaVersion)} came from the bench ` +
        `script on the PR head; this renderer runs from the repository's default ` +
        `branch and reads [${accepted}]. The two halves of this pipeline are always ` +
        `at different revisions — see ACCEPTED_SCHEMA_VERSIONS in ` +
        `.github/scripts/render-bench-comment.mjs for how to bump it without an outage.`
    );
  }

  // Bounded, because these three are still artifact-authored and the comment
  // prints them as statements of fact about what ran ("6 reps × 3 warm proves,
  // 8 threads"). They cannot be recomputed the way the measurements are — the
  // reporter has no independent knowledge of the bench configuration — so the
  // most that can be done is refuse values no real run could produce, which at
  // least keeps the claim within a believable range and stops a single sample
  // from being dressed up as a large one.
  const reps = requireInt(results.reps, "reps", { min: 1, max: 1000 });
  const provesPerRep = requireInt(results.provesPerRep, "provesPerRep", {
    min: 1,
    max: 1000,
  });
  const threads = requireInt(results.threads, "threads", { min: 1, max: 1024 });

  // The methodology section states the discard policy as fact — "one extra
  // repetition and the first prove of every page run first and are discarded" —
  // about a producer a fork controls. The artifact already carries the executed
  // counts, so the claim can be checked instead of asserted. An artifact whose
  // executed counts do not sit exactly one above the retained ones did not run
  // the protocol the comment is about to describe.
  const repsExecuted = requireInt(results.repsExecuted, "repsExecuted", {
    min: 2,
    max: 1001,
  });
  const provesExecutedPerRep = requireInt(
    results.provesExecutedPerRep,
    "provesExecutedPerRep",
    { min: 2, max: 1001 }
  );
  // Presence only. `stoppedEarly` carries a message on the producing side, and
  // that message is deliberately not read: a fork controls the producer, comment
  // prose is pinned here, and a truncation notice a fork could word is a sentence
  // in the comment it does not get to write. What is rendered below is composed
  // from these validated integers.
  const stoppedEarly = Boolean(results.stoppedEarly);

  // Only meaningful on a stopped run, and only if it exceeds what was retained —
  // otherwise nothing was lost and the claim contradicts itself.
  let repsRequested = null;
  if (stoppedEarly) {
    repsRequested = requireInt(results.repsRequested, "repsRequested", {
      min: 1,
      max: 1000,
    });
    if (repsRequested <= reps) {
      fail(
        `repsRequested must exceed the ${reps} retained ${plural(reps, "rep")} on a run that stopped early, got ${repsRequested}`
      );
    }
  }

  // A full run executes exactly one repetition more than it retains: the
  // discarded warm-up. A run that stopped early may have executed one MORE than
  // that, the repetition dropped to keep the setup order balanced — but no more,
  // because anything beyond that was never completed. Bounding it rather than
  // dropping the check keeps the protocol claim verifiable on both paths.
  const maxExecuted = stoppedEarly ? reps + 2 : reps + 1;
  if (repsExecuted < reps + 1 || repsExecuted > maxExecuted) {
    fail(
      `repsExecuted must be ${
        stoppedEarly
          ? `${reps + 1} or ${maxExecuted} for a run that stopped early after retaining ${reps} ${plural(reps, "rep")} (the discarded warm-up, plus at most one repetition dropped for balance)`
          : `one more than the ${reps} retained ${plural(reps, "rep")} (the discarded warm-up)`
      }, got ${repsExecuted}`
    );
  }
  if (provesExecutedPerRep !== provesPerRep + 1) {
    fail(
      `provesExecutedPerRep must be one more than the ${provesPerRep} retained ${plural(provesPerRep, "prove")} (the discarded first prove), got ${provesExecutedPerRep}`
    );
  }

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
  // Shared across every side of every benchmark: the cap that matters is the
  // total the renderer holds at once, not the per-benchmark count.
  const budget = { remaining: MAX_SAMPLE_VALUES };

  const benchmarks = results.benchmarks.map((entry, i) => {
    const b = requireObject(entry, `benchmarks[${i}]`);
    const head = normalizeSide(
      b.head,
      `benchmarks[${i}].head`,
      reps,
      provesPerRep,
      budget
    );
    if (head === null) fail(`benchmarks[${i}].head has no measurements`);
    return {
      name: sanitizeText(b.name, MAX_NAME_CHARS, `benchmark #${i + 1}`),
      unit: sanitizeUnit(b.unit),
      base: normalizeSide(
        b.base,
        `benchmarks[${i}].base`,
        reps,
        provesPerRep,
        budget
      ),
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
    stoppedEarly,
    repsRequested,
    teardownFailures: normalizeTeardownFailures(results.teardownFailures),
    benchmarks,
  };
}

// A producer that could not release its pages, browser or servers. Fork-
// controlled like everything else in the artifact, so the strings are sanitized
// and capped and only the COUNT is load-bearing — the banner reads the same
// whether the strings are real or invented, and an artifact that lies here only
// costs itself a caveat it did not need.
const MAX_TEARDOWN_FAILURES = 8;

function normalizeTeardownFailures(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TEARDOWN_FAILURES).map((entry, i) => {
    // Strings only. `String({})` is "[object Object]", which sanitizes cleanly
    // and would then be published as if it were a diagnostic; the placeholder at
    // least says what it is. The count is what matters either way.
    const placeholder = `teardown failure #${i + 1} (not a string)`;
    return typeof entry === "string"
      ? sanitizeText(entry, 120, placeholder)
      : placeholder;
  });
}

// Lowercase-only, matching what both `git rev-parse` and the GitHub API return,
// and matching the shell-side check in bench-comment.yml. An uppercase sha
// would render a link nobody can match against a `git log`.
const SHA_RE = /^[0-9a-f]{7,40}$/;
// GitHub's own rule for an owner or a repo name, minus the dot-segments: a bare
// `.` or `..` passes a naive character-class check and then normalizes inside a
// URL into a link to a different repo entirely. Both values are trusted here,
// but a character class that permits `..` is not a property worth relying on.
const SLUG_SRC = "(?!\\.\\.?(?:$|/))[A-Za-z0-9._-]+";
const SLUG_RE = new RegExp(`^${SLUG_SRC}$`);
// The exact shape both workflows build, rather than a loose path match. Built
// from SLUG_SRC rather than a hand-written `[\w.-]+`, which is what the previous
// version used: that accepted `https://github.com/../../actions/runs/12`, so the
// comment claiming it was tightened against traversal described a guard the
// regex did not implement. Sharing the source is what keeps the two honest.
const RUN_URL_RE = new RegExp(
  `^https://github\\.com/${SLUG_SRC}/${SLUG_SRC}/actions/runs/\\d+$`
);

/**
 * Unlike the results, `ctx.json` is TRUSTED: the reporter builds it with `jq`
 * from fields GitHub populated for the run, and the artifact's own copy is
 * deliberately never extracted. So a rejection here is not a fork sending
 * garbage — it is the reporter's own context step having produced something
 * wrong, which is a first-party bug and must not be reported as an artifact
 * refusal. `failInternal` keeps those on the exit-3 path.
 */
function failInternal(message) {
  throw new TypeError(`rendering context: ${message}`);
}

function normalizeContext(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    failInternal(`ctx must be an object, got ${describeValue(input)}`);
  }
  const ctx = input;
  const owner = String(ctx.owner ?? "");
  const repo = String(ctx.repo ?? "");
  if (!SLUG_RE.test(owner))
    failInternal(
      `ctx.owner is not a valid repo owner: ${describeValue(ctx.owner)}`
    );
  if (!SLUG_RE.test(repo))
    failInternal(
      `ctx.repo is not a valid repo name: ${describeValue(ctx.repo)}`
    );

  const headSha = String(ctx.headSha ?? "");
  const baseSha = String(ctx.baseSha ?? "");
  if (!SHA_RE.test(headSha))
    failInternal(
      `ctx.headSha is not a commit sha: ${describeValue(ctx.headSha)}`
    );
  if (!SHA_RE.test(baseSha))
    failInternal(
      `ctx.baseSha is not a commit sha: ${describeValue(ctx.baseSha)}`
    );

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
const EMOJI_UNRESOLVED = "❔";

/**
 * Do the per-repetition pairs agree with the aggregate about the direction?
 *
 * The threshold alone tests a ratio of two means and throws away the spread that
 * produced them, even though the samples are right there in the artifact. Six
 * repetitions clustered at +5.3% and a pair of repetitions straddling zero can
 * report the same aggregate percentage, and only one of them is a result.
 *
 * Base and head are driven interleaved within a repetition, so repetition `i` of
 * one side pairs with repetition `i` of the other: the two saw the same machine,
 * the same thermal state and the same neighbours. That makes the per-repetition
 * differences a legitimate paired sample, and requiring all of them to share the
 * aggregate's sign is a sign test — for the default six repetitions it is the
 * 2/2^6 ≈ 3% tail, without assuming normality.
 *
 * A repetition with an exactly zero difference neither agrees nor contradicts,
 * so it is not counted against consistency — but it cannot be allowed to
 * MANUFACTURE consistency either. On its own, "nothing contradicts" is satisfied
 * by five repetitions at exactly zero and one large one, which is the single
 * dominating repetition this function exists to catch, arriving through the
 * exemption instead of through a sign flip. So a majority of the repetitions
 * must positively agree as well.
 *
 * What this does NOT test is dispersion. Five repetitions at +0.5% and one at
 * +30% all share a sign and pass, and the aggregate they produce is driven by
 * the one. The sign test bounds the false-positive rate without assuming
 * normality; it is not a claim that the effect is evenly distributed.
 */
function pairedAgreement(base, head) {
  const reps = Math.min(base.samples.length, head.samples.length);
  if (reps === 0) return { consistent: false, agree: 0, reps: 0 };
  // Below the calibrated repetition count neither leg holds up: a one-repetition
  // run passes this test unconditionally (`contradicting === 0 && 2 > 1`), its
  // any-direction false-positive rate is 1/2^(reps-1), i.e. 2/2^reps for the two
  // unanimous outcomes — 100% at 1, 50% at 2, 25% at
  // 3, 12.5% at 4 — and the fixed magnitude floor is below 3σ of a short run's
  // own estimator at the same time. Since `reps` is artifact-authored, a fork
  // that wants a verdict it has not earned would otherwise only have to send
  // fewer repetitions. Anything shorter is reported as unresolved with the
  // reason named, never as significant.
  if (reps < MIN_REPS_FOR_SIGN_TEST) {
    return { consistent: false, agree: 0, reps, tooShort: true };
  }
  const deltas = [];
  for (let i = 0; i < reps; i += 1) {
    deltas.push(minOf(head.samples[i]) - minOf(base.samples[i]));
  }
  const direction = Math.sign(mean(deltas));
  if (direction === 0) return { consistent: false, agree: 0, reps };
  const agree = deltas.filter((d) => Math.sign(d) === direction).length;
  const contradicting = deltas.filter(
    (d) => d !== 0 && Math.sign(d) !== direction
  ).length;
  return {
    consistent: contradicting === 0 && agree * 2 > reps,
    agree,
    reps,
  };
}

/**
 * The same delta computed over EVERY retained prove rather than over each
 * repetition's fastest one.
 *
 * The headline estimator takes a minimum per repetition, which is what buys its
 * low variance — and which also throws away any slowdown that does not land on
 * the fastest prove of a repetition. A change that makes two proves in three 50%
 * slower leaves the headline at +0.00%, because the untouched third prove is
 * still the minimum. That is not a hypothetical property of minima; it is the
 * common shape of a regression in a garbage collector, a lock, a retry path, or
 * a cold cache, and users experience the mean, not the best case.
 *
 * So this is computed alongside and reported when the two disagree. It is
 * deliberately NOT the verdict: its spread has never been measured, and the one
 * neighbouring figure that gets quoted for it — 5.39% — is the calibrated sd of
 * the MEDIAN, a different statistic. Promoting this cross-check on the strength
 * of that number would be promoting it on a distribution nobody has measured, so
 * it stays a cross-check gated by its own sign test (`pairedMeanAgreement`).
 * Reporting the disagreement costs nothing and is the only signal that the
 * minimum estimator's blind spot was hit.
 */
function meanDeltaPct(base, head) {
  if (base === null) return null;
  const baseMean = mean(base.samples.flat());
  const headMean = mean(head.samples.flat());
  if (!Number.isFinite(baseMean) || !Number.isFinite(headMean)) return null;
  if (baseMean === 0) return null;
  const pct = ((headMean - baseMean) / baseMean) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * `pairedAgreement`'s test applied to per-repetition MEAN deltas.
 *
 * Shares the rule, and the rep-count floor, with the headline sign test — the
 * point of a cross-check is that it is held to the same standard, not a laxer
 * one. What it does not share is a calibrated sigma: nothing here has measured
 * the spread of a mean over all proves on this workload, which is exactly why
 * the sign test rather than a threshold is what bounds this note's false
 * positives.
 */
function pairedMeanAgreement(base, head) {
  const reps = Math.min(base.samples.length, head.samples.length);
  if (reps === 0) return { consistent: false, agree: 0, reps: 0 };
  if (reps < MIN_REPS_FOR_SIGN_TEST) {
    return { consistent: false, agree: 0, reps, tooShort: true };
  }
  const deltas = [];
  for (let i = 0; i < reps; i += 1) {
    deltas.push(mean(head.samples[i]) - mean(base.samples[i]));
  }
  const direction = Math.sign(mean(deltas));
  if (direction === 0) return { consistent: false, agree: 0, reps };
  const agree = deltas.filter((d) => Math.sign(d) === direction).length;
  const contradicting = deltas.filter(
    (d) => d !== 0 && Math.sign(d) !== direction
  ).length;
  return { consistent: contradicting === 0 && agree * 2 > reps, agree, reps };
}

/**
 * Whether this run's methodology supports a faster/slower verdict at all,
 * independent of what its numbers say.
 *
 * The verdict rests on two calibrated properties, and both are properties of the
 * RUN rather than of any one benchmark — so when either fails, every benchmark in
 * the run is unresolved and the reason is the same for all of them.
 *
 * A run that stopped on the clock. Its length was chosen by how slow the machine
 * was, and how slow the machine was is the quantity being measured, so the pairs
 * that survive are a selected sample rather than the first N of an unselected
 * one. Whether that selection biases the PAIRED delta turns entirely on the two
 * sides having equal run-level variance: selection acts on the total duration,
 * and its correlation with the difference is Var(head) - Var(base), which is zero
 * only when those match. Simulated over the interleave this producer actually
 * runs, symmetric run-level noise leaves the truncated estimate unbiased to
 * -0.19pp, while giving ONE side a 12% run-level factor moves it by -18.90pp or
 * +22.66pp depending on which side gets the factor — three to four times the
 * whole 5.40% threshold, and in whichever direction the asymmetry points. Nothing
 * has measured whether the two binaries have equal run-level variance on this
 * workload, and the calibration was taken from complete runs, so the honest
 * position is that a truncated run reports its numbers without ruling on them.
 * See docs/benchmarks/truncation-selection.mjs.
 *
 * A run with an odd repetition count. The setup order alternates by repetition,
 * so an odd count opens one side first once more than the other — a fixed
 * positional asymmetry, which repetitions cannot average out. The producer
 * refuses an odd `--reps` outright and drops the odd tail of a truncated run for
 * this reason, but `reps` is artifact-authored: an older producer, or a crafted
 * artifact, can still present one, and it must not buy a confident verdict.
 *
 * Neither case suppresses the measurements. The numbers, the samples and the
 * mean cross-check all still render; what is withheld is the claim that they
 * establish a direction.
 */
function verdictPreconditions({ stoppedEarly, reps, provesPerRep }) {
  if (stoppedEarly) {
    return {
      ok: false,
      blocked: "stoppedEarly",
    };
  }
  if (Number.isInteger(reps) && reps % 2 !== 0) {
    return {
      ok: false,
      blocked: "oddReps",
    };
  }
  // The same argument as the repetition floor, on the other axis. THRESHOLD_PCT
  // is 3σ of an estimator measured over the minimum of THREE retained proves, and
  // the minimum of fewer is a noisier statistic — so applying the fixed floor to a
  // one-prove run compares a movement against a cutoff that is well under 3σ of
  // that run's own spread. Repetitions were blocked below their calibrated count
  // for exactly this and proves were only footnoted, which was inconsistent: both
  // legs weaken the same way and `provesPerRep` is artifact-authored too, so a
  // one-rep-one-prove artifact was the cheapest route to a confident verdict.
  //
  // Only downward. More proves lower the variance of each repetition's minimum,
  // which makes the fixed floor MORE than 3σ — conservative, so it still holds.
  if (
    Number.isInteger(provesPerRep) &&
    provesPerRep < CALIBRATED_PROVES_PER_REP
  ) {
    return { ok: false, blocked: "tooFewProves" };
  }
  return { ok: true };
}

function computeRows(results) {
  const preconditions = verdictPreconditions(results);
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
    // The run-level precondition outranks the per-benchmark test. It is applied
    // by REPLACING the agreement rather than by filtering later, so that every
    // consumer of `agreement` — the verdict heading, the table emoji, the
    // unresolved note and the mean cross-check — sees one consistent answer.
    // Deciding this in two places is how a heading and its own note came to
    // contradict each other before.
    const measured =
      b.base === null
        ? { consistent: false, agree: 0, reps: 0 }
        : pairedAgreement(b.base, b.head);
    // The repetition floor OUTRANKS the run-level block, because a run below the
    // floor is short first and whatever else second. A one-repetition run is also
    // an odd-repetition run, and "one repetition is too few" is the reason its
    // author can act on; "the setup order is unbalanced" is true and useless
    // there. Above the floor the block is the only thing standing between a
    // selected sample and a confident verdict, so it applies.
    const agreement =
      measured.tooShort || b.base === null || preconditions.ok
        ? measured
        : { ...measured, consistent: false, blocked: preconditions.blocked };
    // Two independent conditions, and both have to hold. The threshold is the
    // smallest movement worth reporting at all; the paired agreement is whether
    // the repetitions actually support a movement of that direction. A movement
    // that clears the floor on aggregate while its repetitions disagree is
    // neither a result nor noise — it is unresolved, and saying so is more
    // honest than picking one of the two labels.
    //
    // `magnitude > 0` so a threshold of zero does not classify an exactly
    // unchanged benchmark as a movement — and then as an improvement.
    //
    // Compared at the DISPLAYED precision. On the unrounded value a magnitude of
    // 5.396% renders as "+5.40%" and is then called noise against a floor the
    // same line prints as "±5.40%", which reads as a bug at exactly the boundary
    // a reader stops to check.
    const shown = Number(magnitude.toFixed(2));
    const clearsFloor = shown > 0 && shown >= Number(THRESHOLD_PCT.toFixed(2));
    const beyond = clearsFloor && agreement.consistent;
    const unresolved = clearsFloor && !agreement.consistent;
    const isWorse = LOWER_IS_BETTER ? deltaValue > 0 : deltaValue < 0;
    // Flagged when the mean moved past the floor but the headline did not: that
    // is the signature of a change that missed every repetition's fastest prove,
    // which the headline estimator cannot see by construction.
    //
    // Gated on a sign test over the per-repetition MEAN deltas, not on the
    // threshold alone. THRESHOLD_PCT is 3σ of the headline estimator (σ 1.79%);
    // the spread of a mean over all proves has never been measured on this
    // workload, so using that threshold as if it were 3σ of this statistic too
    // would be borrowing a number from the wrong distribution. The sign test
    // does the work instead: it needs no σ, and at six repetitions its
    // any-direction false-positive rate is 1/2^5 ≈ 3% (1.6% per direction). The
    // magnitude floor stays on as a
    // relevance gate — "large enough to bother reading about" — which is a
    // different claim from "3σ".
    const meanPct = meanDeltaPct(b.base, b.head);
    // Gated by the same precondition as the headline. This is a second channel
    // that can publish a directional claim, so exempting it would have let a
    // truncated run say "the mean of all proves moved and its repetitions agree"
    // in a comment whose headline had just declined to rule — the selection
    // argument applies to a mean of all proves exactly as it does to a mean of
    // minima.
    const meanAgreement =
      b.base === null || agreement.blocked
        ? null
        : pairedMeanAgreement(b.base, b.head);
    const meanOnly =
      meanPct !== null &&
      deltaPct !== null &&
      !clearsFloor &&
      meanAgreement !== null &&
      meanAgreement.consistent &&
      Number(Math.abs(meanPct).toFixed(2)) >= Number(THRESHOLD_PCT.toFixed(2));
    return {
      ...b,
      deltaValue,
      deltaPct,
      magnitude,
      beyond,
      unresolved,
      agreement,
      isWorse,
      meanPct,
      meanAgreement,
      meanOnly,
      emoji: beyond
        ? isWorse
          ? EMOJI_WORSE
          : EMOJI_BETTER
        : unresolved || deltaPct === null || meanOnly
          ? EMOJI_UNRESOLVED
          : EMOJI_NOISE,
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
    // Two different states, and they were sharing one sentence. "No base
    // measurements" is true only when there is no base side at all; a base side
    // whose figure is zero has measurements, they just cannot carry a
    // percentage. Claiming the first while the table below prints base values
    // reads as a bug in the bot.
    if (rows.every((r) => r.base === null)) {
      return "### ❔ Head-only run — no base measurements to compare against";
    }
    if (rows.every((r) => r.base !== null)) {
      return "### ❔ No comparison possible — every benchmark's base figure is zero, so a percentage would be meaningless";
    }
    // Mixed: some rows have no base side at all, the rest have one that is zero.
    // Both of the sentences above are false for this report.
    return "### ❔ No comparison possible — some benchmarks have no base measurement and the rest have a base figure of zero";
  }

  const thresholdText = `${THRESHOLD_PROVISIONAL ? "provisional " : ""}±${formatPct(THRESHOLD_PCT)}`;
  const moved = rows.filter((r) => r.beyond);
  const unresolved = rows.filter((r) => r.unresolved);
  const worst = comparable[0];

  if (moved.length === 0 && unresolved.length > 0) {
    // Clears the floor but the repetitions disagree about the direction. Calling
    // that "no significant change" would bury it, and calling it a regression
    // would assert something the samples do not support.
    const leader = unresolved[0];
    const rest =
      unresolved.length > 1 ? ` (+${unresolved.length - 1} more)` : "";
    // Two ways to land here, and they call for different reading. Disagreement
    // means the samples contradict each other; too short means they were never
    // asked to. Printing "its repetitions disagree" for a one-repetition run
    // describes a disagreement that cannot exist.
    // Three ways to land here now, and they call for different reading.
    // Disagreement means the samples contradict each other. Too short means they
    // were never asked to. Blocked means they may well agree and the run is
    // declining to rule anyway, because the calibration the ruling would rest on
    // does not cover a run of this shape — saying "its repetitions disagree"
    // there would be a claim about the data that the code never tested.
    const why = leader.agreement.blocked
      ? `moved beyond the floor, but this run cannot be ruled on — see below`
      : leader.agreement.tooShort
        ? `moved beyond the floor, but ${leader.agreement.reps} ${plural(leader.agreement.reps, "repetition")} is too few to tell a real movement from noise`
        : "moved beyond the floor but its repetitions disagree";
    return `### ${EMOJI_UNRESOLVED} Unresolved ${formatSignedPct(leader.deltaPct)}: ${codeSpan(leader.name)} ${why}${rest}`;
  }

  if (moved.length === 0) {
    // The mean cross-check outranks a flat "no significant change". `worst` is
    // the largest movement by the HEADLINE estimator, and every mean-only row is
    // below the floor on that by construction — so the unqualified sentence
    // rendered a heading of "no significant change (largest -0.4%)" directly
    // above a note reporting a +8% mean slowdown, in the opposite direction and
    // an order of magnitude larger. Whichever of the two a reader believed, the
    // comment had already contradicted itself.
    const meanFlagged = rows
      .filter((r) => r.meanOnly)
      .sort((a, b) => Math.abs(b.meanPct) - Math.abs(a.meanPct));
    if (meanFlagged.length > 0) {
      const leader = meanFlagged[0];
      const rest =
        meanFlagged.length > 1 ? ` (+${meanFlagged.length - 1} more)` : "";
      const direction = (
        LOWER_IS_BETTER ? leader.meanPct > 0 : leader.meanPct < 0
      )
        ? "slower"
        : "faster";
      return `### ${EMOJI_UNRESOLVED} Unresolved: nothing clears the ${thresholdText} floor, but the mean of all proves is ${formatSignedPct(leader.meanPct)} ${direction} on ${codeSpan(leader.name)}${rest}`;
    }
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
  // While the floor is provisional this heading states an OBSERVATION, not a
  // ruling, and the difference is not cosmetic. `⚠️ +10.00% slower` reads as
  // "this pull request regressed proving", which is a claim of significance —
  // and the note below it says the floor here is unknown in both magnitude and
  // direction, so the comment asserted and disclaimed the same thing.
  //
  // Not withheld, though, which is the other way to resolve the contradiction.
  // The gates in verdictPreconditions all cover cases where the ESTIMATE is
  // compromised — truncation selects the sample, an odd repetition count adds a
  // fixed positional bias — and a movement measured under them is not worth
  // reporting as a direction at all. A provisional floor is not that: the
  // estimate is exactly as sound as it will ever be, and only the cutoff it was
  // compared against is a guess carried over from a laptop. Refusing to name the
  // direction of a large, repetition-consistent movement on those grounds would
  // discard the signal the bot exists to surface, so the number and the paired
  // agreement stay and only the claim of significance is dropped.
  if (THRESHOLD_PROVISIONAL) {
    return (
      `### ${emoji} ${formatSignedPct(leader.deltaPct)} ${direction} on this run: ` +
      `${codeSpan(leader.name)}${rest} — not yet a verdict, the floor here is uncalibrated`
    );
  }
  return `### ${emoji} ${formatSignedPct(leader.deltaPct)} ${direction}: ${codeSpan(leader.name)}${rest}`;
}

/**
 * bench.yml warns and carries on when the base dist fails to build, so an
 * artifact can legitimately carry head measurements and no base. Saying that
 * out loud beats a table of "n/a" the reader has to interpret.
 */
/**
 * The producer left resources open. On a self-hosted runner that leaks into the
 * NEXT run's numbers, and mid-run it means later repetitions were measured
 * against a page that should have been gone — which is exactly the interference
 * this benchmark exists to exclude. The bench job goes red for it, but the job
 * and this comment are separate surfaces and nothing else connects them, so the
 * numbers read as an ordinary clean measurement.
 */
function buildTeardownNote(teardownFailures) {
  if (teardownFailures.length === 0) return null;
  const count = teardownFailures.length;
  return [
    `> **Treat these numbers with suspicion.** The benchmark run reported ${count} teardown ${count === 1 ? "failure" : "failures"},`,
    "> meaning it could not release a page, a browser or a server. Resources left open during the run",
    "> are measured against, and resources left open after it affect the next run on the same machine.",
    "> The benchmark job is failing for this — see its log.",
    // In a code span, like every other fork-controlled string this file renders.
    // `sanitizeText` removes what makes HTML and tables dangerous — backticks,
    // pipes, angle brackets, `@`, `&` — but markdown link, image, autolink,
    // cross-reference and emoji syntax survive it untouched, and these lines were
    // interpolated as raw GFM. A fork could put `[Security review passed](…)` in
    // the privileged comment as a live link, `![](…)` as a remote image, `#1` as
    // a real cross-reference that backlinks from the target issue, and a bare URL
    // as an autolink. The span makes all of it literal text.
    ...teardownFailures.map((failure) => `> - ${codeSpan(failure)}`),
  ].join("\n");
}

// A run that hit its wall-clock budget and reported what it had finished.
//
// Disclosed rather than suppressed. The estimate itself survives truncation: the
// reported figure is a PAIRED difference and the budget is consumed by both sides
// together, so stopping on elapsed time selects for slow machine periods, which
// is common mode and cancels in the ratio. Simulated at the calibrated
// configuration, a run stopped with six repetitions retained reports the same
// mean delta as an uninterrupted one to within 0.1% under the null and under a
// true 8% effect, with the same false-positive rate — including under thermal
// drift and heavy-tailed prove times. See docs/benchmarks/calibration.md.
//
// What truncation does cost is repetitions, and therefore power, which the
// verdict already accounts for by refusing to resolve below
// MIN_REPS_FOR_SIGN_TEST. So the note exists to tell the reader the run did not
// do what the methodology below describes — not to warn them off the number.
//
// Worded here, from validated integers, never from the producer's `stoppedEarly`
// string. A fork controls that string, and it does not get to write a sentence in
// this comment.
function buildStoppedEarlyNote(results) {
  if (!results.stoppedEarly) return null;
  const { reps, repsRequested } = results;
  const dropped = repsRequested - reps;
  return [
    `> **This run stopped early.** It retained ${reps} of the ${repsRequested} ${plural(repsRequested, "repetition")} it was configured for,`,
    `> ${dropped === 1 ? "having run out" : "because it ran out"} of its wall-clock budget. Everything below is computed over the ${reps} it finished,`,
    "> and no faster/slower verdict is issued from it: a run whose length was decided by the clock is a",
    "> selected sample, and the noise floor was calibrated on complete runs. The measurements are still",
    "> worth reading — they are real — but treat them as an indication rather than a result.",
    "> If this recurs, the budget is too tight rather than the run too slow: raise the benchmark step's",
    "> `timeout-minutes` and `--budget-minutes` together, or lower the repetition count.",
  ].join("\n");
}

function buildHeadOnlyNote() {
  return [
    "> **No base measurements.** The base build did not produce a dist, so this run reports head",
    "> timings only and there is nothing to compare them against. See the run log for why.",
  ].join("\n");
}

/**
 * The mixed case: some benchmarks have a base side and some do not.
 *
 * `buildHeadOnlyNote` is gated on EVERY row lacking a base, so before this a
 * mixed report rendered ❔ rows with nothing above them explaining why — and the
 * legend's gloss points the reader at "the heading and notes above", which named
 * a movement in a different benchmark. Rare (it needs a partially-populated
 * artifact) but the reader has no way to interpret the row without it.
 */
function buildPartialBaseNote(rows) {
  const missing = rows.filter((r) => r.base === null);
  if (missing.length === 0 || missing.length === rows.length) return null;
  const names = missing
    .slice(0, 3)
    .map((r) => codeSpan(r.name))
    .join(", ");
  const rest = missing.length > 3 ? `, +${missing.length - 3} more` : "";
  return [
    `> **${missing.length} of ${rows.length} benchmarks have no base measurement.** ${names}${rest} ran on head only,`,
    "> so ❔ on those rows means there was nothing to compare against — not that the repetitions",
    "> disagreed. The other rows are compared normally.",
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
    // Deliberately silent on which way it will move. The laptop has interactive
    // background load the runner does not; the runner has virtualisation, cold
    // caches and neighbours the laptop does not. Telling the reader the real
    // floor is "likely tighter" invited them to trust a movement just under the
    // threshold, on a guess with no measurement behind it.
    `> so the floor on this runner is unknown in both magnitude and direction. Movements are therefore`,
    `> reported as measurements rather than verdicts, however large: with the error in the floor unknown`,
    `> in direction, no movement is provably clear of it. Calibrate the runner and they become rulings.`,
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
    THRESHOLD_PROVISIONAL
      ? "#### Moved beyond a provisional noise floor"
      : "#### Moved beyond the noise floor",
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
    // Indented, like every other line in this block. The name is the one fork-
    // controlled string here and it was the only one at column 0, so a name of
    // `::error::…` made the renderer write a line that looks exactly like a
    // workflow command on stdout. The trusted workflow redirects stdout to a
    // file, so the runner never honoured it — but that is the caller's habit
    // protecting the callee, and it costs one space to not depend on it.
    lines.push(`  ${row.name}`);
    for (const side of ["base", "head"]) {
      const data = row[side];
      const label = side.padEnd(4);
      if (data === null) {
        lines.push(`  ${label} (not measured)`);
        continue;
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
  // On a head-only run there is no base side, so every sentence about the two
  // being interleaved, alternated and built in one job describes something that
  // did not happen. Saying it anyway next to the "no base measurements" banner
  // makes the comment contradict itself.
  const compared = rows.some((r) => r.base !== null);
  const parts = [
    "<details>",
    "<summary><b>Methodology and raw samples</b></summary>",
    // Same blank-line trap as above.
    "",
    `- The timed interval is the \`proveTransaction\` call on a client constructed without a web worker. Prover construction, transaction execution, the faucet draw and the production worker round-trip are outside it, so a change confined to any of those does not move this number.`,
    `- Each benchmark keeps **${results.reps} ${plural(results.reps, "rep")} × ${results.provesPerRep} warm ${plural(results.provesPerRep, "prove")}** on \`${results.runner}\` (${results.threads} ${plural(results.threads, "thread")}, \`${results.profile}\` / \`${results.variant}\`). One extra repetition and the first prove of every page run first and are discarded.`,
    // With one retained prove per repetition there is no minimum to take, so
    // the interference-filtering half of the rationale describes something that
    // did not happen: the figure is a plain mean of single contaminated draws.
    results.provesPerRep >= 2
      ? `- The reported figure is the **mean of each repetition's fastest prove**. Within one repetition every prove is bit-identical work, so interference — which only ever adds time — is all that varies, and the repetition's fastest prove is its best observed warm prove — a lower-tail statistic, not a measured "clean" cost, and so blind to a regression that leaves the best case alone (see the mean cross-check). Across repetitions the faucet differs, which shifts the proof-of-work grind, so averaging the per-repetition minima shrinks that lottery — it averages the grind down rather than cancelling it, because each side draws its own.`
      : `- The reported figure is the **mean of the single retained prove per repetition**. With only one prove kept per repetition there is no minimum to take, so nothing filters interference out of each sample — every draw carries whatever the machine was doing at the time. Treat this run as thinner than the estimator this suite is built around.`,
    // The 1.79% figure was measured at 6 reps × 3 warm proves. It is a property
    // of the estimator AT THAT SAMPLE SIZE, and `reps` / `provesPerRep` are
    // artifact-authored — so a thinner run must not inherit the claim.
    // Equality, not `>=`. The spread narrows as 1/sqrt(reps), so a 24-rep run
    // does not merely satisfy the claim, it invalidates the arithmetic behind
    // it: the true spread is nearer 0.90% and the fixed 5.40% cutoff is no
    // longer the 3σ the provisional note calls it.
    results.reps === CALIBRATED_REPS &&
    results.provesPerRep === CALIBRATED_PROVES_PER_REP
      ? `- Measured over six calibration runs of identical binaries, this estimator holds a standard deviation of 1.79%, against 2.96% for a global minimum and 5.39% for a plain median.`
      : // Saying the spread is unknown and then gating on ±5.4% — which IS that
        // spread, tripled — reads as a contradiction unless the comment says
        // which of the two it is doing. It keeps applying the cutoff, because a
        // fixed magnitude gate is still better than calling every movement
        // significant; it just cannot claim a confidence level behind it.
        `- This run does not use the ${CALIBRATED_REPS} × ${CALIBRATED_PROVES_PER_REP} the estimator's 1.79% standard deviation was measured at, so that figure does not apply here and the spread of these numbers is unknown. Above those counts the ±${formatPct(THRESHOLD_PCT)} cutoff is still applied and is conservative, since a longer run's estimator is tighter; below either of them no verdict is published at all.`,
    ...(compared
      ? [
          `- A movement is only called significant when it clears the noise floor **and** no repetition's paired difference contradicts the direction, with a majority of repetitions positively agreeing. Base and head run interleaved within a repetition, so the pairs saw the same machine; a movement whose repetitions disagree is reported as unresolved rather than as a result. Runs shorter than ${MIN_REPS_FOR_SIGN_TEST} repetitions are never called significant — the floor is calibrated at that count and does not transfer below it.`,
          `- Base and head are driven **one prove at a time, alternating**, with the order flipped every prove. Running each side's batch back to back let the second side pay a consistent penalty — measured at +1.19% before this was fixed, which is a bias no number of repetitions removes.`,
          `- A wide gap between the reported figure and the max has two causes and the samples below do not separate them: interference within a repetition, and the proof-of-work grind differing between repetitions. Neither invalidates the comparison — both sides ran interleaved on the same machine — but a gap much wider than usual is worth a second look.`,
          `- Base and head are **measured** in the same job on the same runner, so runner-to-runner drift cancels out. The base dist may have been *built* by an earlier run of this workflow and restored from cache — the cache key covers the toolchain and the build commands, so the bytes match what this run would have produced.`,
          `- Δ % = (head − base) / base on that figure. Lower is better for every benchmark in this suite.`,
        ]
      : [
          `- A wide gap between the reported figure and the max reflects both interference within a repetition and the grind differing between repetitions. With no base side there is nothing to compare against, so treat these timings as a record of the run rather than as a result.`,
        ]),
    `- Every figure above is recomputed here from the per-rep samples in the artifact; the summary statistics the bench script reported alongside them are not used.`,
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
  // ❔ is reachable four ways — repetitions that disagree, too few repetitions to
  // test, no base side, and a base figure of zero — so the gloss has to point at
  // the note rather than name one of them. Naming only "the repetitions
  // disagree" made the legend contradict the heading directly above it on three
  // of the four.
  return (
    `<sub>${EMOJI_WORSE} slower beyond the noise floor · ${EMOJI_BETTER} faster beyond the noise floor · ` +
    `${EMOJI_UNRESOLVED} no verdict — see the heading and notes above · ${EMOJI_NOISE} within the noise floor</sub>`
  );
}

/**
 * Rendered only when the headline estimator's blind spot was actually hit, for
 * the same reason as the unresolved note: an explanation of a state the comment
 * is not in is noise.
 */
function buildMeanOnlyNote(rows) {
  // Ordered by the size of the MEAN movement. `rows` is sorted by headline
  // magnitude, and every flagged row is below the floor on that, so taking
  // rows[0] would headline the flagged row with the least to say.
  const flagged = rows
    .filter((r) => r.meanOnly)
    .sort((a, b) => Math.abs(b.meanPct) - Math.abs(a.meanPct));
  if (flagged.length === 0) return "";
  const leader = flagged[0];
  // The note triggers on magnitude in either direction, so the explanation has
  // to follow the sign. A change that made the SLOW proves faster is the mirror
  // image of the case below, and describing it as an invisible slowdown would be
  // exactly wrong.
  const slower = LOWER_IS_BETTER ? leader.meanPct > 0 : leader.meanPct < 0;
  const explanation = slower
    ? [
        `> The reported figure takes a minimum per repetition, so a slowdown that misses the fastest prove of`,
        `> each repetition is invisible to it: think a collection pause, a lock, a retry, or a cold cache.`,
      ]
    : [
        `> The reported figure takes a minimum per repetition, so an improvement that only helps the SLOWER`,
        `> proves is invisible to it — the fastest prove was already on the fast path.`,
      ];
  return [
    `> **${flagged.length} ${plural(flagged.length, "benchmark")} moved on the mean but not on the reported figure.**`,
    `> ${codeSpan(leader.name)} is ${formatSignedPct(leader.deltaPct)} on the mean of each repetition's *fastest* prove —`,
    `> within the floor — but ${formatSignedPct(leader.meanPct)} on the mean of *every* prove, in the same direction in`,
    `> ${leader.meanAgreement.agree} of ${leader.meanAgreement.reps} repetitions.`,
    ...explanation,
    `> The spread of a mean over all proves has never been calibrated on this workload, so this is not a`,
    `> verdict: the ±${formatPct(THRESHOLD_PCT)} it had to clear is 3σ of the *reported* figure, applied here only as a`,
    `> "large enough to mention" filter, and the agreement across repetitions above is what makes it worth`,
    `> mentioning. Read the raw samples below before concluding nothing changed.`,
  ].join("\n");
}

/**
 * Only rendered when something actually came out unresolved, so the common case
 * does not carry an explanation of a state it is not in.
 */
function buildUnresolvedNote(rows, stoppedEarly = false) {
  const unresolved = rows.filter((r) => r.unresolved);
  if (unresolved.length === 0) return "";
  const leader = unresolved[0];
  if (leader.agreement.blocked === "stoppedEarly") {
    return [
      `> **${unresolved.length} ${plural(unresolved.length, "benchmark")} unresolved: this run stopped on the clock.** The movements below`,
      `> are real measurements and are worth reading, but this run does not rule on their direction.`,
      `> A run that stops early has its length chosen by how slow the machine was, and how slow the`,
      `> machine was is what the benchmark measures — so the repetitions that survived are a selected`,
      `> sample. That selection cancels out of the paired comparison only if both builds have the same`,
      `> run-to-run variance; if one is more variable, it shifts the result by roughly the width of the`,
      `> noise floor, in whichever direction the difference points. Nothing has measured that on this`,
      `> workload and the floor was calibrated on complete runs, so the verdict is withheld rather than`,
      `> qualified. Raise the benchmark step's \`timeout-minutes\` and \`--budget-minutes\` together, or`,
      `> lower \`--proves\`, and the re-run will rule.`,
    ].join("\n");
  }
  if (leader.agreement.blocked === "tooFewProves") {
    return [
      `> **${unresolved.length} ${plural(unresolved.length, "benchmark")} unresolved: too few proves per repetition.** The \u00b1${formatPct(THRESHOLD_PCT)}`,
      `> floor is three standard deviations of an estimator measured over the fastest of ${CALIBRATED_PROVES_PER_REP} warm proves.`,
      `> The minimum of fewer proves is a noisier number, so against it that floor is less than three`,
      `> standard deviations and would call movements significant more often than the rate it advertises.`,
      `> The movements below are reported without a ruling. Re-run with at least ${CALIBRATED_PROVES_PER_REP + 1} \`--proves\`.`,
    ].join("\n");
  }
  if (leader.agreement.blocked === "oddReps") {
    return [
      `> **${unresolved.length} ${plural(unresolved.length, "benchmark")} unresolved: this run has an odd repetition count.** The setup`,
      `> order alternates by repetition, so an odd number of them sets one build up first once more than`,
      `> the other. That is a fixed positional difference rather than noise, and more repetitions do not`,
      `> average it away — so the movements below are reported without a ruling on their direction.`,
      `> Re-run with an even \`--reps\`; the producer refuses an odd one, so this artifact came from an`,
      `> older build of it.`,
    ].join("\n");
  }
  if (leader.agreement.tooShort) {
    return [
      `> **${unresolved.length} ${plural(unresolved.length, "benchmark")} unresolved.** The aggregate movement clears the noise floor, but this run`,
      `> has only ${leader.agreement.reps} ${plural(leader.agreement.reps, "repetition")}, and a verdict needs at least ${MIN_REPS_FOR_SIGN_TEST}`,
      `> — the count the noise floor was calibrated at. Below it both halves of the rule weaken at once: the`,
      `> direction test's false-positive rate is 1/2^(reps-1), which at one repetition is certainty, and the`,
      `> fixed ±${formatPct(THRESHOLD_PCT)} floor is less than 3σ of a shorter run's own spread.`,
      // The advice has to match WHY the run is short. A truncated run already
      // used the default repetition count and lost repetitions to the clock, so
      // telling its author to re-run with the default is both wrong and
      // circular — more repetitions would miss the budget by more.
      stoppedEarly
        ? `> This run ran out of its time budget rather than being configured short: raise the benchmark step's \`timeout-minutes\` and \`--budget-minutes\` together, or lower \`--proves\`.`
        : `> Re-run with the default \`--reps\` to get a verdict.`,
    ].join("\n");
  }
  return [
    `> **${unresolved.length} ${plural(unresolved.length, "benchmark")} unresolved.** The aggregate movement clears the noise floor, but the`,
    `> per-repetition pairs do not agree on its direction — ${codeSpan(leader.name)} agrees in only`,
    `> ${leader.agreement.agree} of ${leader.agreement.reps} ${plural(leader.agreement.reps, "repetition")}. That is a spread too wide to call, not a result. Re-run, or`,
    // NOT "raise --reps". The unanimity requirement is Φ(δ/s) raised to the
    // power of `reps`, so more repetitions make this very verdict MORE likely
    // for any fixed effect — the advice would have driven a real regression
    // toward a permanent ❔. `--proves` is the lever that helps: more proves per
    // repetition lowers the variance of that repetition's minimum, which shrinks
    // s and widens the agreement.
    `> raise \`--proves\` to sharpen each repetition's measurement.`,
  ].join("\n");
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
  // First after the verdict, before the calibration and comparison notes: if the
  // run leaked resources, that qualifies everything below it.
  const teardownNote = buildTeardownNote(results.teardownFailures);
  if (teardownNote) blocks.push(teardownNote);
  // Directly after: it qualifies the repetition count every note below quotes.
  const stoppedEarlyNote = buildStoppedEarlyNote(results);
  if (stoppedEarlyNote) blocks.push(stoppedEarlyNote);
  if (ctx.calibration) blocks.push(buildCalibrationNote(ctx));
  if (rows.length > 0 && rows.every((r) => r.base === null))
    blocks.push(buildHeadOnlyNote());
  const partialBaseNote = buildPartialBaseNote(rows);
  if (partialBaseNote) blocks.push(partialBaseNote);
  const unresolvedNote = buildUnresolvedNote(rows, results.stoppedEarly);
  if (unresolvedNote) blocks.push(unresolvedNote);
  const meanOnlyNote = buildMeanOnlyNote(rows);
  if (meanOnlyNote) blocks.push(meanOnlyNote);
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
  }
  // No `else` announcing the dropped table: the attempt that drops it supplies
  // TRUNCATION_NOTICES.table, which is already in `notices` and says the same
  // thing. Announcing it here too printed two scissor lines about one cut.

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

/**
 * Exit codes, which the calling workflow branches on:
 *   0  rendered
 *   2  bad usage
 *   3  this script or its environment broke (our problem, be loud)
 *   64 the artifact was refused (the fork's problem, stay quiet)
 *
 * 64 and not 1 for the refusal, because 1 is what node itself exits with on an
 * uncaught exception — including one thrown while merely LOADING this module, a
 * syntax error or a bad import, which never reaches `main()`. Sharing the code
 * meant a first-party breakage was indistinguishable from a hostile artifact,
 * and the workflow's quiet-refusal branch swallowed it. 64 is outside every code
 * node assigns itself (1, 3–9, 12, 13), so the two cannot be confused, and the
 * workflow can treat "anything nonzero that is not 64" as ours and be loud.
 */
const EXIT_REJECTED = 64;
const EXIT_INTERNAL_ERROR = 3;

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

  // Read in two steps, because the two files have different owners and a
  // failure on each means something different. results.json is fork-authored, so
  // malformed bytes there are the ordinary hostile case. ctx.json is written by
  // the reporter's own `jq` from trusted event fields, so ANY failure on it —
  // malformed, missing, unreadable — is first-party and belongs on exit 3.
  let results;
  try {
    results = JSON.parse(await readFile(resultsPath, "utf8"));
  } catch (error) {
    // `logLine`, not the raw message: V8's parse error quotes the offending
    // bytes verbatim, and those bytes are fork-controlled. Unsanitized, a
    // crafted results.json starts a log line in this write-token job with a
    // real `::error::` / `::add-mask::` workflow command.
    const ours = !(error instanceof SyntaxError);
    process.stderr.write(
      `failed to read the benchmark results: ${logLine(error.message)}${ours ? " (not an artifact problem)" : ""}\n`
    );
    return ours ? EXIT_INTERNAL_ERROR : EXIT_REJECTED;
  }

  let ctx;
  try {
    ctx = JSON.parse(await readFile(ctxPath, "utf8"));
  } catch (error) {
    process.stderr.write(
      `failed to read the rendering context, which this side builds itself — not an artifact problem: ${logLine(error.message)}\n`
    );
    return EXIT_INTERNAL_ERROR;
  }

  try {
    const body = summaryMode
      ? renderSummary(results, ctx)
      : renderComment(results, ctx);
    process.stdout.write(`${body}\n`);
  } catch (error) {
    // Refusing loudly is the point: a wrong comment is worse than none. But
    // "loudly" has to distinguish the two reasons a render can fail, because
    // only one of them is the PR author's problem and only one of them should
    // page whoever owns this workflow.
    if (error?.rejectedArtifact) {
      process.stderr.write(`refusing to render: ${logLine(error.message)}\n`);
      return EXIT_REJECTED;
    }
    // Message and frames separately, each sanitized. Through one `logLine` the
    // whole stack shared a 200-char budget, so a long message consumed it and
    // left no source location at all — on the one path where the stack IS the
    // diagnostic. The frames are first-party paths, so a wider cap is safe;
    // sanitizing each still denies a fork-derived message the start of a line.
    process.stderr.write(
      `renderer bug — this is not the artifact's fault: ${logLine(error?.message ?? String(error))}\n`
    );
    for (const frame of String(error?.stack ?? "")
      .split("\n")
      .slice(1, 9)) {
      process.stderr.write(`  ${logLine(frame.trim())}\n`);
    }
    return EXIT_INTERNAL_ERROR;
  }
  return 0;
}

// Both sides resolved through realpath before comparing. Node derives
// `import.meta.url` from the RESOLVED path while `process.argv[1]` keeps whatever
// the caller typed, so any symlink along the way made these two differ and the
// script did nothing at all — exiting 0 without rendering, which the workflow
// reads as "ran fine, nothing to post" rather than as a failure. The CI path is
// not symlinked, so this never fired there, but a silent success is the worst
// possible shape for that mistake to take.
const invokedPath = process.argv[1];
let invokedAsScript = false;
if (invokedPath) {
  try {
    // Inside the try, not above it. `fileURLToPath` throws
    // ERR_INVALID_URL_SCHEME for any non-`file:` module URL, which is the one way
    // this block could raise at module scope — the very thing the try exists to
    // prevent. Not reachable while the module is only ever loaded from disk, but
    // the guard should not be the thing that breaks an otherwise working import.
    const thisFile = fileURLToPath(import.meta.url);
    invokedAsScript = realpathSync(invokedPath) === realpathSync(thisFile);
  } catch {
    // Unreadable or already-deleted path: fall back to the literal comparison
    // rather than deciding not to run.
    invokedAsScript = pathToFileURL(invokedPath).href === import.meta.url;
  }
}

if (invokedAsScript) {
  process.exitCode = await main();
}
