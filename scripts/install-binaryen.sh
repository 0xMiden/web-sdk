#!/usr/bin/env bash
# Installs the checksum-pinned native Binaryen release used by release WASM builds.
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
: "${GITHUB_ENV:?GITHUB_ENV must be set}"

readonly BINARYEN_VERSION="132"
readonly BINARYEN_SHA256="195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572"
readonly ARCHIVE="$RUNNER_TEMP/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz"
readonly URL="https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz"

curl -fsSL --output "$ARCHIVE" "$URL"
echo "$BINARYEN_SHA256  $ARCHIVE" | sha256sum --check --strict
sudo tar -xzf "$ARCHIVE" -C /usr/local --strip-components=1

version_output=$(/usr/local/bin/wasm-opt --version)
if [[ "$version_output" != *"version $BINARYEN_VERSION"* ]]; then
  echo "::error::Expected wasm-opt version $BINARYEN_VERSION, got: $version_output"
  exit 1
fi

echo "$version_output"
echo "WASM_OPT_BIN=/usr/local/bin/wasm-opt" >> "$GITHUB_ENV"
