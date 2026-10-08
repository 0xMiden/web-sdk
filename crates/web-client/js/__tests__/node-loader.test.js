import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const GNU = "@miden-sdk/node-linux-x64-gnu";
const MUSL = "@miden-sdk/node-linux-x64-musl";

// The loader's require: records every id and resolves only the listed ones.
const requireState = vi.hoisted(() => ({ modules: new Map(), required: [] }));
vi.mock("module", async (importOriginal) => ({
  ...(await importOriginal()),
  createRequire: () => (id) => {
    requireState.required.push(id);
    if (requireState.modules.has(id)) return requireState.modules.get(id);
    const err = new Error(`Cannot find module '${id}'`);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  },
}));

const realExistsSync = fs.existsSync;

// Loads a fresh copy of the loader (empty module cache) on linux-x64 with
// the given process report, where only `resolvable` packages can be required
// and no prebuild or target binary exists on disk.
async function loadOnLinuxX64({ report, resolvable = [] }) {
  requireState.required = [];
  requireState.modules = new Map(resolvable.map((id) => [id, { id }]));
  vi.resetModules();
  const { loadNativeModule } = await import("../node/loader.js");

  vi.spyOn(os, "platform").mockReturnValue("linux");
  vi.spyOn(os, "arch").mockReturnValue("x64");
  vi.spyOn(process.report, "getReport").mockImplementation(report);
  vi.spyOn(fs, "existsSync").mockImplementation((p) =>
    /miden_client_web\.(node|so|dylib)$/.test(String(p))
      ? false
      : realExistsSync(p)
  );
  const copyFileSync = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
    throw new Error("copyFileSync must not run");
  });
  const previousModulePath = process.env.MIDEN_MODULE_PATH;
  delete process.env.MIDEN_MODULE_PATH;

  try {
    return { module: loadNativeModule(), copyFileSync };
  } catch (error) {
    return { error, copyFileSync };
  } finally {
    if (previousModulePath !== undefined) {
      process.env.MIDEN_MODULE_PATH = previousModulePath;
    }
  }
}

const glibcReport = () => ({
  header: { glibcVersionRuntime: "2.36" },
  sharedObjects: ["/lib/x86_64-linux-gnu/libc.so.6"],
});
const muslReport = () => ({
  header: {},
  sharedObjects: ["/lib/ld-musl-x86_64.so.1"],
});
const glibcLoaderReport = () => ({
  header: {},
  sharedObjects: ["/lib64/ld-linux-x86-64.so.2"],
});
const evidenceFreeReport = () => ({ header: {}, sharedObjects: [] });
const throwingReport = () => {
  throw new Error("report unavailable");
};

describe("loadNativeModule on linux-x64", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tries only the glibc package when the report has a glibc version", async () => {
    const { error } = await loadOnLinuxX64({
      report: glibcReport,
      resolvable: [MUSL],
    });

    expect(error?.message).toMatch(/Miden napi module not found/);
    expect(requireState.required).toEqual([GNU]);
  });

  it("tries only the musl package when the report has a musl loader", async () => {
    const { error } = await loadOnLinuxX64({
      report: muslReport,
      resolvable: [GNU],
    });

    expect(error?.message).toMatch(/Miden napi module not found/);
    expect(requireState.required).toEqual([MUSL]);
  });

  it("tries only the glibc package when the report has a glibc loader", async () => {
    const { error } = await loadOnLinuxX64({
      report: glibcLoaderReport,
      resolvable: [MUSL],
    });

    expect(error?.message).toMatch(/Miden napi module not found/);
    expect(requireState.required).toEqual([GNU]);
  });

  it("loads the glibc package when the report carries no C-library evidence", async () => {
    const { module, error } = await loadOnLinuxX64({
      report: evidenceFreeReport,
      resolvable: [GNU],
    });

    expect(error).toBeUndefined();
    expect(module).toEqual({ id: GNU });
    expect(requireState.required).toEqual([GNU]);
  });

  it("tries glibc then musl when the report cannot be read", async () => {
    const { module, error } = await loadOnLinuxX64({
      report: throwingReport,
      resolvable: [MUSL],
    });

    expect(error).toBeUndefined();
    expect(module).toEqual({ id: MUSL });
    expect(requireState.required).toEqual([GNU, MUSL]);
  });

  it("names both packages when neither loads without C-library evidence", async () => {
    const { error, copyFileSync } = await loadOnLinuxX64({
      report: evidenceFreeReport,
    });

    expect(requireState.required).toEqual([GNU, MUSL]);
    expect(error?.message).toContain(`require("${GNU}") -> MODULE_NOT_FOUND`);
    expect(error?.message).toContain(`require("${MUSL}") -> MODULE_NOT_FOUND`);
    expect(error?.message).toContain(`"${GNU}" or "${MUSL}"`);
    expect(copyFileSync).not.toHaveBeenCalled();
  });
});
