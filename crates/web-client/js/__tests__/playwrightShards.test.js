import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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

// Playwright discovers recursively under `testDir`, so a flat listing would
// report a file in `test/<subdir>/` as absent rather than unsharded.
function integrationTestFiles(dir = testDir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return integrationTestFiles(
        path.join(dir, entry.name),
        `${prefix}${entry.name}/`
      );
    }
    return entry.name.endsWith(".test.ts") ? [`${prefix}${entry.name}`] : [];
  });
}

// Read the config through the TypeScript parser rather than by regex over its
// text. Two hazards make the textual version wrong, and the second one bit:
// a commented-out shard entry still reads as a quoted path, so a file
// playwright has stopped running would still count as sharded; and stripping
// comments textually first breaks on `"test/*.node.test.ts"` in
// `browserTestIgnore`, whose `/*` opens a comment that swallows the rest of the
// file. Comments are not AST nodes and string literals are, so the parser gets
// both right by construction.
function shardedFiles() {
  const source = ts.createSourceFile(
    configPath,
    fs.readFileSync(configPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let shardBlock = null;
  const findShardBlock = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "ciShardProjects"
    ) {
      shardBlock = node;
      return;
    }
    ts.forEachChild(node, findShardBlock);
  };
  findShardBlock(source);
  expect(shardBlock, "ciShardProjects declaration not found").not.toBeNull();

  // Only `testMatch` array entries name a sharded file; `testIgnore` in the
  // same objects must not be collected.
  const files = [];
  const collect = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "testMatch" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        // Fail rather than skip: a spread or identifier means the real shard
        // membership is not what this scan sees, so a file could be listed
        // twice — or not at all — with the guard still green.
        expect(
          ts.isStringLiteral(element),
          `a testMatch entry in ciShardProjects is not a string literal (${element.getText(source)}); this guard reads the shards statically`
        ).toBe(true);
        const match = /^test\/(.+\.test\.ts)$/.exec(element.text);
        if (match) files.push(match[1]);
      }
      return;
    }
    ts.forEachChild(node, collect);
  };
  collect(shardBlock);
  return files;
}

describe("playwright CI shard coverage", () => {
  it("assigns every integration test file to a shard or documents the exclusion", () => {
    const onDisk = integrationTestFiles();
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
    const onDisk = new Set(integrationTestFiles());
    const missing = shardedFiles().filter((f) => !onDisk.has(f));
    expect(
      missing,
      "a shard entry with no matching file silently contributes nothing"
    ).toEqual([]);
  });

  it("does not exclude a file that no longer exists", () => {
    const onDisk = new Set(integrationTestFiles());
    const stale = Object.keys(EXCLUDED).filter((f) => !onDisk.has(f));
    expect(stale, "stale EXCLUDED entries hide real gaps").toEqual([]);
  });
});
