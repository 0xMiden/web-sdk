#!/usr/bin/env bash
# Enforces release WASM limits with enough headroom for normal dependency growth while rejecting
# the known unstripped ST (~27.4MiB) and MT (~37.3MiB) artifacts.
set -euo pipefail

readonly DIST_DIR="${1:-crates/web-client/dist}"
readonly ST_MAX_BYTES=$((25 * 1024 * 1024))
readonly MT_MAX_BYTES=$((35 * 1024 * 1024))

if [[ ! -d "$DIST_DIR" ]]; then
  echo "::error::WASM dist directory does not exist: $DIST_DIR"
  exit 1
fi

wasm_count=0
fail=0
while IFS= read -r -d '' wasm_file; do
  wasm_count=$((wasm_count + 1))
  case "$wasm_file" in
    */st/*)
      variant="ST"
      max_size=$ST_MAX_BYTES
      ;;
    */mt/*)
      variant="MT"
      max_size=$MT_MAX_BYTES
      ;;
    *)
      echo "::error::Cannot determine ST/MT variant for WASM: $wasm_file"
      fail=1
      continue
      ;;
  esac

  size=$(wc -c < "$wasm_file" | tr -d '[:space:]')
  echo "$variant WASM size: $((size / 1024 / 1024))MiB ($size bytes) — $wasm_file"
  if ((size > max_size)); then
    echo "::error::$variant WASM at $wasm_file exceeds its $((max_size / 1024 / 1024))MiB limit. Either optimization/debug stripping failed or the dependency tree grew; compare against the previous release before raising the limit."
    fail=1
  fi
done < <(find "$DIST_DIR" -name '*.wasm' -type f -print0)

if ((wasm_count == 0)); then
  echo "::error::No .wasm files found under $DIST_DIR — build did not produce output."
  exit 1
fi

exit "$fail"
