#!/usr/bin/env bash
# WASM_OPT_BIN shim for production builds (wired in rollup.config.js):
# strips MASP debug_info sections in place (see tools/strip-masp-debug),
# then delegates to the real wasm-opt, whose memory-packing pass drops the
# zeroed bytes. $1 is the input wasm; MIDEN_REAL_WASM_OPT holds the real
# binary (falls back to `wasm-opt` on PATH).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cargo run --quiet --release --manifest-path "$REPO_ROOT/Cargo.toml" -p strip-masp-debug -- "$1"

exec "${MIDEN_REAL_WASM_OPT:-wasm-opt}" "$@"
