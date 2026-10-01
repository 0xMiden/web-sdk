#!/usr/bin/env bash
# `cargo update` for a tree whose linked workspace [patch] replaces a git
# source. Cargo clones that source before it applies the patch, so a deleted
# branch fails the update even though the replacement is on crates.io. When
# that happens, this stands up an empty package for each patched crate, points
# git at it for one retry, and the patch selects the real crates.io crate.
#
# A second failure: `version = "0.17.0-rc.8"` is a caret, so it matches every
# later pre tag of 0.17.0. Publishing rc.9 makes that patch match two crates
# and cargo refuses to choose. The retry pins the version the patch named.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
log="$(mktemp)"
stub_root=""
cleanup() {
  rm -f "$log"
  if [ -n "$stub_root" ]; then
    rm -rf "$stub_root"
  fi
}
trap cleanup EXIT

if cargo update "$@" >"$log" 2>&1; then
  cat "$log"
  exit 0
fi
cat "$log" >&2

if grep -q 'resolved to more than one candidate' "$log"; then
  if python3 - "$root/Cargo.toml" "$log" <<'PY'
import re, sys
from pathlib import Path

cargo_toml, log_path = sys.argv[1:]
log = Path(log_path).read_text()
blocks = re.findall(
    r"patch for `([A-Za-z0-9_-]+)`[^\n]*resolved to more than one candidate\n"
    r"note: found versions: ([^\n]+)",
    log,
)
if not blocks:
    sys.exit(1)
candidates = {}
for name, versions in blocks:
    candidates.setdefault(name, set()).update(v.strip() for v in versions.split(","))

lines = Path(cargo_toml).read_text().splitlines(keepends=True)
in_patch = False
changed = []
out = []
dep_re = re.compile(
    r'^(\s*)([A-Za-z0-9_-]+)(\s*=\s*\{[^}\n]*\bversion\s*=\s*")(=)?([^"]+)(".*)$'
)
for line in lines:
    stripped = line.strip()
    if stripped.startswith("[patch"):
        in_patch = True
    elif stripped.startswith("[") and in_patch:
        in_patch = False
    match = dep_re.match(line.rstrip("\n"))
    if in_patch and match and match.group(4) is None:
        name, version = match.group(2), match.group(5)
        if version in candidates.get(name, ()):
            line = (
                f"{match.group(1)}{name}{match.group(3)}={version}{match.group(6)}\n"
            )
            changed.append(f"{name} ={version}")
    out.append(line)
if not changed:
    sys.exit(1)
Path(cargo_toml).write_text("".join(out))
sys.stderr.write("pinned " + ", ".join(changed) + "\n")
PY
  then
    echo "cargo update: a patch version matched more than one crates.io release; retrying with that version pinned exact" >&2
    if cargo update "$@" >"$log" 2>&1; then
      cat "$log"
      exit 0
    fi
    cat "$log" >&2
  fi
fi

specs="$(grep -oE 'https://[^[:space:]]+\?branch=[^[:space:]]+' "$log" | sort -u || true)"
if [ -z "$specs" ]; then
  exit 1
fi

stub_root="$(mktemp -d)"
config_count=0
config_keys=""
config_vals=""

while IFS= read -r spec; do
  [ -z "$spec" ] && continue
  url="${spec%%\?branch=*}"
  branch="${spec#*\?branch=}"
  repo="$stub_root/$config_count"
  if ! python3 - "$root/Cargo.toml" "$url" "$repo" "$branch" <<'PY'
import re, sys
from pathlib import Path

cargo_toml, url, repo, branch = sys.argv[1:]
text = Path(cargo_toml).read_text()
wanted = {url, url[:-4] if url.endswith(".git") else url + ".git"}
packages = []
in_table = False
matched = False
for line in text.splitlines():
    stripped = line.strip()
    header = re.fullmatch(r'\[patch\."([^"]+)"\]', stripped)
    if header:
        in_table = header.group(1) in wanted
        matched = matched or in_table
        continue
    if stripped.startswith("[") and not stripped.startswith("[patch"):
        in_table = False
        continue
    if not in_table:
        continue
    dep = re.match(
        r'^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bversion\s*=\s*"=?(?P<version>[^"]+)"',
        stripped,
    )
    if dep:
        packages.append((dep.group(1), dep.group("version")))
if not matched or not packages:
    sys.exit(1)

root = Path(repo)
root.mkdir(parents=True)
if len(packages) == 1:
    name, version = packages[0]
    (root / "src").mkdir()
    (root / "src" / "lib.rs").write_text("\n")
    (root / "Cargo.toml").write_text(
        f'[package]\nname = "{name}"\nversion = "{version}"\nedition = "2021"\n'
    )
else:
    members = []
    for name, version in packages:
        members.append(name)
        crate = root / name
        (crate / "src").mkdir(parents=True)
        (crate / "src" / "lib.rs").write_text("\n")
        (crate / "Cargo.toml").write_text(
            f'[package]\nname = "{name}"\nversion = "{version}"\nedition = "2021"\n'
        )
    member_list = ", ".join(f'"{name}"' for name in members)
    (root / "Cargo.toml").write_text(
        '[workspace]\nresolver = "2"\nmembers = [' + member_list + "]\n"
    )
sys.stderr.write("stub " + url + " branch " + branch + "\n")
PY
  then
    continue
  fi
  git -C "$repo" init -b "$branch" >/dev/null
  git -C "$repo" add .
  # The stub is not this repo. Skip hooks so a global lefthook or a
  # commit-msg check cannot fail the retry.
  git -C "$repo" -c core.hooksPath=/dev/null -c user.email="stub@example.com" -c user.name="stub" commit -q -m stub
  config_keys="${config_keys}"$'\n'"url.${repo}/.insteadOf"
  config_vals="${config_vals}"$'\n'"${url}"
  config_count=$((config_count + 1))
done <<EOF
$specs
EOF

if [ "$config_count" -eq 0 ]; then
  exit 1
fi

export CARGO_NET_GIT_FETCH_WITH_CLI=true
export GIT_CONFIG_COUNT="$config_count"
i=0
while IFS= read -r key; do
  [ -z "$key" ] && continue
  export "GIT_CONFIG_KEY_$i=$key"
  i=$((i + 1))
done <<EOF
$config_keys
EOF
i=0
while IFS= read -r val; do
  [ -z "$val" ] && continue
  export "GIT_CONFIG_VALUE_$i=$val"
  i=$((i + 1))
done <<EOF
$config_vals
EOF

echo "cargo update: a patched git branch is gone; retrying against empty stand-in packages" >&2
cargo update "$@"
