#!/bin/bash
set -euo pipefail
PACKET=$(cd "$(dirname "$0")" && pwd)
export PROOF_EVIDENCE="${RUNNER_TEMP}/sdk509-proof-evidence"
mkdir -p "$PROOF_EVIDENCE/session"
export EXPECTED_SOURCE_TREE=a6df0f0d847957507551d53ff6936c5a018ad5e7
export EXPECTED_MUTATION_TREE=f97824cbede9f120187a3d8f495bf09a227a6111
test "$(git rev-parse HEAD^{tree})" = "$EXPECTED_SOURCE_TREE"
echo '32bf2e9ca9c676dac2916f9bf3acc1c048e5fa76060178a6cb65fd61ee045bfc  rev-mutate.sh' | (cd "$PACKET" && sha256sum -c -)
echo '1071c9ae5a25b0a7f5c006a5fd7ba3789ec16695fcac715c124124e6701ff795  guard.patch' | (cd "$PACKET" && sha256sum -c -)
cp "$PACKET/rev-mutate.sh" "$PACKET/guard.patch" "$PROOF_EVIDENCE/"
printf 'REV_ROOT=%q\n' "$PWD" > "$PROOF_EVIDENCE/session/scope.env"
printf '{"phase":"fix"}\n' > "$PROOF_EVIDENCE/session/state.json"
restore_index() { git read-tree HEAD; }
trap restore_index EXIT
git apply --cached --reverse --unidiff-zero "$PACKET/guard.patch"
test "$(git write-tree)" = "$EXPECTED_MUTATION_TREE"
test "$(git diff --unified=0 | grep -c '^@@')" = 1
test "$(git diff --name-only)" = crates/web-client/src/models/fetched_account.rs
set +e
bash "$PACKET/rev-mutate.sh" "$PROOF_EVIDENCE/session" "python3 '$PACKET/run-rpc.py'" 2>&1 | tee "$PROOF_EVIDENCE/helper.log"
helper_status=${PIPESTATUS[0]}
set -e
restore_index
python3 - "$PROOF_EVIDENCE" "$helper_status" <<'VERIFY'
import json, pathlib, subprocess, sys
p=pathlib.Path(sys.argv[1])
runs=json.loads((p/'runs.json').read_text())
assert int(sys.argv[2]) == 0, sys.argv[2]
assert [r['label'] for r in runs] == ['baseline','mutation','closing'], runs
assert all(r['valid'] for r in runs), runs
helper=(p/'helper.log').read_text()
assert 'rev-mutate: PINNED crates/web-client/src/models/fetched_account.rs hunk 1' in helper
assert 'reverted 1 hunk(s) across 1 file(s); unpinned=0' in helper
assert subprocess.check_output(['git','write-tree'],text=True).strip() == 'a6df0f0d847957507551d53ff6936c5a018ad5e7'
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
(p/'verified.json').write_text(json.dumps(dict(verified=True, source_sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), source_tree='a6df0f0d847957507551d53ff6936c5a018ad5e7', mutation_tree='f97824cbede9f120187a3d8f495bf09a227a6111', helper_sha256='32bf2e9ca9c676dac2916f9bf3acc1c048e5fa76060178a6cb65fd61ee045bfc', runs=runs),indent=2)+'\n')
VERIFY
