#!/usr/bin/env node
// Populate `crates/web-client/dist/` from the published npm tarball instead of
// building the Rust/WASM client locally.
//
// `make test` needs none of this — the root vitest projects mock the client or
// exercise plain JS. But `typecheck` and `build` read a real `dist/`, so
// without this a contributor touching only TypeScript hits a Rust toolchain,
// nightly + stable targets, binaryen, and a multi-minute build for a one-line
// change.
//
// The version is taken from `crates/web-client/package.json` so the hydrated
// dist matches the tree. That version is frequently *unpublished* (a release
// PR bumps it before the release ships, and `next` sits on unreleased rc's),
// so we fall back to the newest published version and say so loudly — a dist
// that silently disagrees with the source tree is worse than no dist.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = path.join(ROOT, "crates", "web-client");
const DIST = path.join(PKG_DIR, "dist");
const NAME = "@miden-sdk/miden-sdk";

const force = process.argv.includes("--force");

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();

const isPublished = (version) => {
  try {
    return sh("npm", ["view", `${NAME}@${version}`, "version"]) === version;
  } catch {
    return false;
  }
};

function main() {
  const localVersion = JSON.parse(
    fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8")
  ).version;

  if (fs.existsSync(DIST) && fs.readdirSync(DIST).length > 0 && !force) {
    console.error(
      `${DIST} already exists and is not empty.\n` +
        `Refusing to overwrite what may be a real local build — re-run with --force to replace it.`
    );
    process.exit(1);
  }

  let version = localVersion;
  if (!isPublished(version)) {
    const latest = sh("npm", ["view", NAME, "version"]);
    console.warn(
      `! ${NAME}@${localVersion} (from crates/web-client/package.json) is not published.\n` +
        `! Falling back to ${latest}. The hydrated dist does NOT match this tree —\n` +
        `! build the client for real before trusting a typecheck against unreleased APIs.`
    );
    version = latest;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hydrate-web-client-"));
  try {
    console.log(`Fetching ${NAME}@${version} ...`);
    const tarball = sh("npm", [
      "pack",
      `${NAME}@${version}`,
      "--silent",
      "--pack-destination",
      tmp,
    ]);
    sh("tar", ["xzf", path.join(tmp, tarball), "-C", tmp]);

    const src = path.join(tmp, "package", "dist");
    if (!fs.existsSync(src)) {
      throw new Error(
        `tarball for ${NAME}@${version} contains no package/dist/`
      );
    }

    fs.rmSync(DIST, { recursive: true, force: true });
    fs.cpSync(src, DIST, { recursive: true });

    const variants = fs
      .readdirSync(DIST, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    console.log(
      `Hydrated ${path.relative(ROOT, DIST)} from ${NAME}@${version} [${variants.join(", ")}]`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
