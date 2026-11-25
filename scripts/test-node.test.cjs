const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const sdkRoot = path.resolve(__dirname, "..");

const NODE_BINS = [
  "miden-validator",
  "miden-node",
  "miden-ntx-builder",
  "miden-remote-prover",
  "miden-funding-service",
  "miden-note-transport",
];

function setupFixture(t, cargoLockContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-node-scripts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (relative, content, mode) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
  };

  for (const script of [
    "start-test-node.sh",
    "stop-test-node.sh",
    "patch-linked-test-node.sh",
  ]) {
    write(
      `scripts/${script}`,
      fs.readFileSync(path.join(__dirname, script)),
      0o755
    );
  }

  write("Cargo.lock", cargoLockContent);

  const run = (command, args, options = {}) =>
    spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      ...options,
    });

  return { root, write, run };
}

test("start-test-node.sh --help prints usage and exits 0", () => {
  const res = spawnSync("bash", ["scripts/start-test-node.sh", "--help"], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Usage: start-test-node\.sh/);
  assert.match(res.stdout, /--print-rev/);
});

test("start-test-node.sh rejects unknown arguments with exit code 2", () => {
  const res = spawnSync("bash", ["scripts/start-test-node.sh", "--bogus"], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown argument '--bogus'/);
});

test("start-test-node.sh --print-rev resolves registry version from Cargo.lock", (t) => {
  const f = setupFixture(
    t,
    [
      "version = 4",
      "",
      "[[package]]",
      'name = "unrelated"',
      'version = "1.0.0"',
      "",
      "[[package]]",
      'name = "miden-node-proto-build"',
      'checksum = "deadbeef"',
      'version = "0.18.2"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
    ].join("\n")
  );
  const res = f.run("bash", ["scripts/start-test-node.sh", "--print-rev"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.trim(), /^v0\.18\.2-bins\.\d+$/);
});

test("start-test-node.sh --print-rev prefers git rev from Cargo.lock patch", (t) => {
  const rev = "abcdef0123456789abcdef0123456789abcdef01";
  const f = setupFixture(
    t,
    [
      "version = 4",
      "",
      "[[package]]",
      'name = "miden-node-proto-build"',
      'version = "0.18.2"',
      `source = "git+https://github.com/0xMiden/node.git?branch=next#${rev}"`,
      "",
    ].join("\n")
  );
  const res = f.run("bash", ["scripts/start-test-node.sh", "--print-rev"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.trim(), new RegExp(`^${rev}-bins\\.\\d+$`));
});

test("start-test-node.sh --print-rev fails when miden-node-proto-build is missing", (t) => {
  const f = setupFixture(t, 'version = 4\n\n[[package]]\nname = "other"\n');
  const res = f.run("bash", ["scripts/start-test-node.sh", "--print-rev"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no miden-node-proto-build version in Cargo\.lock/);
});

test("start-test-node.sh --install-only trusts MIDEN_TEST_NODE_PREBUILT=1 with all bins executable", (t) => {
  const f = setupFixture(
    t,
    [
      "[[package]]",
      'name = "miden-node-proto-build"',
      'version = "0.18.2"',
      "",
    ].join("\n")
  );
  for (const bin of NODE_BINS) {
    f.write(
      `target/test-node/install/bin/${bin}`,
      "#!/bin/sh\nexit 0\n",
      0o755
    );
  }
  const res = f.run("bash", ["scripts/start-test-node.sh", "--install-only"], {
    env: {
      ...process.env,
      MIDEN_TEST_NODE_PREBUILT: "1",
    },
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /using cached node binaries/);
  assert.match(res.stdout, /install-only: node binaries ready/);
});

test("start-test-node.sh rejects MIDEN_ACCOUNT_ALLOWLIST=1 with fee=0", (t) => {
  const f = setupFixture(
    t,
    [
      "[[package]]",
      'name = "miden-node-proto-build"',
      'version = "0.18.2"',
      "",
    ].join("\n")
  );
  for (const bin of NODE_BINS) {
    f.write(
      `target/test-node/install/bin/${bin}`,
      "#!/bin/sh\nexit 0\n",
      0o755
    );
  }
  const res = f.run("bash", ["scripts/start-test-node.sh"], {
    env: {
      ...process.env,
      MIDEN_TEST_NODE_PREBUILT: "1",
      MIDEN_ACCOUNT_ALLOWLIST: "1",
      MIDEN_VERIFICATION_BASE_FEE: "0",
    },
  });
  assert.notEqual(res.status, 0);
  assert.match(
    res.stderr,
    /MIDEN_ACCOUNT_ALLOWLIST=1 needs a fee-charging chain/
  );
});

test("stop-test-node.sh --help exits 0 and cleans up stale pid files", (t) => {
  const helpRes = spawnSync("bash", ["scripts/stop-test-node.sh", "--help"], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  assert.equal(helpRes.status, 0, helpRes.stderr);
  assert.match(helpRes.stdout, /Usage: stop-test-node\.sh/);

  const f = setupFixture(t, "");
  f.write("target/test-node/pids", "\n99999999\n");
  const stopRes = f.run("bash", ["scripts/stop-test-node.sh"]);
  assert.equal(stopRes.status, 0, stopRes.stderr);
  assert.equal(
    fs.existsSync(path.join(f.root, "target/test-node/pids")),
    false
  );
  assert.match(stopRes.stdout, /Stopped testing node/);
});

test("patch-linked-test-node.sh leaves web-sdk start-test-node.sh untouched and patches legacy scripts", (t) => {
  const f = setupFixture(t, "");
  const original = (f.read = fs.readFileSync(
    path.join(f.root, "scripts/start-test-node.sh"),
    "utf8"
  ));
  const noopRes = f.run("bash", [
    "scripts/patch-linked-test-node.sh",
    "scripts/start-test-node.sh",
  ]);
  assert.equal(noopRes.status, 0, noopRes.stderr);
  assert.equal(
    fs.readFileSync(path.join(f.root, "scripts/start-test-node.sh"), "utf8"),
    original
  );

  f.write(
    "legacy-start.sh",
    [
      "#!/usr/bin/env bash",
      "# Let the validator bind before the sequencer starts producing blocks against it.",
      "sleep 2",
      'start sequencer "$BIN/miden-node"',
      "",
    ].join("\n")
  );
  const patchRes = f.run("bash", [
    "scripts/patch-linked-test-node.sh",
    "legacy-start.sh",
  ]);
  assert.equal(patchRes.status, 0, patchRes.stderr);
  const patched = fs.readFileSync(path.join(f.root, "legacy-start.sh"), "utf8");
  assert.match(patched, /fee-collector create/);
  assert.match(patched, /fee-collector deploy/);
});
