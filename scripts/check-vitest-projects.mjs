#!/usr/bin/env node
// The root vitest config lists its projects by hand, and `vitest run` reports
// nothing at all for a package it was never told about: the aggregate exits 0
// having executed zero of that package's tests. `packages/create` sat in that
// state with 46 passing-in-isolation tests that no job ever ran.
//
// So: every vitest config in the tree must be either listed in the root
// `projects` array or named below with the job that runs it instead.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Configs deliberately outside the aggregate, each with the gate that covers it.
const COVERED_ELSEWHERE = new Map([
  [
    "crates/idxdb-store/src/vitest.config.ts",
    "make test-idxdb-store (test.yml: test-idxdb-store)",
  ],
]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "target",
  "coverage",
  "docs",
]);

function findConfigs(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findConfigs(full, found);
    else if (/^vitest\.config\.(ts|js|mts|mjs)$/.test(entry))
      found.push(relative(root, full));
  }
  return found;
}

const rootConfig = "vitest.config.ts";
const source = readFileSync(join(root, rootConfig), "utf8");
const projectsBlock = source.match(/projects:\s*\[([\s\S]*?)\]/);
if (!projectsBlock) {
  console.error(
    `check-vitest-projects: no \`projects\` array found in ${rootConfig}`
  );
  process.exit(1);
}
const listed = [...projectsBlock[1].matchAll(/["']([^"']+)["']/g)].map((m) =>
  m[1].replace(/^\.\//, "")
);

const discovered = findConfigs(root).filter((p) => p !== rootConfig);
const errors = [];

for (const config of discovered) {
  if (listed.includes(config)) continue;
  if (COVERED_ELSEWHERE.has(config)) continue;
  errors.push(
    `${config} is run by nothing: add "./${config}" to \`projects\` in ${rootConfig}, ` +
      `or add it to COVERED_ELSEWHERE in this script naming the job that runs it.`
  );
}

for (const config of listed) {
  if (!existsSync(join(root, config))) {
    errors.push(`${rootConfig} lists "./${config}", which does not exist.`);
  }
}

if (errors.length > 0) {
  console.error("check-vitest-projects: FAILED\n");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `check-vitest-projects: ok - ${listed.length} project(s) aggregated, ` +
    `${COVERED_ELSEWHERE.size} covered by a dedicated job`
);
