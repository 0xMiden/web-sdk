#!/usr/bin/env bash
set -euo pipefail

# Spawn a long-running test binary in the background under a pty (so its
# stdout is line-buffered, not block-buffered) and wait until it prints a
# specific readiness regex.
#
# Usage:
#   wait-for-bg-binary.sh <binary> <readiness-regex> [log-file] [timeout-seconds]
#
# Example:
#   wait-for-bg-binary.sh \
#     ./bin/testing-node-builder \
#     "Node started successfully" \
#     /tmp/node-builder.log \
#     90
#
# Why a pty: Rust's `println!` goes through `std::io::stdout()`, which uses
# a `BufWriter` (~8 KB block buffer) when stdout is a regular file or pipe.
# Redirecting `>/tmp/foo.log` therefore hides the readiness line until much
# later — long past any reasonable test-startup window. `script(1)` allocates
# a pty pair and connects the child's stdio to it; Rust detects the tty and
# switches to `LineWriter`, so each `println!` flushes on the newline.
#
# `stdbuf -oL` does NOT work — it only modifies libc stdio buffering, and
# Rust's stdio is independent.
#
# We also probe-tail the log every second so we don't busy-spin.

BINARY="${1:?usage: $0 <binary> <readiness-regex> [log-file] [timeout-seconds]}"
READY_RE="${2:?usage: $0 <binary> <readiness-regex> [log-file] [timeout-seconds]}"
LOG_FILE="${3:-/tmp/$(basename "$BINARY").log}"
TIMEOUT="${4:-90}"

chmod +x "$BINARY"
rm -f "$LOG_FILE"

# `script -qfec` runs the command under a pty and writes the output stream
# to LOG_FILE.
#   -q: quiet (no "script started"/"script ended" preamble)
#   -f: flush after every write (so grep sees lines as they arrive)
#   -e: return the child's exit code
#   -c CMD: run CMD instead of an interactive shell
script -qfec "RUST_LOG=none $BINARY" "$LOG_FILE" </dev/null >/dev/null 2>&1 &
SCRIPT_PID=$!

deadline=$((SECONDS + TIMEOUT))
while ! grep -qE "$READY_RE" "$LOG_FILE" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::$(basename "$BINARY") did not match /$READY_RE/ within ${TIMEOUT}s"
    echo "--- $LOG_FILE tail ---"
    tail -50 "$LOG_FILE" 2>/dev/null || echo "(log file is empty or missing)"
    pgrep -af "$(basename "$BINARY")" || echo "(no $(basename "$BINARY") process running)"
    exit 1
  fi
  if ! kill -0 "$SCRIPT_PID" 2>/dev/null \
     && ! pgrep -f "$(basename "$BINARY")" >/dev/null; then
    echo "::error::$(basename "$BINARY") exited before printing readiness signal"
    echo "--- $LOG_FILE tail ---"
    tail -50 "$LOG_FILE" 2>/dev/null || echo "(log file is empty or missing)"
    exit 1
  fi
  sleep 1
done

echo "$(basename "$BINARY") ready (matched /$READY_RE/)"
