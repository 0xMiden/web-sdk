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
 * On Linux the platform package is chosen by the runtime C library: an
 * Alpine/musl host resolves the musl binary, a Debian/Ubuntu host the glibc
 * binary. When resolution fails, the thrown error reports the platform, the
 * package it looked for, and the real reason each step failed instead of a
 * generic "not found".
 */
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);

let _sdk = null;
let _libc = null;

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

  // 2. Platform-specific npm package (installed via optionalDependencies)
  const platformPackage = getPlatformPackageName();
  if (platformPackage) {
    try {
      _sdk = require(platformPackage);
      return _sdk;
    } catch (err) {
      attempts.push(`require("${platformPackage}") -> ${firstLine(err)}`);
    }
  } else {
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

  throw new Error(buildNotFoundMessage(platformPackage, attempts));
}

/**
 * Returns the platform-specific npm package name for the current OS/arch,
 * or null if the platform has no published binary. On Linux the choice also
 * depends on the runtime C library (glibc vs musl).
 */
function getPlatformPackageName() {
  const key = `${os.platform()}-${os.arch()}`;
  if (key === "linux-x64") {
    return `@miden-sdk/node-linux-x64-${detectLibc().family}`;
  }
  const platformMap = {
    "darwin-arm64": "@miden-sdk/node-darwin-arm64",
    "darwin-x64": "@miden-sdk/node-darwin-x64",
  };
  return platformMap[key] || null;
}

/**
 * Detects the runtime C library on Linux. glibc builds report a glibc
 * version in the process report; musl (Alpine) leaves it undefined. Returns
 * `{ family, label }` where `family` ("gnu" | "musl") selects the platform
 * package and `label` is a human-readable string for diagnostics. On
 * non-Linux platforms `family` is null (libc selection does not apply).
 */
function detectLibc() {
  if (_libc) return _libc;
  if (os.platform() !== "linux") {
    _libc = { family: null, label: os.platform() };
    return _libc;
  }
  try {
    const report = process.report.getReport();
    const version = report.header.glibcVersionRuntime;
    if (version) {
      // Standard glibc Node reports its runtime version here.
      _libc = { family: "gnu", label: `glibc ${version}` };
    } else if (hasGlibcMarker(report)) {
      // Unusual glibc build that hides glibcVersionRuntime but still links
      // the glibc loader/libc -- keep it on the gnu binary, not musl.
      _libc = { family: "gnu", label: "glibc" };
    } else {
      // No glibc runtime version and no glibc loader in the process image
      // -> musl (Alpine). An absent glibcVersionRuntime is the primary musl
      // signal; standard Alpine Node leaves it undefined.
      _libc = { family: "musl", label: "musl" };
    }
  } catch {
    // Detection unavailable -- assume the more common glibc.
    _libc = { family: "gnu", label: "glibc (assumed)" };
  }
  return _libc;
}

/** True if the process image links the glibc dynamic loader / libc. */
function hasGlibcMarker(report) {
  const objs = report && report.sharedObjects;
  return Array.isArray(objs) && objs.some((f) => /ld-linux|\/libc\.so/.test(f));
}

/** `${platform}-${arch}`, with the libc family appended on Linux. */
function platformLabel() {
  const base = `${os.platform()}-${os.arch()}`;
  const libc = detectLibc();
  return libc.family ? `${base} (${libc.label})` : base;
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
 * package we looked for, the real failure of each attempt, and how to fix the
 * common deployment causes.
 */
function buildNotFoundMessage(platformPackage, attempts) {
  const lines = [
    `Miden napi module not found for ${platformLabel()}, Node ${process.version}.`,
    "",
    "Resolution attempts:",
    ...attempts.map((a) => `  - ${a}`),
    "",
  ];

  if (platformPackage) {
    lines.push(
      `Expected the optional dependency "${platformPackage}" to be installed ` +
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
