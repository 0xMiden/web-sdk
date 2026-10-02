import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@wasm-tool/rollup-plugin-rust", () => ({
  default: (options) => ({ name: "rust", options }),
}));

const workflow = readFileSync(
  new URL("../../../../.github/workflows/publish-web-sdk.yml", import.meta.url),
  "utf8"
);
const publishCondition = workflow
  .match(/^  publish:\n    needs:[^\n]+\n    if: >\n((?:      .*\n)+)/m)?.[1]
  .replaceAll("needs.check-version", 'needs["check-version"]')
  .replaceAll("needs.build-native-nodejs", 'needs["build-native-nodejs"]');

const canPublish = (web, nativeResult, cancelled = false, react = "true") => {
  expect(publishCondition, "publish job condition not found").toBeTruthy();
  const needs = {
    "check-version": {
      result: "success",
      outputs: {
        ["should_publish_web"]: web,
        ["should_publish_react"]: react,
        ["should_publish_vite"]: "false",
        ["adopted_count"]: "0",
      },
    },
    "build-native-nodejs": { result: nativeResult },
  };
  return Function(
    "needs",
    "cancelled",
    `return (${publishCondition});`
  )(needs, () => cancelled);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("release publication", () => {
  it.each(["failure", "cancelled", "skipped"])(
    "blocks core publication when the native matrix is %s",
    (nativeResult) => {
      expect(canPublish("true", nativeResult)).toBe(false);
    }
  );

  it("allows core publication after the native matrix succeeds", () => {
    expect(canPublish("true", "success")).toBe(true);
  });

  it("allows companion-only publication with the native matrix skipped", () => {
    expect(canPublish("false", "skipped")).toBe(true);
  });

  it("blocks a cancelled workflow", () => {
    expect(canPublish("true", "success", true)).toBe(false);
    expect(canPublish("false", "skipped", true)).toBe(false);
  });

  it("skips publication when no package needs publishing", () => {
    expect(canPublish("false", "skipped", false, "false")).toBe(false);
  });

  it("locks the native release build", () => {
    const command = workflow.match(
      /(?:run: |        )(cargo build -p miden-client-web[^\n]+)/
    )?.[1];
    expect(command).toBeTruthy();
    expect(command.split(/\s+/)).toContain("--locked");
    expect(command).toContain(
      "--no-default-features --features nodejs,testing"
    );
    expect(command.split(/\s+/)).toContain("--release");
  });

  it.each([
    ["Build napi binary", "cargo build -p miden-client-web"],
    ["Build web-client", "pnpm --filter @miden-sdk/miden-sdk run build"],
  ])("rejects Cargo.lock changes after %s", (name, command) => {
    const step = workflow.match(
      new RegExp(`- name: ${name}\\n[\\s\\S]*?(?=\\n      - name:)`)
    )?.[0];
    expect(step).toBeTruthy();
    expect(step).toContain(command);
    expect(step).toContain("git diff --exit-code -- Cargo.lock");
    expect(step.indexOf("git diff --exit-code -- Cargo.lock")).toBeGreaterThan(
      step.indexOf(command)
    );
    expect(
      workflow.indexOf(step) +
        step.indexOf("git diff --exit-code -- Cargo.lock")
    ).toBeLessThan(workflow.indexOf('npm publish --tag "$DIST_TAG"'));
  });
});

describe.each(["st", "mt"])("%s WASM build", (variant) => {
  it.each([false, true])(
    "locks dependencies with fast PR profile %s",
    async (fast) => {
      vi.stubEnv("MIDEN_BUILD_VARIANT", variant);
      vi.stubEnv("MIDEN_FAST_BUILD", String(fast));
      vi.stubEnv("MIDEN_WEB_DEV", "false");
      for (const key of [
        "RUSTUP_TOOLCHAIN",
        "WASM_OPT_BIN",
        "MIDEN_REAL_WASM_OPT",
      ]) {
        vi.stubEnv(key, process.env[key]);
      }

      const { default: builds } = await import("../../rollup.config.js");
      const options = builds[0].plugins.find(
        (plugin) => plugin.name === "rust"
      ).options;
      const cargo = options.extraArgs.cargo;
      expect(cargo).toContain("--locked");
      expect(cargo).toContain("browser,testing");
      expect(cargo).toContain("--no-default-features");
      expect(cargo.includes("mt-threads")).toBe(variant === "mt");
      expect(cargo.includes("build-std=std,panic_abort")).toBe(
        variant === "mt"
      );
      expect(cargo.includes("profile.release.lto=false")).toBe(fast);
      expect(cargo.includes("profile.release.codegen-units=16")).toBe(fast);
      expect(options.optimize.release).toBe(true);
      expect(options.optimize.wasmOpt).toBe(!fast);
    }
  );
});
