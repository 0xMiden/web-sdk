#!/usr/bin/env bash
set -uo pipefail

# Spawn a gRPC test binary in the background and wait until its HTTP/gRPC
# layer is actually serving requests — not just that the kernel TcpListener
# is bound.
#
# Usage:
#   wait-for-grpc.sh <binary> <port> [log-file] [timeout-seconds]
#
# Example:
#   wait-for-grpc.sh ./bin/testing-node-builder 57291
#   wait-for-grpc.sh ./bin/testing-remote-prover 50051
#
# Why this is the right probe:
# Both testing-node-builder and testing-remote-prover follow the pattern:
#     let listener = TcpListener::bind(...)?;            // (1)
#     // ... seconds of additional setup ...
#     Server::builder().serve_with_incoming(listener)    // (2)
#
# Between (1) and (2), the kernel completes TCP handshakes and queues the
# connections in the listen backlog — but no userspace code is reading
# from them. A bash `</dev/tcp/...` probe or `pgrep` will say "ready" the
# moment (1) is reached, well before (2) actually dispatches anything.
# That window is the source of the `TypeError: Failed to fetch` flake.
#
# Probe with a plain GET via curl. Tonic doesn't route GET to its gRPC
# handlers, so it'll respond with 404/405/415 — but ANY HTTP response is
# proof the dispatcher is wired up. While the gap (1)→(2) is open, the
# connection stalls and curl times out (returns http_code "000").
#
# Validation: the success check requires http_code to be exactly three
# digits in [1-5][0-9][0-9]. An earlier version used `[ "$code" != "000" ]`
# and false-positived on a curl edge case that emitted "000000" (likely
# an internal connection retry concatenating two failure codes). The
# regex form is the strict version.

BINARY="${1:?usage: $0 <binary> <port> [log-file] [timeout-seconds]}"
PORT="${2:?usage: $0 <binary> <port> [log-file] [timeout-seconds]}"
LOG_FILE="${3:-/tmp/$(basename "$BINARY").log}"
TIMEOUT="${4:-90}"

chmod +x "$BINARY"
rm -f "$LOG_FILE"

RUST_LOG=none "$BINARY" >"$LOG_FILE" 2>&1 &
BIN_PID=$!

deadline=$((SECONDS + TIMEOUT))
attempt=0
while true; do
  attempt=$((attempt + 1))

  http_code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:${PORT}/" 2>/dev/null) || http_code="000"

  # Any 1xx/2xx/3xx/4xx/5xx HTTP code = the server's HTTP layer is up.
  # Connection failures and timeouts produce "000" (or empty); we retry.
  if [[ "$http_code" =~ ^[1-5][0-9][0-9]$ ]]; then
    echo "$(basename "$BINARY") gRPC dispatch responsive after ${attempt} attempt(s) (HTTP $http_code on port $PORT)"
    break
  fi

  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::$(basename "$BINARY") did not respond on port $PORT within ${TIMEOUT}s (last http_code='$http_code')"
    echo "--- $LOG_FILE tail ---"
    tail -50 "$LOG_FILE" 2>/dev/null || echo "(log file is empty or missing)"
    pgrep -af "$(basename "$BINARY")" || echo "(no $(basename "$BINARY") process running)"
    exit 1
  fi

  if ! kill -0 "$BIN_PID" 2>/dev/null && ! pgrep -f "$(basename "$BINARY")" >/dev/null; then
    echo "::error::$(basename "$BINARY") exited before becoming ready"
    echo "--- $LOG_FILE tail ---"
    tail -50 "$LOG_FILE" 2>/dev/null || echo "(log file is empty or missing)"
    exit 1
  fi

  sleep 1
done
