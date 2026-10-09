#!/usr/bin/env bash
# The rust-sdk start script checked out for a linked client PR can predate the
# node it installs. Node 0.17.0-rc.2 will not start a sequencer until
# fee-collector.mac exists in the node data directory and that account has been
# deployed. Insert those two commands when the script does not already have them.
set -euo pipefail

target="${1:?path to start-test-node.sh}"

if grep -q 'fee-collector create' "$target"; then
    exit 0
fi

python3 - "$target" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
needle = (
    "# Let the validator bind before the sequencer starts producing blocks against it.\n"
    "sleep 2\n"
    "start sequencer"
)
insert = (
    "# Let the validator bind before the sequencer starts producing blocks against it.\n"
    "sleep 2\n"
    "if [ ! -f \"$DATA/node/fee-collector.mac\" ]; then\n"
    "    \"$BIN/miden-node\" fee-collector create --data-directory \"$DATA/node\"\n"
    "fi\n"
    "\"$BIN/miden-node\" fee-collector deploy "
    "--data-directory \"$DATA/node\" --validator.url \"http://$VALIDATOR\"\n"
    "start sequencer"
)
if needle not in text:
    raise SystemExit(f"could not find the sequencer startup in {path}")
path.write_text(text.replace(needle, insert, 1))
PY
