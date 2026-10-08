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
#
# That pin is the protocol line. `cargo update -p miden-client` would still
# take rc.9 for the rest of the family, and those rc.9 crates require each
# other, so one crate cannot be moved back alone. The prover then builds a
# proof the node cannot verify. Crates that moved past the pinned pre-release
# are unpacked from crates.io and path-patched, then the update runs again.
# `--precise` cannot be repeated, and a crates.io patch of another crates.io
# version is rejected because both sources are the registry. Cargo indents
# the "    Updating" lines and may color them.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
# Cargo retains an older locked crate even when a newer linked patch is
# compatible. Unlock only the client family and patched packages already used.
targets="$(python3 - "$root/Cargo.toml" "$root/Cargo.lock" "$@" <<'PY'
import re, sys
from pathlib import Path

manifest, lock, *args = sys.argv[1:]
locked = set()
if Path(lock).exists():
    for block in re.findall(r'^\[\[package\]\]\n(.*?)(?=^\[\[|\Z)', Path(lock).read_text(), re.M | re.S):
        match = re.search(r'^name\s*=\s*"([^"]+)"', block, re.M)
        if match:
            locked.add(match.group(1))
selected = {args[i + 1] for i, arg in enumerate(args[:-1]) if arg in ('-p', '--package')}
patches = set()
in_patch = False
for line in Path(manifest).read_text().splitlines():
    stripped = line.strip()
    if stripped.startswith('['):
        in_patch = stripped.startswith('[patch.')
        continue
    if in_patch:
        match = re.match(r'^([A-Za-z0-9_-]+)\s*=\s*\{', stripped)
        if match:
            package = re.search(r'\bpackage\s*=\s*"([^"]+)"', stripped)
            patches.add(package.group(1) if package else match.group(1))
family = {'miden-client', 'miden-client-proto', 'miden-client-sqlite-store'}
for name in sorted((patches | family) & locked - selected):
    print(name)
PY
)"
while IFS= read -r target; do
  if [ -n "$target" ]; then
    set -- "$@" -p "$target"
  fi
done <<< "$targets"

log="$(mktemp)"
precise_log="$(mktemp)"
stub_root=""
cleanup() {
  rm -f "$log" "$precise_log"
  if [ -n "$stub_root" ]; then
    rm -rf "$stub_root"
  fi
}
trap cleanup EXIT

finish_update() {
  local unused name version
  # A compatible older registry crate may keep its support crates locked.
  # Cargo records the fetched replacement's version in patch.unused; selecting
  # that version unlocks only the dependencies required by the linked patch.
  unused="$(python3 - "$root/Cargo.lock" <<'PY'
import re, sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
locked = set()
unused = []
for kind, block in re.findall(r'^\[\[(package|patch\.unused)\]\]\n(.*?)(?=^\[\[|\Z)', text, re.M | re.S):
    name = re.search(r'^name\s*=\s*"([^"]+)"', block, re.M)
    version = re.search(r'^version\s*=\s*"([^"]+)"', block, re.M)
    if not name or not version:
        continue
    if kind == 'package':
        locked.add(name.group(1))
    else:
        unused.append((name.group(1), version.group(1)))
for name, version in unused:
    if name in locked:
        print(name, version)
PY
)"
  while read -r name version; do
    if [ -z "$name" ]; then
      continue
    fi
    echo "cargo update: selecting linked patch $name $version" >&2
    if ! cargo update -p "$name" --precise "$version" >"$precise_log" 2>&1; then
      if python3 - "$name" "$precise_log" <<'PY'
import re, sys
from pathlib import Path

name, log = sys.argv[1:]
text = re.sub(r'\x1b\[[0-9;]*m', '', Path(log).read_text())
header = r'^error: failed to select a version for the requirement `' + re.escape(name) + r' = "[^"\n]+"`$'
candidates = r"^candidate versions found which didn't match: [^\n]+$"
rejected = (
    len(re.findall(r'^error:', text, re.M)) == 1
    and re.search(header, text, re.M)
    and re.search(candidates, text, re.M)
)
sys.exit(0 if rejected else 1)
PY
      then
        echo "cargo update: keeping incompatible unused patch $name $version inactive" >&2
        continue
      fi
      cat "$precise_log" >&2
      exit 1
    fi
    cat "$precise_log" >>"$log"
  done <<< "$unused"
  cat "$log"
  local holds hold_root manifest name version archive spec
  holds="$(python3 - "$root/Cargo.toml" "$log" <<'PY'
import re, sys
from pathlib import Path

cargo_toml, log_path = sys.argv[1:]
text = Path(cargo_toml).read_text()
pins = {}
in_patch = False
for line in text.splitlines():
    stripped = line.strip()
    if stripped.startswith("[patch"):
        in_patch = True
        continue
    if stripped.startswith("[") and in_patch:
        in_patch = False
    if not in_patch:
        continue
    match = re.match(
        r'^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bversion\s*=\s*"=([^"]+)"',
        stripped,
    )
    if match:
        pins[match.group(1)] = match.group(2)

def pre(version):
    match = re.fullmatch(r"(\d+\.\d+\.\d+)-rc\.(\d+)", version)
    if not match:
        return None
    return match.group(1), int(match.group(2))

bases = {}
for version in pins.values():
    parsed = pre(version)
    if not parsed:
        continue
    base, number = parsed
    if base in bases and bases[base] != number:
        bases[base] = None
    elif base not in bases:
        bases[base] = number

holds = []
seen = set()

def consider(name, version):
    parsed = pre(version)
    if not parsed or name in pins or name in seen:
        return
    base, number = parsed
    pin_number = bases.get(base)
    if pin_number is None or number <= pin_number:
        return
    seen.add(name)
    holds.append((name, f"{base}-rc.{pin_number}"))

# Cargo indents "    Updating" and may color it. The lock is the source of
# truth either way: a crate already past the pin never prints an Updating line.
log_text = re.sub(r"\x1b\[[0-9;]*m", "", Path(log_path).read_text())
for match in re.finditer(
    r"^[ \t]*Updating ([A-Za-z0-9_-]+) v(\S+) -> v(\S+)",
    log_text,
    re.M,
):
    consider(match.group(1), match.group(3))

lock_path = Path(cargo_toml).parent / "Cargo.lock"
if lock_path.exists():
    locked = None
    for line in lock_path.read_text().splitlines():
        if line.startswith("name = "):
            locked = line.split("=", 1)[1].strip().strip('"')
            continue
        if line.startswith("version = ") and locked is not None:
            consider(locked, line.split("=", 1)[1].strip().strip('"'))
            locked = None

if not holds:
    sys.exit(0)
for name, version in holds:
    print(f"{name} {version}")
PY
)"
  if [ -z "$holds" ]; then
    exit 0
  fi
  # The unpacked crates stay for the rest of the job. Later cargo builds
  # follow the path patch, so this directory must outlive the script.
  echo "cargo update: a newer pre-release is out; keeping the patched release line" >&2
  hold_root="$(mktemp -d)"
  # macOS mktemp is /var/folders, a symlink of /private/var. The assembler
  # canonicalizes member directories and then requires them to stay under the
  # workspace root, which it leaves as given. The /var path fails that check.
  hold_root="$(cd "$hold_root" && pwd -P)"
  manifest="$hold_root/paths"
  : >"$manifest"
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    name="${spec%% *}"
    version="${spec#* }"
    archive="$hold_root/${name}.crate"
    curl -fsSL "https://static.crates.io/crates/${name}/${name}-${version}.crate" -o "$archive"
    tar -xzf "$archive" -C "$hold_root"
    printf '%s %s\n' "$name" "$hold_root/${name}-${version}" >>"$manifest"
    echo "holding ${name} at ${version}" >&2
  done <<EOF
$holds
EOF
  python3 - "$root/Cargo.toml" "$manifest" <<'PY'
import sys
from pathlib import Path

cargo_toml, manifest = sys.argv[1:]
entries = []
for line in Path(manifest).read_text().splitlines():
    if not line.strip():
        continue
    name, path = line.split(" ", 1)
    entries.append((name, path))
lines = Path(cargo_toml).read_text().splitlines(keepends=True)
fresh = [f'{name} = {{ path = "{path}" }}\n' for name, path in entries]
header = next((i for i, line in enumerate(lines) if line.strip() == "[patch.crates-io]"), None)
if header is None:
    if lines and not lines[-1].endswith("\n"):
        lines[-1] = lines[-1] + "\n"
    if lines and lines[-1].strip() != "":
        lines.append("\n")
    lines.append("[patch.crates-io]\n")
    lines.extend(fresh)
else:
    insert_at = header + 1
    while insert_at < len(lines) and not lines[insert_at].startswith("["):
        insert_at += 1
    lines[insert_at:insert_at] = fresh
Path(cargo_toml).write_text("".join(lines))
PY
  if cargo update "$@" >"$log" 2>&1; then
    cat "$log"
  else
    cat "$log" >&2
    exit 1
  fi
  python3 - "$root/Cargo.lock" "$manifest" <<'PY'
import re, sys
from pathlib import Path

lock_path, manifest = sys.argv[1:]
wanted = {}
for line in Path(manifest).read_text().splitlines():
    if not line.strip():
        continue
    name, path = line.split(" ", 1)
    wanted[name] = path.rsplit(name + "-", 1)[1]

def pre(version):
    match = re.fullmatch(r"(\d+\.\d+\.\d+)-rc\.(\d+)", version)
    if not match:
        return None
    return match.group(1), int(match.group(2))

name = None
bad = []
for line in Path(lock_path).read_text().splitlines():
    if line.startswith("name = "):
        name = line.split("=", 1)[1].strip().strip('"')
        continue
    if not line.startswith("version = "):
        continue
    if name in wanted:
        version = line.split("=", 1)[1].strip().strip('"')
        got = pre(version)
        pin = pre(wanted[name])
        if got and pin and got[0] == pin[0] and got[1] > pin[1]:
            bad.append(f"{name} {version}")
    name = None
if bad:
    sys.stderr.write("still past the patched release: " + ", ".join(bad) + "\n")
    sys.exit(1)
PY
  exit 0
}

if cargo update "$@" >"$log" 2>&1; then
  finish_update "$@"
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
      finish_update "$@"
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
if cargo update "$@" >"$log" 2>&1; then
  finish_update "$@"
fi
cat "$log" >&2
exit 1
