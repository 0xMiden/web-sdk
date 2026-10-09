const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-version-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write("crates/web-client/package.json", {
    name: "@miden-sdk/miden-sdk",
    version: "0.16.1",
  });
  write("packages/react-sdk/package.json", {
    name: "@miden-sdk/react",
    version: "0.16.0",
    peerDependencies: { "@miden-sdk/miden-sdk": "^0.16.1" },
  });
  write("packages/adapter/react/package.json", {
    name: "@miden-sdk/adapter-react",
    version: "0.16.0",
    peerDependencies: {
      "@miden-sdk/miden-sdk": "^0.16.1",
      "@miden-sdk/react": "^0.16.0",
    },
  });
  write("packages/react-sdk/examples/wallet/package.json", {
    dependencies: {
      "@miden-sdk/miden-sdk": "^0.16.1",
      "@miden-sdk/react": "^0.16.0",
    },
  });
  write("scripts/expected-core-consumers.json", {
    consumers: [
      { path: "packages/adapter/react", name: "@miden-sdk/adapter-react" },
      { path: "packages/react-sdk", name: "@miden-sdk/react" },
    ],
  });
  const script = path.join(root, "scripts/check-react-sdk-sync.js");
  fs.copyFileSync(path.join(__dirname, "check-react-sdk-sync.js"), script);
  return {
    run: (...args) =>
      spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }),
    read: (relative) =>
      JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")),
    write,
  };
}

test("allows independent patch releases within the same SDK minor", (t) => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

for (const [file, field] of [
  ["packages/adapter/react/package.json", "peerDependencies"],
  ["packages/react-sdk/examples/wallet/package.json", "dependencies"],
]) {
  test(`rejects and fixes an unpublished sibling patch in ${file}`, (t) => {
    const { run, read, write } = fixture(t);
    const pkg = read(file);
    pkg[field]["@miden-sdk/react"] = "^0.16.1";
    write(file, pkg);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match expected "\^0\.16\.0"/);
    assert.equal(run("--fix").status, 0);
    assert.equal(read(file)[field]["@miden-sdk/react"], "^0.16.0");
    assert.equal(read(file)[field]["@miden-sdk/miden-sdk"], "^0.16.1");
    assert.equal(run().status, 0);
  });
}
