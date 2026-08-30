/**
 * bench-profile.mjs — the calibration profile the benchmark renderer judges against.
 *
 * WHAT THIS FILE IS FOR
 * --------------------
 * Everything here is a MEASUREMENT of a particular runner running a particular
 * workload, plus the counts that measurement was taken at. It is data, not
 * policy: the rules that consume it live in render-bench-comment.mjs and do not
 * change when the numbers do. That split is the point — it used to be an edit to
 * the renderer plus a hand-swap of the assertions in its test suite, because the
 * numbers were compile-time constants and only one of the two states could be
 * reached from a test at a time.
 *
 * WHAT IS AND IS NOT A ONE-FILE EDIT — measured, not asserted
 * ----------------------------------------------------------
 * The fields divide in two, and the difference is not cosmetic: one half
 * describes a MEASUREMENT, the other half describes the RUN SHAPE that
 * measurement was taken at, and the run shape is configured in three places
 * because three programs have to agree on it.
 *
 *   `thresholdPct`, `thresholdProvisional`, `calibration`, `estimatorSpread`
 *     — re-calibrating is an edit to THIS FILE AND NOTHING ELSE. Measured, not
 *     asserted: each of the four was mutated in turn and the renderer's suite
 *     stayed fully green, including a whole realistic re-calibration of this
 *     branch at once (floor 8.2%, flag flipped to calibrated, Poseidon2 at
 *     QUERY_POW_BITS 17, every `calibration` and `estimatorSpread` figure
 *     replaced). Every assertion that depends on any of them derives it from the
 *     profile rather than restating it.
 *
 *     `thresholdPct` holds over 1.7% – 10.0%, swept in a consistent profile.
 *     Outside that band the suite's own FIXTURES break, not the renderer: they
 *     move a benchmark by about 1% to stand for noise and by 10–20% to stand for
 *     a movement, so a floor under the first or over the second reclassifies
 *     them. No floor this workload could produce is near either edge — the
 *     measured sd is 1.45% and 3σ is 4.34% — but a re-calibration that lands
 *     outside it is a signal to look at the runner, and the failures will say so
 *     plainly rather than passing quietly.
 *
 *   `calibratedReps`, `calibratedProvesPerRep`
 *     — NOT a one-file edit, and cannot be made into one. These are the counts
 *     the benchmark is RUN at, so the producer and the workflow have to change
 *     with them or the artifact stops matching the profile and every run is
 *     blocked as uncalibrated: `BENCH_REPS` / `BENCH_PROVES` in
 *     .github/workflows/bench.yml (bench.yml's `proves` counts ISSUED proves, so
 *     it is `calibratedProvesPerRep + 1` — the first of each page is discarded)
 *     and `CALIBRATED_PROVES` in crates/web-client/scripts/bench-proving.mjs.
 *     The renderer's test fixtures are a fourth: ~25 of them write out per-prove
 *     and per-repetition sample values chosen so a specific delta comes out, and
 *     assert that delta as a literal. Deriving those from these counts would
 *     replace each literal with the renderer's own estimator arithmetic, which
 *     stops the assertion being an independent check. So they stay literal and
 *     the change stays a four-file one. See docs/benchmarks/calibration.md.
 *
 * TRUST MODEL — READ BEFORE MOVING ANYTHING
 * -----------------------------------------
 * This profile DECIDES THE VERDICT, and the renderer's other input — the
 * benchmark artifact — is authored by a fork. So the profile must reach the
 * renderer from here and from nowhere else: not from the artifact, not from
 * argv, not from the environment, not from a file path someone can point at.
 * The renderer takes it as a parameter so that TESTS can supply one; the CLI
 * entry point (`main`) deliberately has no way to. See the guards in
 * `normalizeResults` and `main` in render-bench-comment.mjs, and the tests named
 * "ignores artifact fields that would author the verdict" and "the artifact
 * cannot supply a profile".
 *
 * Frozen, one level down as well, so a bug elsewhere in the renderer cannot
 * mutate the numbers a later benchmark in the same run is judged against.
 *
 * No external dependencies. Node 20+, ESM.
 */

/**
 * The default profile: what THIS branch's runs are judged against.
 *
 * Every field is required. The renderer validates the shape rather than filling
 * gaps in — a profile missing a field is a mistake in this file or in a test,
 * and silently substituting a number the operator did not write is exactly the
 * failure mode the whole trust model is built to avoid.
 */
export const DEFAULT_PROFILE = Object.freeze({
  /**
   * Noise floor, in percent: a movement smaller than this is reported as noise.
   *
   * This lives on the TRUSTED side and is deliberately NOT read from the
   * artifact. It decides the verdict, and the artifact is fork-controlled — a
   * `thresholdPct: 1e9` would silence any regression, and a
   * `thresholdProvisional: false` would make the comment assert that a
   * fork-invented number is this runner's calibrated variance.
   *
   * CALIBRATED on warp-ubuntu-latest-x64-8x, 2026-08-27: 30 runs of one build
   * against a copy of itself at reps=6, so every reported delta is pure noise.
   * mean +0.213% (SE 0.264% — no detectable residual bias), sd 1.447%,
   * 3σ = 4.34%, largest observed |delta| = 5.03%.
   *
   * 5.4%, NOT the 4.34% that 3σ prescribes. 3σ assumes the deltas are normal and
   * these are not: one of the thirty landed at +5.03%, past 3σ, on a run where
   * nothing changed. That is the grind lottery's tail — each side draws its own
   * proof-of-work grind, which is geometric, not Gaussian. A threshold at 4.34%
   * would have called that run a regression, so the floor is taken from the
   * empirical maximum with a small margin instead. Following the procedure into a
   * false positive we had already observed would be worse than deviating from it.
   *
   * Re-calibrate when the runner class, thread count, repetition count or the
   * workload changes; each invalidates this. See docs/benchmarks/calibration.md.
   */
  thresholdPct: 5.4,
  thresholdProvisional: false,

  /**
   * What the calibration actually measured, kept beside the threshold so the
   * comment's prose cannot drift from the number it is describing. The previous
   * wording asserted the threshold "is three times the calibrated standard
   * deviation", which stopped being true the moment the floor was set above the
   * empirical maximum instead.
   *
   * Required even while `thresholdProvisional` is true, though nothing renders
   * it then. A record that is only validated in the state that reads it is a
   * record that goes stale unnoticed, and the flip to `false` is precisely the
   * moment nobody wants to discover it — the calibrated wording quotes every
   * field of this by name.
   *
   * NOT `ctx.calibration`, which is a boolean from the triggering workflow
   * meaning "this run benched a build against a copy of itself". This is the
   * record of the calibration that SET the floor.
   */
  calibration: Object.freeze({
    runs: 30,
    reps: 6,
    runner: "warp-ubuntu-latest-x64-8x",
    date: "2026-08-27",
    sdPct: 1.45,
    threeSigmaPct: 4.34,
    maxObservedPct: 5.03,
    // The two workload parameters the floor is most sensitive to, recorded so a
    // port to another line cannot silently inherit a floor measured elsewhere.
    // The dominant residual noise is the proof-of-work grind, so a different
    // QUERY_POW_BITS is a different noise distribution, not a scaled one.
    hashFn: "Blake3_256",
    queryPowBits: 16,
  }),

  /**
   * The configuration the 1.79% estimator spread was measured at.
   *
   * `reps` and `provesPerRep` come from the artifact, so a run that reports one
   * repetition of one prove must not inherit a standard deviation measured over
   * six of three. Below EITHER count no verdict is published — see
   * `verdictPreconditions` and `minRepsForSignTest` in render-bench-comment.mjs
   * — because the fixed threshold is 3σ of this estimator at these counts and is
   * less than that for any shorter run, on either axis. Above them the comment
   * notes that the measured spread does not apply while still gating on the
   * threshold, which is the conservative direction.
   */
  calibratedReps: 6,
  calibratedProvesPerRep: 3,

  /**
   * The estimator study: how much each candidate statistic scattered when the
   * same binary was benched against itself.
   *
   * A SIBLING of `calibration`, not a member of it, and the distinction is the
   * whole reason this record exists. `calibration` is the run that SET THE
   * FLOOR — 30 runs on the CI runner. This is a different session on a different
   * machine (a busy developer laptop) that decided WHICH STATISTIC to report,
   * and it holds its own run count. Nested inside `calibration` its `runs: 6`
   * would sit next to that record's `runs: 30` and read as a contradiction,
   * which is the exact failure this field was extracted to end.
   *
   * These four numbers were string literals in the renderer's methodology
   * section while the bullet printing them was already gated on `calibratedReps`
   * and `calibratedProvesPerRep`. A re-calibrated profile therefore printed this
   * standard deviation and `calibration.sdPct` in the same comment, as two
   * different answers to "what is the spread of this estimator", with nothing
   * saying they came from different sessions. They are calibration facts, so
   * they live with the calibration facts and the renderer reads them from here.
   *
   * Re-measure alongside the floor. docs/benchmarks/calibration.md's runbook
   * replaces these with figures from the real runner; until it does, they are
   * the reason the estimator is shaped this way rather than a calibration of it.
   */
  estimatorSpread: Object.freeze({
    // How many same-binary runs the three standard deviations below were taken
    // over. Rendered as a word, so keep it small enough to spell (the renderer
    // falls back to digits above twelve).
    runs: 6,
    // The reported estimator: the mean of each repetition's fastest prove.
    sdPct: 1.79,
    // The two it was chosen over, kept so the comment can show the comparison
    // rather than assert the conclusion.
    globalMinSdPct: 2.96,
    medianSdPct: 5.39,
  }),
});
