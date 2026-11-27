#!/usr/bin/env bash
#
# Stops the testing node started by start-test-node.sh.
#
# Modes:
#   (no args)   stop running test-node processes
#   --help      print usage and exit

set -euo pipefail

case "${1:-}" in
    --help|-h)
        echo "Usage: $(basename "$0") [--help]"
        exit 0
        ;;
    "")
        ;;
    *)
        echo "error: unknown argument '$1'" >&2
        exit 2
        ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/target/test-node"
PID_FILE="$CACHE/pids"

if [ -f "$PID_FILE" ]; then
    while read -r pid; do
        [ -n "$pid" ] || continue
        kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
fi

# Fallback in case the pid file is stale.
for bin in \
    miden-validator \
    miden-node \
    miden-ntx-builder \
    miden-remote-prover \
    miden-funding-service \
    miden-note-transport
do
    pkill -f "$CACHE/install/bin/$bin" 2>/dev/null || true
done

sleep 1
echo "Stopped testing node."
