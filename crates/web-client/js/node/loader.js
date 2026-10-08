/**
 * Finds and loads the napi native module (.node binary).
 *
 * Search order:
 * 1. MIDEN_MODULE_PATH environment variable (explicit override)
 * 2. Platform-specific npm package (@miden-sdk/node-darwin-arm64,
 *    @miden-sdk/node-linux-x64-gnu, @miden-sdk/node-linux-x64-musl, ...)
 * 3. Package prebuilds directory
 * 4. Repo target directory (for local development)
 *
 * On linux-x64 the process report decides which platform packages to try: a
 * glibc version, or a glibc loader in the process image, picks the glibc
 * binary, and a musl loader picks the musl binary. A report with none of
 * these (or no report at all) tries both, glibc first. When resolution fails,
 * the thrown error reports the platform, every package it tried, and the real
 * reason each step failed instead of a generic "not found".
 */
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);

let _sdk = null;

const LINUX_X64_GNU = "@miden-sdk/node-linux-x64-gnu";
const LINUX_X64_MUSL = "@miden-sdk/node-linux-x64-musl";

/**
 * Loads the napi SDK module. Caches the result after first load.
 *
 * @param {object} [options]
 * @param {string} [options.modulePath] - Explicit path to the .node file.
 * @returns {object} The napi SDK module.
 */
export function loadNativeModule(options) {
  if (_sdk) return _sdk;

  // Each resolution step records why it failed, so the final error can
  // report the real cause instead of a generic "not found".
  const attempts = [];

  // 1. Explicit path (option or env var). This is an authoritative override:
  // if it is set but fails to load, surface that directly rather than
  // silently falling back to a different (possibly stale) installed binary.
  const explicit = options?.modulePath || process.env.MIDEN_MODULE_PATH;
  if (explicit) {
    try {
      _sdk = require(explicit);
      return _sdk;
    } catch (err) {
      throw new Error(
        `Miden napi module at MIDEN_MODULE_PATH="${explicit}" failed to ` +
          `load: ${firstLine(err)}`
      );
    }
  }

  // 2. Platform-specific npm packages (installed via optionalDependencies)
  const platformPackages = getPlatformPackages();
  for (const platformPackage of platformPackages) {
    try {
      _sdk = require(platformPackage);
      return _sdk;
    } catch (err) {
      attempts.push(`require("${platformPackage}") -> ${firstLine(err)}`);
    }
  }
  if (platformPackages.length === 0) {
    attempts.push(`no prebuilt package published for ${platformLabel()}`);
  }

  const archMap = { arm64: "aarch64", x64: "x86_64" };
  const arch = archMap[os.arch()] || os.arch();
  const platform =
    os.platform() === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
  const target = `${arch}-${platform}`;
  const ext = os.platform() === "darwin" ? "dylib" : "so";
  const libName = `libmiden_client_web.${ext}`;

  // 3. Package prebuilds directory
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const prebuildCandidates = [
    path.join(
      packageRoot,
      "prebuilds",
      `${os.platform()}-${os.arch()}`,
      "miden_client_web.node"
    ),
    path.join(packageRoot, "prebuilds", "miden_client_web.node"),
  ];

  for (const p of prebuildCandidates) {
    if (fs.existsSync(p)) {
      try {
        _sdk = require(p);
        return _sdk;
      } catch (err) {
        attempts.push(`require("${p}") -> ${firstLine(err)}`);
      }
    }
  }

  // 4. Repo target directory (development)
  const repoRoot = findRepoRoot(packageRoot);
  if (repoRoot) {
    const targetCandidates = [
      path.join(repoRoot, "target", target, "release", libName),
      path.join(repoRoot, "target", "release", libName),
      path.join(repoRoot, "target", target, "debug", libName),
      path.join(repoRoot, "target", "debug", libName),
    ];

    for (const p of targetCandidates) {
      if (fs.existsSync(p)) {
        // napi requires a .node extension -- copy if needed
        const nodeFile = path.join(path.dirname(p), "miden_client_web.node");
        if (
          !fs.existsSync(nodeFile) ||
          fs.statSync(p).mtimeMs > fs.statSync(nodeFile).mtimeMs
        ) {
          fs.copyFileSync(p, nodeFile);
        }
        try {
          _sdk = require(nodeFile);
          return _sdk;
        } catch (err) {
          attempts.push(`require("${nodeFile}") -> ${firstLine(err)}`);
        }
      }
    }
  }

  throw new Error(buildNotFoundMessage(platformPackages, attempts));
}

/**
 * Returns the platform-specific npm packages to try, in order; empty if the
 * platform has no published binary.
 */
function getPlatformPackages() {
  const key = `${os.platform()}-${os.arch()}`;
  if (key === "linux-x64") return linuxX64Packages();
  const platformMap = {
    "darwin-arm64": "@miden-sdk/node-darwin-arm64",
    "darwin-x64": "@miden-sdk/node-darwin-x64",
  };
  return platformMap[key] ? [platformMap[key]] : [];
}

/**
 * Reads the runtime C library from the process report. Any confident reading
 * picks one package, so an Alpine host with gcompat never falls back to the
 * glibc binary. Some runtimes and shims give no report, a throwing one, or one
 * without these fields; only then are both packages tried.
 */
function linuxX64Packages() {
  // Network interface enumeration is the slow part of a report and says
  // nothing about the C library, so leave it out (as detect-libc does).
  let report;
  let previousExcludeNetwork;
  try {
    previousExcludeNetwork = process.report.excludeNetwork;
    process.report.excludeNetwork = true;
    report = process.report.getReport();
  } catch {
    return [LINUX_X64_GNU, LINUX_X64_MUSL];
  } finally {
    if (process.report) process.report.excludeNetwork = previousExcludeNetwork;
  }
  if (report?.header?.glibcVersionRuntime) return [LINUX_X64_GNU];
  const objs = Array.isArray(report?.sharedObjects) ? report.sharedObjects : [];
  if (objs.some((f) => /ld-musl-/.test(f))) return [LINUX_X64_MUSL];
  if (objs.some((f) => /ld-linux|\/libc\.so/.test(f))) return [LINUX_X64_GNU];
  return [LINUX_X64_GNU, LINUX_X64_MUSL];
}

function platformLabel() {
  return `${os.platform()}-${os.arch()}`;
}

/** First line of an error's message, prefixed with its code when present. */
function firstLine(err) {
  const code = err && err.code ? `${err.code}: ` : "";
  const message = (err && err.message ? err.message : String(err)).split(
    "\n"
  )[0];
  return `${code}${message}`;
}

/**
 * Builds an actionable "module not found" error: the platform we are on, the
 * packages we tried, the real failure of each attempt, and how to fix the
 * common deployment causes.
 */
function buildNotFoundMessage(platformPackages, attempts) {
  const lines = [
    `Miden napi module not found for ${platformLabel()}, Node ${process.version}.`,
    "",
    "Resolution attempts:",
    ...attempts.map((a) => `  - ${a}`),
    "",
  ];

  if (platformPackages.length > 0) {
    const names = platformPackages.map((p) => `"${p}"`).join(" or ");
    lines.push(
      `Expected the optional dependency ${names} to be installed ` +
        `and loadable. Common causes:`,
      "  - The optional dependency was skipped at install time (npm's " +
        "cross-platform lockfile bug, --omit=optional / --no-optional, or a " +
        "pruned or partially-copied node_modules in a Docker build).",
      "  - The base image's libc or CPU does not match a published binary " +
        "(e.g. an Alpine/musl or arm64 image).",
      ""
    );
  } else {
    lines.push("No prebuilt binary is published for this platform.", "");
  }

  lines.push(
    "Fixes:",
    "  - Reinstall with optional dependencies on the target platform, e.g. " +
      "`npm install --include=optional` (or delete node_modules + " +
      "package-lock.json and reinstall on Linux; pnpm avoids this npm bug).",
    "  - On Alpine/musl, ensure @miden-sdk/node-linux-x64-musl is installed, " +
      "or switch to a glibc base image such as node:22-bookworm-slim.",
    "  - Or set MIDEN_MODULE_PATH to a prebuilt .node file.",
    "  - Or build from source: `cargo build -p miden-client-web " +
      "--no-default-features --features nodejs --release`."
  );

  return lines.join("\n");
}

/**
 * Walks up from startDir looking for the repo root (has Cargo.toml + crates/).
 */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(path.join(dir, "Cargo.toml")) &&
      fs.existsSync(path.join(dir, "crates"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
