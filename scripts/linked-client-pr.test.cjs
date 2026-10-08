const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const sdkRoot = path.resolve(__dirname, "..");
const sha = "0123456789abcdef0123456789abcdef01234567";
const nodeSha = "1111111111111111111111111111111111111111";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linked-client-pr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value, mode) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value, { mode });
  };
  const run = (command, args, options = {}) =>
    spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      ...options,
    });
  assert.equal(run("git", ["init", "-q"]).status, 0);
  for (const script of [
    "dev-with-client-pr.sh",
    "cargo-update-linked-patches.sh",
  ]) {
    write(`scripts/${script}`, fs.readFileSync(path.join(__dirname, script)));
  }
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  return { root, write, run, read };
}

function publish(f, name, version, dependencies = {}) {
  const result = f.run("python3", [
    "-c",
    `import hashlib, io, json, pathlib, tarfile, sys\nroot, name, version = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]\ndependencies = json.loads(sys.argv[4])\nmanifest = f'[package]\\nname = "{name}"\\nversion = "{version}"\\nedition = "2021"\\n[dependencies]\\n' + ''.join(f'{dep} = "{req}"\\n' for dep, req in dependencies.items())\nregistry = root / 'registry'\nregistry.mkdir(exist_ok=True)\narchive = registry / f'{name}-{version}.crate'\nwith tarfile.open(archive, 'w:gz') as tar:\n    for suffix, data in [('Cargo.toml', manifest), ('src/lib.rs', '')]:\n        encoded = data.encode()\n        info = tarfile.TarInfo(f'{name}-{version}/{suffix}')\n        info.size = len(encoded)\n        tar.addfile(info, io.BytesIO(encoded))\nindex = registry / 'index' / name[:2] / name[2:4] / name\nindex.parent.mkdir(parents=True, exist_ok=True)\ndeps = [dict(name=dep, req=req, features=[], optional=False, default_features=True, target=None, kind='normal') for dep, req in dependencies.items()]\nwith index.open('a') as out:\n    out.write(json.dumps(dict(name=name, vers=version, deps=deps, cksum=hashlib.sha256(archive.read_bytes()).hexdigest(), features={}, yanked=False)) + '\\n')\n`,
    f.root,
    name,
    version,
    JSON.stringify(dependencies),
  ]);
  assert.equal(result.status, 0, result.stderr);
}

function injectionFixture(t) {
  const f = fixture(t);
  const original = `[workspace.dependencies]\r\nmiden-client = { version = "0.17", default-features = false }\r\n# Preserve the position of this unrelated entry.\r\nunrelated = "1"\r\nmiden-client-proto = { version = "0.17", default-features = false }\r\nmiden-client-sqlite-store = "0.17"\r\n\r\n`;
  const lock = `version = 4\n${["miden-client", "miden-client-proto", "miden-client-sqlite-store", "miden-node-proto-build", "unrelated"].map((name) => `\n[[package]]\nname = "${name}"\nversion = "0.17.0"\n`).join("")}`;
  f.write("Cargo.toml", original);
  f.write("Cargo.lock", lock);
  f.write(
    "upstream.toml",
    '[patch.crates-io]\nmiden-node-proto-build = { git = "https://example.com/node", branch = "moving-node" }\nunused-patch = { git = "https://example.com/unused", tag = "keep-me" }\nversion-patch = { version = "=0.17.1" }\n'
  );
  f.write(
    "upstream.lock",
    `[[package]]\nname = "miden-node-proto-build"\nversion = "0.17.2"\nsource = "git+https://example.com/node.git?branch=moving-node#${nodeSha}"\n`
  );
  f.write(
    "bin/gh",
    `#!/usr/bin/env python3\nimport os, sys\nfrom pathlib import Path\nif any('/contents/' in arg for arg in sys.argv):\n    key = 'UPSTREAM_LOCK' if any('/Cargo.lock?' in arg for arg in sys.argv) else 'UPSTREAM_TOML'\n    print(Path(os.environ[key]).read_text(), end='')\nelse:\n    print('fixture rust-sdk linked ${sha} open false')\n`,
    0o755
  );
  f.write(
    "bin/cargo",
    `#!/usr/bin/env python3\nimport json, sys\nfrom pathlib import Path\nargs = sys.argv[1:]\nif args[0] == 'metadata':\n    print('{"packages":[{"name":"miden-client-web"}]}')\nelif args[0] == 'pkgid':\n    print('fixture#' + args[-1])\nelif args[0] == 'update':\n    with open('cargo-calls.jsonl', 'a') as out:\n        out.write(json.dumps(args) + '\\n')\n    Path('Cargo.lock').write_text('changed by cargo\\n')\nelse:\n    sys.exit(1)\n`,
    0o755
  );
  const env = {
    ...process.env,
    PATH: `${path.join(f.root, "bin")}:${process.env.PATH}`,
    UPSTREAM_TOML: path.join(f.root, "upstream.toml"),
    UPSTREAM_LOCK: path.join(f.root, "upstream.lock"),
    REPO: "fixture/rust-sdk",
    NUM: "123",
    HEAD_OWNER: "fixture",
    HEAD_REPO: "rust-sdk",
    HEAD_REF: "linked",
    HEAD_SHA: sha,
    MERGED: "false",
    GITHUB_STEP_SUMMARY: path.join(f.root, "summary"),
  };
  return {
    ...f,
    original,
    lock,
    local: (...args) =>
      f.run("bash", ["scripts/dev-with-client-pr.sh", ...args], { env }),
    ci: () => {
      const lines = fs
        .readFileSync(
          path.join(
            sdkRoot,
            ".github/actions/inject-linked-client-pr/action.yml"
          ),
          "utf8"
        )
        .split("\n");
      const start =
        lines.flatMap((line, index) =>
          line === "      run: |" ? [index] : []
        )[1] + 1;
      const body = [];
      for (const line of lines.slice(start)) {
        if (line && !line.startsWith("        ")) break;
        body.push(line.slice(8));
      }
      return f.run("bash", [], { input: body.join("\n"), env });
    },
    calls: () => f.read("cargo-calls.jsonl").trim().split("\n").map(JSON.parse),
  };
}

for (const mode of ["local", "ci"]) {
  test(`${mode} retargets the complete client family and refreshes the locked node patch`, (t) => {
    const f = injectionFixture(t);
    const result = mode === "local" ? f.local("123") : f.ci();
    assert.equal(result.status, 0, result.stderr);
    for (const name of [
      "miden-client",
      "miden-client-proto",
      "miden-client-sqlite-store",
    ]) {
      assert.match(
        f.read("Cargo.toml"),
        new RegExp(`^${name}\\s*=.*rev = "${sha}"`, "m")
      );
    }
    assert.match(
      f.read("Cargo.toml"),
      /^miden-client-proto\s*=.*default-features = false/m
    );
    const args = f.calls()[0];
    for (const name of [
      "miden-client",
      "miden-client-proto",
      "miden-client-sqlite-store",
      "miden-node-proto-build",
    ]) {
      assert.ok(
        args.some((arg, index) => arg === "-p" && args[index + 1] === name),
        `missing targeted refresh for ${name}: ${args}`
      );
    }
    assert.ok(!args.includes("unrelated"));
    assert.ok(!args.includes("unused-patch"));
  });
  test(`${mode} pins copied git patches to the linked lock revision`, (t) => {
    const f = injectionFixture(t);
    const result = mode === "local" ? f.local("123") : f.ci();
    assert.equal(result.status, 0, result.stderr);
    const node = f
      .read("Cargo.toml")
      .split("\n")
      .find((line) => line.startsWith("miden-node-proto-build ="));
    assert.match(node, new RegExp(`rev = "${nodeSha}"`));
    assert.doesNotMatch(node, /branch =|tag =/);
    assert.match(
      f.read("Cargo.toml"),
      /^unused-patch = \{ git = "https:\/\/example.com\/unused", tag = "keep-me" \}/m
    );
    assert.match(
      f.read("Cargo.toml"),
      /^version-patch = \{ version = "=0.17.1" \}/m
    );
  });
}

test("local --clear restores the manifest and lock bytes after repeated apply", (t) => {
  const f = injectionFixture(t);
  assert.equal(f.local("123").status, 0);
  assert.equal(f.local("123").status, 0);
  assert.equal(f.local("--clear").status, 0);
  assert.equal(f.read("Cargo.toml"), f.original);
  assert.equal(f.read("Cargo.lock"), f.lock);
  assert.equal(
    f.calls().length,
    2,
    "clear must not refresh unrelated locked packages"
  );
});

const markBegin =
  "# >>>>>>> linked-client-pr (auto-injected by scripts/dev-with-client-pr.sh) >>>>>>>";
const editedLine = 'edited-while-linked = "1"\n';

test("local --clear keeps an edit made while the patch was applied", (t) => {
  const f = injectionFixture(t);
  assert.equal(f.local("123").status, 0);
  fs.appendFileSync(path.join(f.root, "Cargo.toml"), editedLine);
  const result = f.local("--clear");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.read("Cargo.toml").includes(editedLine));
  assert.ok(!f.read("Cargo.toml").includes(markBegin));
  assert.ok(!f.read("Cargo.toml").includes("linked-client-pr"));
  assert.ok(
    !fs.existsSync(path.join(f.root, ".git/linked-client-pr-original"))
  );
  assert.equal(f.calls().length, 2, "the fallback refreshes the lock once");
  assert.match(result.stderr, /edited/);
});

test("a re-apply after an edit never snapshots the earlier linked resolution", (t) => {
  const f = injectionFixture(t);
  assert.equal(f.local("123").status, 0);
  fs.appendFileSync(path.join(f.root, "Cargo.toml"), editedLine);
  assert.equal(f.local("123").status, 0);
  const calls = f.calls();
  assert.equal(calls.length, 3, "apply, fallback refresh, apply");
  assert.ok(calls[1].includes("-p") && calls[1].includes("miden-client"));
  assert.equal(f.local("--clear").status, 0);
  assert.ok(f.read("Cargo.toml").includes(editedLine));
  assert.ok(!f.read("Cargo.toml").includes("linked-client-pr"));
  assert.equal(f.calls().length, 3, "an untouched apply restores its snapshot");
});

function failedApply(t) {
  const f = injectionFixture(t);
  fs.rmSync(path.join(f.root, "upstream.lock"));
  const result = f.local("123");
  assert.notEqual(result.status, 0, "the apply must fail");
  assert.ok(f.read("Cargo.toml").includes("linked-client-pr"));
  return f;
}

test("--clear keeps an edit made after a failed apply", (t) => {
  const f = failedApply(t);
  fs.appendFileSync(path.join(f.root, "Cargo.toml"), editedLine);
  assert.equal(f.local("--clear").status, 0);
  assert.ok(f.read("Cargo.toml").includes(editedLine));
  assert.ok(!f.read("Cargo.toml").includes("linked-client-pr"));
});

test("a re-apply after a failed apply and an edit keeps the edit", (t) => {
  const f = failedApply(t);
  fs.appendFileSync(path.join(f.root, "Cargo.toml"), editedLine);
  fs.writeFileSync(path.join(f.root, "upstream.lock"), "");
  assert.equal(f.local("123").status, 0);
  assert.ok(f.read("Cargo.toml").includes(editedLine));
});

test("--clear restores the original bytes after a failed apply with no edit", (t) => {
  const f = failedApply(t);
  assert.equal(f.local("--clear").status, 0);
  assert.equal(f.read("Cargo.toml"), f.original);
  assert.equal(f.read("Cargo.lock"), f.lock);
  assert.ok(!fs.existsSync(path.join(f.root, "cargo-calls.jsonl")));
});

test("local clear preserves a missing lockfile and is a no-op when already clear", (t) => {
  const f = injectionFixture(t);
  const original = '[workspace.dependencies]\nmiden-client = "0.17"';
  f.write("Cargo.toml", original);
  fs.rmSync(path.join(f.root, "Cargo.lock"));
  assert.equal(f.local("123").status, 0);
  assert.equal(f.local("--clear").status, 0);
  assert.equal(f.read("Cargo.toml"), original);
  assert.ok(!fs.existsSync(path.join(f.root, "Cargo.lock")));
  assert.equal(f.local("--clear").status, 0);
  assert.ok(!fs.existsSync(path.join(f.root, "Cargo.lock")));
  assert.equal(f.calls().length, 1);
});

test("a targeted Cargo refresh selects the newer patch without updating unrelated dependencies", (t) => {
  const f = fixture(t);
  f.write(
    ".cargo/config.toml",
    `[source.crates-io]\nreplace-with = "fixture"\n[source.fixture]\nlocal-registry = "${f.root}/registry"\n`
  );
  f.write(
    "Cargo.toml",
    `[package]\nname = "miden-client"\nversion = "0.17.2"\nedition = "2021"\n[dependencies]\nmiden-node-proto-build = "0.17"\nunrelated = "1"\n`
  );
  f.write("src/lib.rs", "");
  f.write(
    "patched-node/Cargo.toml",
    `[package]\nname = "miden-node-proto-build"\nversion = "0.17.2"\nedition = "2021"\n[dependencies]\ncompatible-support = "0.17.1"\n`
  );
  f.write("patched-node/src/lib.rs", "");
  for (const args of [
    ["init", "-q", "patched-node"],
    ["-C", "patched-node", "add", "."],
    [
      "-C",
      "patched-node",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "Fixture",
    ],
  ]) {
    assert.equal(f.run("git", args).status, 0);
  }

  publish(f, "miden-node-proto-build", "0.17.0", {
    "compatible-support": "0.17",
  });
  publish(f, "compatible-support", "0.17.0");
  publish(f, "unrelated", "1.0.0");
  const initial = f.run("cargo", ["generate-lockfile", "--offline"]);
  assert.equal(initial.status, 0, initial.stderr);
  publish(f, "unrelated", "1.0.1");
  publish(f, "compatible-support", "0.17.1");
  fs.appendFileSync(
    path.join(f.root, "Cargo.toml"),
    `\n[patch.crates-io]\nmiden-node-proto-build = { git = "file://${f.root}/patched-node" }\n`
  );
  const result = f.run("bash", [
    "scripts/cargo-update-linked-patches.sh",
    "-p",
    "miden-client",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const metadata = f.run("cargo", [
    "metadata",
    "--format-version=1",
    "--offline",
  ]);
  assert.equal(metadata.status, 0, metadata.stderr);
  const node = JSON.parse(metadata.stdout).packages.find(
    (pkg) => pkg.name === "miden-node-proto-build"
  );
  assert.equal(node.version, "0.17.2");
  assert.match(node.source, /^git\+file:/);
  assert.match(
    f.read("Cargo.lock"),
    /name = "compatible-support"\nversion = "0.17.1"/
  );
  assert.match(f.read("Cargo.lock"), /name = "unrelated"\nversion = "1.0.0"/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /was not used in the crate graph/
  );
});

test("the prerelease-hold retry keeps the targeted package arguments", (t) => {
  const f = fixture(t);
  f.write(
    "Cargo.toml",
    '[patch.crates-io]\nmiden-objects = { version = "=0.17.0-rc.8" }\n'
  );
  f.write(
    "Cargo.lock",
    '[[package]]\nname = "miden-client"\nversion = "0.17.2"\n\n[[package]]\nname = "miden-processor"\nversion = "0.17.0-rc.9"\n'
  );
  f.write(
    "bin/cargo",
    `#!/usr/bin/env python3\nimport json, sys\nfrom pathlib import Path\nwith open('cargo-calls.jsonl', 'a') as out:\n    out.write(json.dumps(sys.argv[1:]) + '\\n')\nif 'path =' in Path('Cargo.toml').read_text():\n    lock = Path('Cargo.lock')\n    lock.write_text(lock.read_text().replace('0.17.0-rc.9', '0.17.0-rc.8'))\n`,
    0o755
  );
  f.write(
    "bin/curl",
    `#!/usr/bin/env python3\nimport io, tarfile, sys\narchive = sys.argv[sys.argv.index('-o') + 1]\nwith tarfile.open(archive, 'w:gz') as tar:\n    data = b'[package]\\nname = "miden-processor"\\nversion = "0.17.0-rc.8"\\n'\n    info = tarfile.TarInfo('miden-processor-0.17.0-rc.8/Cargo.toml')\n    info.size = len(data)\n    tar.addfile(info, io.BytesIO(data))\n`,
    0o755
  );
  const result = f.run(
    "bash",
    ["scripts/cargo-update-linked-patches.sh", "-p", "miden-client"],
    {
      env: {
        ...process.env,
        PATH: `${path.join(f.root, "bin")}:${process.env.PATH}`,
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const held = f
    .read("Cargo.toml")
    .match(/miden-processor = \{ path = "([^"]+)"/)[1];
  t.after(() =>
    fs.rmSync(path.dirname(held), { recursive: true, force: true })
  );
  const calls = f.read("cargo-calls.jsonl").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1],
    calls[0],
    "the hold retry must not run a broad cargo update"
  );
  assert.deepEqual(calls[0], ["update", "-p", "miden-client"]);
});

test("an incompatible unused patch leaves the compatible registry package selected", (t) => {
  const f = fixture(t);
  f.write(
    ".cargo/config.toml",
    `[source.crates-io]\nreplace-with = "fixture"\n[source.fixture]\nlocal-registry = "${f.root}/registry"\n`
  );
  f.write(
    "Cargo.toml",
    '[package]\nname = "fixture"\nversion = "1.0.0"\nedition = "2021"\n[dependencies]\nmiden-objects = "0.17"\n'
  );
  f.write("src/lib.rs", "");
  publish(f, "miden-objects", "0.17.0");
  publish(f, "miden-objects", "0.18.0");
  const initial = f.run("cargo", ["generate-lockfile", "--offline"]);
  assert.equal(initial.status, 0, initial.stderr);
  fs.appendFileSync(
    path.join(f.root, "Cargo.toml"),
    '\n[patch."https://example.com/unused-protocol.git"]\nmiden-objects = { version = "0.18.0" }\n'
  );
  const result = f.run("bash", [
    "scripts/cargo-update-linked-patches.sh",
    "-p",
    "fixture",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const metadata = f.run("cargo", [
    "metadata",
    "--offline",
    "--format-version=1",
  ]);
  assert.equal(metadata.status, 0, metadata.stderr);
  const objects = JSON.parse(metadata.stdout).packages.find(
    (pkg) => pkg.name === "miden-objects"
  );
  assert.equal(objects.version, "0.17.0");
  assert.match(
    result.stderr,
    /keeping incompatible unused patch miden-objects 0.18.0 inactive/
  );
  assert.doesNotMatch(result.stdout + result.stderr, /^error:/m);
  assert.match(metadata.stderr, /patch `miden-objects v0\.18\.0` was not used/);
  assert.match(f.read("Cargo.lock"), /\[\[patch\.unused\]\]/);
});

test("the precise refresh keeps the main update output ahead of its own", (t) => {
  const f = fixture(t);
  f.write("Cargo.toml", '[package]\nname = "fixture"\nversion = "1.0.0"\n');
  f.write(
    "Cargo.lock",
    '[[package]]\nname = "miden-objects"\nversion = "0.17.0"\n\n[[patch.unused]]\nname = "miden-objects"\nversion = "0.18.0"\n'
  );
  f.write(
    "bin/cargo",
    `#!/usr/bin/env python3\nimport sys\nprint('PRECISE-MARKER' if '--precise' in sys.argv else 'MAIN-UPDATE-MARKER')\n`,
    0o755
  );
  const result = f.run(
    "bash",
    ["scripts/cargo-update-linked-patches.sh", "-p", "fixture"],
    {
      env: {
        ...process.env,
        PATH: `${path.join(f.root, "bin")}:${process.env.PATH}`,
      },
    }
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const main = result.stdout.indexOf("MAIN-UPDATE-MARKER");
  assert.ok(main >= 0, result.stdout);
  assert.ok(result.stdout.indexOf("PRECISE-MARKER") > main, result.stdout);
});

for (const [kind, error] of [
  [
    "network",
    "error: failed to download miden-objects\nCaused by:\n  network timeout\n",
  ],
  [
    "fetch",
    'error: failed to select a version for the requirement `miden-objects = "^0.17"`\ncandidate versions found which didn\'t match: 0.18.0\nerror: failed to fetch repository\n',
  ],
  [
    "transitive",
    'error: failed to select a version for the requirement `miden-processor = "^0.17.1"`\ncandidate versions found which didn\'t match: 0.17.0\n',
  ],
  [
    "missing candidate diagnostic",
    'error: failed to select a version for the requirement `miden-objects = "^0.17"`\nCaused by:\n  network timeout\n',
  ],
]) {
  test(`an unused patch refresh propagates ${kind} failure`, (t) => {
    const f = fixture(t);
    f.write("Cargo.toml", '[package]\nname = "fixture"\nversion = "1.0.0"\n');
    f.write(
      "Cargo.lock",
      '[[package]]\nname = "miden-objects"\nversion = "0.17.0"\n\n[[patch.unused]]\nname = "miden-objects"\nversion = "0.18.0"\n'
    );
    f.write(
      "bin/cargo",
      `#!/usr/bin/env python3\nimport os, sys\nif '--precise' in sys.argv:\n    print(os.environ['CARGO_FAILURE'], end='', file=sys.stderr)\n    sys.exit(1)\n`,
      0o755
    );
    const result = f.run(
      "bash",
      ["scripts/cargo-update-linked-patches.sh", "-p", "fixture"],
      {
        env: {
          ...process.env,
          CARGO_FAILURE: error,
          PATH: `${path.join(f.root, "bin")}:${process.env.PATH}`,
        },
      }
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes(error));
    assert.doesNotMatch(result.stderr, /keeping incompatible unused patch/);
  });
}
