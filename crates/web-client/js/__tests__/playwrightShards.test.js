import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The chromium CI matrix runs ONLY the four `ci-shard-*` projects
// (.github/workflows/test.yml passes `--project=ci-shard-N`), so the catch-all
// `chromium` project never runs there. A test file that is in none of the four
// `testMatch` arrays is therefore silently skipped in CI — it reports neither
// pass nor fail, and a reviewer reading a green run cannot tell it did not run.
//
// This test pins the shard membership so that gap has to be a deliberate,
// reviewed choice rather than an oversight. Adding a new integration test means
// adding it to a shard or to EXCLUDED below with a reason.

const webClientDir = path.resolve(import.meta.dirname, "../..");
const configPath = path.join(webClientDir, "playwright.config.ts");
const testDir = path.join(webClientDir, "test");

// Files intentionally outside the chromium shard matrix, each with the reason.
// Shrinking this list is an improvement; growing it needs a justification.
const EXCLUDED = {
  // napi-specific variants, covered by the `nodejs` project. The shared
  // `browserTestIgnore` keeps them out of every browser project.
  "compile_and_contract.node.test.ts": "napi variant, runs in `nodejs`",
  "miden_client_api.node.test.ts": "napi variant, runs in `nodejs`",
  "note_transport.node.test.ts": "napi variant, runs in `nodejs`",

  // Require a live prover / node, which CLAUDE.md keeps out of CI.
  "remote_prover_transactions.test.ts": "needs TEST_MIDEN_PROVER_URL",
  "prover_only_client.test.ts": "needs a remote prover endpoint",

  // Run in the `nodejs` project only.
  "network_note.test.ts": "runs in `nodejs`",
  "storage_view.test.ts": "runs in `nodejs`",
  "worker_init_failure.test.ts":
    "browser-worker failure injection, run locally",

  // KNOWN GAP: the `nodejs` project ignores each of these by name (or by the
  // `test/*.browser.test.ts` glob) and no chromium shard lists them, so they
  // run in no CI project at all. They are recorded rather than added to a
  // shard because none of them has ever run in CI: enabling them could surface
  // pre-existing failures, and verifying them first needs a local node, which
  // is outside what a review pass can check.
  "account.browser.test.ts": "KNOWN GAP — runs in no CI project",
  "batch.browser.test.ts": "KNOWN GAP — runs in no CI project",
  "new_account.browser.test.ts": "KNOWN GAP — runs in no CI project",
  "new_transactions.browser.test.ts": "KNOWN GAP — runs in no CI project",
  "no_wasm_reentry_via_tojson.test.ts": "KNOWN GAP — runs in no CI project",
};

function shardedFiles() {
  const config = fs.readFileSync(configPath, "utf8");
  // Only the `ciShardProjects` block declares per-shard testMatch arrays.
  const start = config.indexOf("const ciShardProjects");
  expect(start, "ciShardProjects block not found").toBeGreaterThan(-1);
  const block = config.slice(start, config.indexOf("export default"));
  // The class includes `-`: a hyphenated filename would otherwise not match and
  // would be reported as unsharded even when it is listed.
  return [...block.matchAll(/"test\/([A-Za-z0-9_.-]+\.test\.ts)"/g)].map(
    (m) => m[1]
  );
}

describe("playwright CI shard coverage", () => {
  it("assigns every integration test file to a shard or documents the exclusion", () => {
    const onDisk = fs
      .readdirSync(testDir)
      .filter((f) => f.endsWith(".test.ts"));
    const sharded = new Set(shardedFiles());

    const unaccounted = onDisk.filter(
      (f) => !sharded.has(f) && !(f in EXCLUDED)
    );
    expect(
      unaccounted,
      "these test files run in no chromium CI shard; add them to a shard in " +
        "playwright.config.ts, or to EXCLUDED in this test with a reason"
    ).toEqual([]);
  });

  it("lists no file in more than one shard", () => {
    const sharded = shardedFiles();
    const duplicates = sharded.filter((f, i) => sharded.indexOf(f) !== i);
    expect(
      duplicates,
      "a file listed in two shards runs twice, wasting matrix time"
    ).toEqual([]);
  });

  it("lists no shard entry that does not exist on disk", () => {
    const onDisk = new Set(
      fs.readdirSync(testDir).filter((f) => f.endsWith(".test.ts"))
    );
    const missing = shardedFiles().filter((f) => !onDisk.has(f));
    expect(
      missing,
      "a shard entry with no matching file silently contributes nothing"
    ).toEqual([]);
  });

  it("does not exclude a file that no longer exists", () => {
    const onDisk = new Set(
      fs.readdirSync(testDir).filter((f) => f.endsWith(".test.ts"))
    );
    const stale = Object.keys(EXCLUDED).filter((f) => !onDisk.has(f));
    expect(stale, "stale EXCLUDED entries hide real gaps").toEqual([]);
  });
});
