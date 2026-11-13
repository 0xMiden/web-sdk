import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "../../../..");
const workflow = parse(
  fs.readFileSync(
    path.join(root, ".github/workflows/publish-web-sdk.yml"),
    "utf8"
  )
);
const jobs = workflow.jobs;
const coreBuild = "pnpm --filter @miden-sdk/miden-sdk run build";
const reactBuild = "pnpm --filter @miden-sdk/react run build";
const [buildId, build] = Object.entries(jobs).find(([, job]) =>
  job.steps.some((step) => step.run?.includes(coreBuild))
);
const publish = jobs.publish;
const needsOf = (job) => [job.needs].flat();
const commands = (job) => job.steps.map((step) => step.run || "").join("\n");
const stepRunning = (job, command) => {
  const step = job.steps.find((entry) => entry.run?.includes(command));
  expect(step, `missing command: ${command}`).toBeDefined();
  return step;
};

// Evaluate the actual status/output predicates, rejecting syntax outside the
// subset used here. Output and result values are strings, as in Actions.
function enabled(condition, needs, { success = true, cancelled = false } = {}) {
  if (!condition) return success;
  let expression = condition.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1");
  const explicitStatus = /\b(?:cancelled|success|failure|always)\(\)/.test(
    expression
  );
  expression = expression
    .replace(/needs\.([\w-]+)\.(result|outputs\.[\w_]+)/g, (_, job, property) =>
      JSON.stringify(
        property === "result"
          ? needs[job]?.result || ""
          : needs[job]?.outputs?.[property.slice(8)] || ""
      )
    )
    .replace(/cancelled\(\)/g, String(cancelled))
    .replace(/success\(\)/g, String(success))
    .replace(/failure\(\)/g, String(!success && !cancelled))
    .replace(/always\(\)/g, "true");
  const syntax = expression.replace(/'(?:[^']*)'|"(?:[^"\\]|\\.)*"/g, "");
  if (!/^[\s()!&|=truefals]+$/.test(syntax)) {
    throw new Error(`unsupported Actions expression: ${condition}`);
  }
  return (
    (explicitStatus || success) && Boolean(Function(`return (${expression})`)())
  );
}

function scenario({
  web = "false",
  react = "false",
  vite = "false",
  adopted = "0",
  native = "skipped",
  musl = "skipped",
  artifacts = "success",
  check = "success",
} = {}) {
  return {
    "check-version": {
      result: check,
      outputs: {
        ["should_publish_web"]: web,
        ["should_publish_react"]: react,
        ["should_publish_vite"]: vite,
        ["adopted_count"]: adopted,
      },
    },
    "build-native-nodejs": { result: native },
    "build-native-nodejs-musl": { result: musl },
    [buildId]: { result: artifacts },
  };
}

const paths = (step) => step.with.path.trim().split(/\s+/);

describe("release publication contracts", () => {
  it("builds canonical WASM independently of native binaries and publication", () => {
    expect(buildId).not.toBe("publish");
    expect(needsOf(build)).toEqual(["check-version"]);
    expect(needsOf(publish)).toEqual(
      expect.arrayContaining([
        "check-version",
        buildId,
        "build-native-nodejs",
        "build-native-nodejs-musl",
      ])
    );
    expect(commands(publish)).not.toContain(coreBuild);
    expect(commands(publish)).not.toContain(reactBuild);
    expect(commands(build)).toContain("git diff --exit-code -- Cargo.lock");
    expect(build.steps.map((step) => step.name)).toContain(
      "Update CA certificates"
    );
    expect(commands(build)).toContain("./scripts/install-binaryen.sh");
    expect(commands(build)).toContain("./scripts/verify-wasm-size.sh");
    expect(commands(build)).not.toMatch(/MIDEN_(FAST_BUILD|WEB_DEV)=true/);
    expect(build.env?.MIDEN_FAST_BUILD).not.toBe("true");
    for (const job of [build, publish]) {
      expect(commands(job)).toContain("pnpm install --frozen-lockfile");
    }
  });

  it("checks out one resolved commit in every producer and the publisher", () => {
    const output = jobs["check-version"].outputs.checkout_ref;
    const sourceId = output.match(/steps\.([\w-]+)\.outputs\./)?.[1];
    const source = jobs["check-version"].steps.find(
      (step) => step.id === sourceId
    );
    expect(source?.run).toContain("git rev-parse HEAD");
    for (const job of [
      build,
      publish,
      jobs["build-native-nodejs"],
      jobs["build-native-nodejs-musl"],
    ]) {
      const checkout = job.steps.find((step) =>
        step.uses?.startsWith("actions/checkout@")
      );
      expect(checkout.with.ref).toBe(
        "${{ needs.check-version.outputs.checkout_ref }}"
      );
    }
  });

  it("transfers complete dist trees only through the current run's named artifact", () => {
    const upload = build.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@")
    );
    expect(upload).toBeDefined();
    expect(upload.with["if-no-files-found"]).toBe("error");
    const download = publish.steps.find(
      (step) =>
        step.uses?.startsWith("actions/download-artifact@") &&
        step.with.name === upload.with.name
    );
    expect(download).toBeDefined();
    expect(download.with["run-id"]).toBeUndefined();
    expect(download.with.repository).toBeUndefined();
    expect(upload.with.name).toContain(
      "needs.check-version.outputs.checkout_ref"
    );
    expect(paths(upload)).toEqual(
      expect.arrayContaining([
        "release-packages.tar.gz",
        "release-packages.sha256",
      ])
    );
    const archive = stepRunning(build, "tar -czf release-packages.tar.gz");
    expect(archive.run).toContain("crates/web-client/dist");
    expect(archive.run).toContain("packages/react-sdk/dist");
    const verify = stepRunning(
      publish,
      "sha256sum --check release-packages.sha256"
    );
    expect(publish.steps.indexOf(download)).toBeLessThan(
      publish.steps.indexOf(verify)
    );
    expect(verify.run.indexOf("sha256sum --check")).toBeLessThan(
      verify.run.indexOf("tar -xzf")
    );
    expect(publish.steps.indexOf(verify)).toBeLessThan(
      publish.steps.indexOf(stepRunning(publish, "publish --tag"))
    );
    for (const step of publish.steps.filter((entry) =>
      entry.uses?.startsWith("actions/download-artifact@")
    )) {
      expect(step.with.name || step.with.pattern).toBeTruthy();
    }
  });

  it.each([
    [
      "full release",
      { web: "true", react: "true", native: "success", musl: "success" },
      true,
      true,
    ],
    ["React only", { react: "true" }, true, true],
    ["Vite only", { vite: "true", artifacts: "skipped" }, false, true],
    ["adopted only or partial retry", { adopted: "2" }, true, true],
    ["nothing unpublished", { artifacts: "skipped" }, false, false],
    [
      "native matrix failure",
      { web: "true", native: "failure", musl: "success" },
      true,
      false,
    ],
    [
      "musl failure",
      { web: "true", native: "success", musl: "failure" },
      true,
      false,
    ],
    [
      "native skipped unexpectedly",
      { web: "true", native: "skipped", musl: "success" },
      true,
      false,
    ],
    [
      "WASM failure",
      { web: "true", native: "success", musl: "success", artifacts: "failure" },
      true,
      false,
    ],
    [
      "React artifact failure",
      { react: "true", artifacts: "failure" },
      true,
      false,
    ],
    [
      "adopted artifact skipped",
      { adopted: "1", artifacts: "skipped" },
      true,
      false,
    ],
  ])("gates %s", (_, options, wantBuild, wantPublish) => {
    const needs = scenario(options);
    expect(enabled(build.if, needs)).toBe(wantBuild);
    // Jobs with failed/skipped dependencies have implicit success() == false.
    const success = needsOf(publish).every(
      (id) => needs[id]?.result === "success"
    );
    expect(enabled(publish.if, needs, { success })).toBe(wantPublish);
  });

  it("blocks publication on cancellation or a failed version check", () => {
    const needs = scenario({ web: "true", native: "success", musl: "success" });
    expect(enabled(publish.if, needs, { cancelled: true })).toBe(false);
    needs["check-version"].result = "failure";
    expect(enabled(publish.if, needs, { success: false })).toBe(false);
  });

  it("provisions core and React for adopted-only retries without rebuilding published WASM", () => {
    const retry = scenario({ adopted: "3" });
    expect(enabled(stepRunning(build, coreBuild).if, retry)).toBe(false);
    expect(
      enabled(stepRunning(build, "pnpm run hydrate:web-client").if, retry)
    ).toBe(true);
    expect(stepRunning(build, "pnpm run hydrate:web-client").run).toContain(
      'npm view "@miden-sdk/miden-sdk@${VERSION}"'
    );
    expect(stepRunning(build, "pnpm run hydrate:web-client").run).toContain(
      'if [ "$VERSION" != "$PUBLISHED" ]'
    );
    expect(enabled(stepRunning(build, reactBuild).if, retry)).toBe(true);
    const full = scenario({ web: "true", react: "true" });
    expect(
      enabled(stepRunning(build, "pnpm run hydrate:web-client").if, full)
    ).toBe(false);
    expect(
      enabled(
        stepRunning(build, "./scripts/verify-wasm-size.sh").if,
        scenario({ react: "true" })
      )
    ).toBe(true);
  });

  it("publishes all natives before core, then React, and stops after a failed prerequisite", () => {
    const native = stepRunning(publish, "npm publish --tag");
    const core = stepRunning(
      publish,
      "pnpm --filter @miden-sdk/miden-sdk publish"
    );
    const react = stepRunning(
      publish,
      "pnpm --filter @miden-sdk/react publish"
    );
    expect(publish.steps.indexOf(native)).toBeLessThan(
      publish.steps.indexOf(core)
    );
    expect(publish.steps.indexOf(core)).toBeLessThan(
      publish.steps.indexOf(react)
    );
    for (const pkg of [
      "node-sdk-linux-x64-musl",
      "node-sdk-darwin-arm64",
      "node-sdk-darwin-x64",
      "node-sdk-linux-x64-gnu",
    ]) {
      expect(native.run).toContain(pkg);
    }
    expect(native.run).toContain('npm view "${name}@${WEB_VERSION}" version');
    expect(native["continue-on-error"]).not.toBe(true);
    const needs = scenario({
      web: "true",
      react: "true",
      native: "success",
      musl: "success",
    });
    expect(enabled(core.if, needs, { success: false })).toBe(false);
    expect(enabled(react.if, needs, { success: false })).toBe(false);
    expect(publish["runs-on"]).toBe("ubuntu-24.04");
    expect(publish.permissions["id-token"]).toBe("write");
  });

  it("retains stable, prerelease, dispatch and labeled merged-next events in one publisher", () => {
    expect(workflow.on.release.types).toContain("published");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on.pull_request).toEqual({
      branches: ["next"],
      types: ["closed"],
    });
    const resolver = jobs["check-version"].steps.find(
      (step) => step.id === "event"
    ).run;
    expect(resolver).toContain("github.event.release.prerelease");
    expect(resolver).toContain("dist_tag=latest");
    expect(resolver).toContain("dist_tag=next");
    expect(jobs["check-version"].if).toContain(
      "github.event.pull_request.merged == true"
    );
    expect(jobs["check-version"].if).toContain("'patch release'");
  });
});
