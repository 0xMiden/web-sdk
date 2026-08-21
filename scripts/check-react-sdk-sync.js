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

for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(packagesDir, entry.name, "package.json");
  if (!fs.existsSync(manifestPath)) continue;
  const pkg = readJson(manifestPath);
  const buildsAgainstCore =
    pkg.devDependencies?.[CORE] ||
    pkg.peerDependencies?.[CORE] ||
    pkg.dependencies?.[CORE];
  if (!buildsAgainstCore) continue;
  consumers.push({
    label: pkg.name || `packages/${entry.name}`,
    manifestPath,
    pkg,
    // A published pin lives in `peerDependencies` (the consumer installs the
    // core) or `dependencies`. `devDependencies` is the build-time
    // `workspace:*` link and is never the pin, so a package carrying only
    // that one is reported as missing its pin rather than passing.
    field: pkg.dependencies?.[CORE] ? "dependencies" : "peerDependencies",
    pins: [CORE],
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
