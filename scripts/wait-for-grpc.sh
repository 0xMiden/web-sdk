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
# Probing with `curl -m 5` cuts through this:
#   - During (1)→(2) gap: TCP handshake completes, curl writes the HTTP
#     bytes, but no one reads them. After 5s curl times out → http_code=000.
#   - After (2): tonic accepts, routes, returns SOME http status (200,
#     404, 415, etc.). Any non-000 status proves the dispatcher is live.
#
# We don't care WHICH status comes back — even a 404/415 from a path the
# server doesn't recognize is positive proof the server is dispatching.

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
  # POST a minimal gRPC-web framed body to root. tonic responds with an
  # HTTP status for any reachable router; we only need to see ANY status.
  http_code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
    -X POST \
    -H 'content-type: application/grpc-web+proto' \
    --data-binary "$(printf '\x00\x00\x00\x00\x00')" \
    "http://127.0.0.1:${PORT}/" 2>/dev/null || echo "000")

  if [ -n "$http_code" ] && [ "$http_code" != "000" ]; then
    echo "$(basename "$BINARY") gRPC dispatch responsive after ${attempt} attempt(s) (HTTP $http_code on port $PORT)"
    break
  fi

  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::$(basename "$BINARY") did not respond on port $PORT within ${TIMEOUT}s"
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
