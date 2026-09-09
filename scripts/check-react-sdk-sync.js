#!/usr/bin/env node
"use strict";

// Version-sync gate for every package that pins `@miden-sdk/miden-sdk`.
//
// The name is historical — this started as a react-sdk-only check and is
// referenced by that name from CI, the root README and the release runbook.
// Its scope has always been wider (it also validates the wallet example, which
// is not a workspace member), and it now covers every consumer.
//
// Consumers are DISCOVERED from the workspace rather than listed here. A
// hardcoded list only protects the packages someone remembered to add, and the
// packages most likely to drift are the ones added last: `telemetry-sentry`
// and `telemetry-otel` shipped pinned to the core with nothing verifying them.
// Anything under `packages/*` that builds against the core is checked from the
// moment it exists.
//
// Discovery is two levels deep because `packages/` holds both flat packages
// (`packages/react-sdk`) and vendor families (`packages/adapter/base`,
// `packages/para/react`, `packages/turnkey/core`). It is bounded at two: a
// directory that has its own package.json is a leaf and is never descended
// into. That bound is load-bearing rather than tidy — `packages/react-sdk`
// carries three nameless subpath stub manifests (`lazy/`, `mt/`, `mt/lazy/`)
// and the non-member wallet example, whose manifest DOES pin the core and is
// versioned 0.1.0. An unbounded walk enrols the example as a workspace
// consumer and then fails it on the major.minor rule.
//
// Discovery alone is not enough. It reports what it can see, so anything that
// makes a package invisible — a family renamed, a level added, a move that
// lands somewhere unscanned — shrinks the set being checked and still exits 0.
// That is how the flat-only version of this loop behaved when the families
// arrived: 11 packages present, 7 of them pinning the core, and the check
// reported the same 4 consumers as before. So the discovered set is compared
// against a committed snapshot, `scripts/expected-core-consumers.json`.
//
// The snapshot is GENERATED (`--update-expected`), never hand-typed. A
// hand-typed list has to name the packages someone believes should consume the
// core, and that judgement is exactly what breaks:
//   - `@miden-sdk/vite-plugin` has never declared the core in any dependency
//     field in any revision of its manifest, so listing it fails on day one
//     and permanently.
//   - `@miden-sdk/miden-wallet-adapter` (the barrel) and `-reactui` have zero
//     source use of the core, so adding a dependency to satisfy the list
//     writes a false dependency — and `check:knip` is a required Lint job.
// A snapshot cannot contain a package discovery does not see, so neither trap
// can arise. Its only job is to make a change in what discovery sees show up
// in a reviewed diff instead of in a shrinking number nobody reads.
//
// Discovery deliberately keys off the `workspace:*` DEV dependency, not off
// the pin being verified. Keying off the pin makes deleting it invisible: the
// package drops out of the consumer set instead of failing, which is precisely
// the silent drift this exists to catch. The dev dependency is how a package
// gets the core's types at build time, so it is present for exactly the
// packages that must also declare a published pin — and a package that drops
// it stops compiling, which is not silent.

const fs = require("fs");
const path = require("path");

const CORE = "@miden-sdk/miden-sdk";

const repoRoot = path.resolve(__dirname, "..");
const webClientPath = path.join(
  repoRoot,
  "crates",
  "web-client",
  "package.json"
);
const packagesDir = path.join(repoRoot, "packages");
const expectedConsumersPath = path.join(
  __dirname,
  "expected-core-consumers.json"
);
const walletExamplePath = path.join(
  packagesDir,
  "react-sdk",
  "examples",
  "wallet",
  "package.json"
);

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const writeJson = (filePath, data) => {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const webClientPkg = readJson(webClientPath);

const webClientVersion = webClientPkg.version;
const versionMatch = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(webClientVersion);

if (!versionMatch) {
  console.error(`Unsupported web-client version format: "${webClientVersion}"`);
  process.exit(1);
}

const major = Number(versionMatch[1]);
const minor = Number(versionMatch[2]);
const patch = Number(versionMatch[3]);
const prerelease = versionMatch[4] || "";
// Pin the peer range to the exact patch version, not the major.minor.0
// baseline. The 0.14.x line publishes on every PR-merge (not at fixed
// release points), so consumers should always see the latest patch — the
// .0 baseline would silently allow publishing react-sdk against a stale
// peer.
const expectedRange = prerelease
  ? `^${major}.${minor}.${patch}${prerelease}`
  : `^${major}.${minor}.${patch}`;

/**
 * Every package that pins a first-party package, in reporting order.
 *
 * `field` is the manifest field carrying the pin: workspace packages declare
 * the core as a peer (the consumer installs it), while the example app is a
 * real application and depends on it outright.
 *
 * `pins` is which package names to verify. Workspace packages pin only the
 * core; the example app pins whatever `@miden-sdk/*` it uses, all of which
 * ship on one version, so they are all checked rather than just the core.
 *
 * `checkVersion` is false for the example app: it is not published, so its own
 * version is unrelated to the SDK line.
 */
const consumers = [];

// Directories that never hold a workspace package but do turn up inside
// `packages/` once anything has been installed or built.
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

const isCandidateDir = (entry) =>
  entry.isDirectory() &&
  !entry.name.startsWith(".") &&
  !SKIPPED_DIRS.has(entry.name);

const manifestIn = (dirPath) => {
  const manifestPath = path.join(dirPath, "package.json");
  return fs.existsSync(manifestPath) ? manifestPath : null;
};

// Snapshot keys are repo-relative and forward-slashed so the committed file is
// identical on every platform.
const relFromRoot = (filePath) =>
  path.relative(repoRoot, filePath).split(path.sep).join("/");

const manifests = [];
const emptyFamilies = [];

for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!isCandidateDir(entry)) continue;
  const dirPath = path.join(packagesDir, entry.name);

  // Has its own manifest: a leaf. Do not descend (see the header note on
  // react-sdk's stub manifests and the wallet example).
  const ownManifest = manifestIn(dirPath);
  if (ownManifest) {
    manifests.push({ dirPath, manifestPath: ownManifest });
    continue;
  }

  // No manifest of its own: a family directory. Its leaves are the packages.
  const leaves = [];
  for (const leafEntry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!isCandidateDir(leafEntry)) continue;
    const leafDir = path.join(dirPath, leafEntry.name);
    const leafManifest = manifestIn(leafDir);
    if (!leafManifest) continue;
    leaves.push({ dirPath: leafDir, manifestPath: leafManifest });
  }

  // A family that yields no manifest at all is the loud version of the bug
  // this check exists for. Every directory under `packages/` is either a
  // package or a family of packages; one that is neither means a move,
  // rename or extra nesting level has taken packages out of view.
  if (leaves.length === 0) {
    emptyFamilies.push(relFromRoot(dirPath));
    continue;
  }
  manifests.push(...leaves);
}

if (emptyFamilies.length > 0) {
  console.error(
    `No package.json found under: ${emptyFamilies.join(", ")}. Every ` +
      `directory in packages/ must be either a package (its own ` +
      `package.json) or a family of packages ` +
      `(packages/<family>/<leaf>/package.json). A directory that is ` +
      `neither means discovery has stopped seeing packages it used to ` +
      `check. A directory under packages/ that is deliberately neither ` +
      `belongs in SKIPPED_DIRS above — one reviewed line, same as blessing ` +
      `a change to the expected set.`
  );
  process.exit(1);
}

// Sorted by path so the reported order, and the committed snapshot, do not
// depend on readdir order (which is arbitrary on ext4).
manifests.sort((a, b) =>
  relFromRoot(a.dirPath).localeCompare(relFromRoot(b.dirPath))
);

// Every package published from this workspace. A consumer that pins a sibling
// — `@miden-sdk/para-react` pinning `@miden-sdk/para`, say — has to track the
// same version line as the core does, and checking only the `@miden-sdk/miden-sdk`
// pin let those go stale silently: at 0.16.0-rc.5 three packages still pinned
// siblings at `^0.16.0-rc.4` and this check passed. `^0.16.0-rc.4` does resolve
// rc.5 under semver so nothing broke, but drift that resolves by luck is exactly
// what this check exists to catch.
const firstParty = new Set([CORE]);
for (const { manifestPath } of manifests) {
  const pkg = readJson(manifestPath);
  if (pkg.name && !pkg.private) firstParty.add(pkg.name);
}

for (const { dirPath, manifestPath } of manifests) {
  const pkg = readJson(manifestPath);
  const buildsAgainstCore =
    pkg.devDependencies?.[CORE] ||
    pkg.peerDependencies?.[CORE] ||
    pkg.dependencies?.[CORE];
  if (!buildsAgainstCore) continue;
  // A published pin lives in `peerDependencies` (the consumer installs the
  // core) or `dependencies`. `devDependencies` is the build-time
  // `workspace:*` link and is never the pin, so a package carrying only
  // that one is reported as missing its pin rather than passing.
  const field = pkg.dependencies?.[CORE] ? "dependencies" : "peerDependencies";
  // The core is always required. Siblings are checked only where the consumer
  // actually pins one, so this never invents a pin a package does not declare.
  const siblings = Object.keys(pkg[field] || {}).filter(
    (name) => name !== CORE && firstParty.has(name)
  );
  consumers.push({
    dir: relFromRoot(dirPath),
    label: pkg.name || relFromRoot(dirPath),
    manifestPath,
    pkg,
    field,
    pins: [CORE, ...siblings.sort()],
    checkVersion: true,
  });
}

// Checked before the example app is added, so this stays a real assertion
// about discovery rather than one the unconditional entry below satisfies.
if (consumers.length === 0) {
  console.error(
    `No package under packages/ builds against ${CORE}. Discovery in this ` +
      `check is broken — it would pass vacuously, so it fails instead.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Expected-set tripwire.
//
// Runs on the DISCOVERED set only, before the wallet example is appended: the
// example is not a workspace package and is added unconditionally, so it would
// make the comparison vacuously stable.
//
// A mismatch is not auto-fixed by `--fix`, for the same reason a version
// mismatch is not: which packages consume the core is a decision, not a
// derivation. `--update-expected` is the explicit blessing, and it leaves the
// change in the diff for review.
const shouldUpdateExpected = process.argv.includes("--update-expected");

const discoveredConsumers = consumers.map((consumer) => ({
  path: consumer.dir,
  name: consumer.label,
}));

const describe = (entry) => `${entry.path} (${entry.name})`;

if (shouldUpdateExpected) {
  writeJson(expectedConsumersPath, {
    comment:
      "Generated by `node scripts/check-react-sdk-sync.js --update-expected`. " +
      "Do not hand-edit. Every package under packages/ that builds against " +
      CORE +
      ", by directory and published name. Recording the DIRECTORY as well as " +
      "the name is what makes a family rename or a move fail loudly instead " +
      "of quietly shrinking the set the version-sync check covers.",
    consumers: discoveredConsumers,
  });
  console.log(
    `Wrote ${discoveredConsumers.length} consumers to ` +
      `${relFromRoot(expectedConsumersPath)}: ` +
      `${discoveredConsumers.map(describe).join(", ")}.`
  );
} else {
  if (!fs.existsSync(expectedConsumersPath)) {
    console.error(
      `Missing ${relFromRoot(expectedConsumersPath)}. Generate it with ` +
        `\`node scripts/check-react-sdk-sync.js --update-expected\` and ` +
        `commit it.`
    );
    process.exit(1);
  }

  const expectedDoc = readJson(expectedConsumersPath);
  const expectedConsumers = expectedDoc.consumers || [];
  const expectedKeys = new Set(expectedConsumers.map(describe));
  const discoveredKeys = new Set(discoveredConsumers.map(describe));

  const missing = [...expectedKeys]
    .filter((k) => !discoveredKeys.has(k))
    .sort();
  const unexpected = [...discoveredKeys]
    .filter((k) => !expectedKeys.has(k))
    .sort();

  if (missing.length > 0 || unexpected.length > 0) {
    console.error(
      `Discovered consumers do not match ` +
        `${relFromRoot(expectedConsumersPath)}.`
    );
    for (const key of missing) {
      console.error(`  no longer discovered: ${key}`);
    }
    for (const key of unexpected) {
      console.error(`  newly discovered:     ${key}`);
    }
    console.error(
      `A package that is no longer discovered is no longer version-checked, ` +
        `which is silent. If this change is intended, re-generate the ` +
        `snapshot with \`node scripts/check-react-sdk-sync.js ` +
        `--update-expected\` and commit it with the change that caused it.`
    );
    process.exit(1);
  }
}

const walletExamplePkg = readJson(walletExamplePath);
consumers.push({
  label: "wallet example",
  manifestPath: walletExamplePath,
  pkg: walletExamplePkg,
  field: "dependencies",
  // Every first-party package the example depends on, not just the core. They
  // all ship on one version, so a stale `@miden-sdk/react` here resolves a
  // published React SDK against a core it was never built against.
  //
  // The core is unioned in rather than merely discovered, so that dropping it
  // from the manifest is reported as missing instead of quietly shrinking the
  // set being checked. The other first-party packages are discovered only: an
  // example app that stops using the React SDK is a legitimate change, whereas
  // one that stops depending on the client is not an example of anything.
  pins: [
    ...new Set([
      CORE,
      ...Object.keys(walletExamplePkg.dependencies || {}).filter((name) =>
        name.startsWith("@miden-sdk/")
      ),
    ]),
  ].sort(),
  checkVersion: false,
});

const shouldFix = process.argv.includes("--fix");
const errors = [];

for (const consumer of consumers) {
  const ranges = consumer.pkg[consumer.field] || {};

  for (const pin of consumer.pins) {
    const actualRange = ranges[pin];
    if (!actualRange) {
      errors.push(
        `Missing ${consumer.field} entry for ${pin} in ${consumer.label}.`
      );
    } else if (actualRange !== expectedRange) {
      errors.push(
        `${consumer.label} ${consumer.field} range for ${pin} ` +
          `("${actualRange}") does not match expected "${expectedRange}" ` +
          `for web-client ${webClientVersion}.`
      );
    }
  }

  if (!consumer.checkVersion) continue;

  const consumerVersionMatch = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(
    consumer.pkg.version
  );
  if (!consumerVersionMatch) {
    errors.push(
      `Unsupported ${consumer.label} version format: "${consumer.pkg.version}"`
    );
  } else if (
    Number(consumerVersionMatch[1]) !== major ||
    Number(consumerVersionMatch[2]) !== minor
  ) {
    errors.push(
      `${consumer.label} version "${consumer.pkg.version}" has different ` +
        `major.minor than web-client "${webClientVersion}". They must share ` +
        `the same major.minor version.`
    );
  }
}

if (errors.length > 0) {
  if (shouldFix) {
    const fixed = [];
    for (const consumer of consumers) {
      const ranges = consumer.pkg[consumer.field] || {};
      let touched = false;
      for (const pin of consumer.pins) {
        if (ranges[pin] === expectedRange) continue;
        ranges[pin] = expectedRange;
        touched = true;
        fixed.push(`${pin} in ${consumer.label}`);
      }
      if (!touched) continue;
      consumer.pkg[consumer.field] = ranges;
      writeJson(consumer.manifestPath, consumer.pkg);
    }

    if (fixed.length > 0) {
      console.log(
        `Updated to "${expectedRange}" based on web-client ` +
          `${webClientVersion}: ${fixed.join(", ")}.`
      );
    }

    // A version mismatch is deliberately not auto-fixed: which version a
    // package releases at is a decision, not a derivation. Report it so it is
    // not lost in the noise of a successful fix run.
    for (const message of errors.filter((m) => m.includes("major.minor"))) {
      console.warn(`Not auto-fixed: ${message}`);
    }
    process.exit(0);
  }

  for (const message of errors) {
    console.error(message);
  }
  process.exit(1);
}

console.log(
  `${consumers.length} packages pin web-client ${webClientVersion} ` +
    `(${expectedRange}): ${consumers.map((c) => c.label).join(", ")}.`
);
