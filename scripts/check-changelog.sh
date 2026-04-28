#!/bin/bash
set -uo pipefail

# Pass if any of these changelog files differs from the PR base ref.
# A PR that updates none of them must carry the "no changelog" label.
CHANGELOG_FILES=(
  "CHANGELOG.md"
  "packages/react-sdk/CHANGELOG.md"
  "packages/vite-plugin/CHANGELOG.md"
)

if [ "${NO_CHANGELOG_LABEL}" = "true" ]; then
  echo "\"no changelog\" label is set — skipping changelog check."
  exit 0
fi

for file in "${CHANGELOG_FILES[@]}"; do
  if ! git diff --exit-code "origin/${BASE_REF}" -- "${file}" > /dev/null 2>&1; then
    echo "Changelog updated: ${file}"
    exit 0
  fi
done

>&2 cat <<EOF
No changelog file was updated. Add an entry to one of:
  - CHANGELOG.md                       (changes to @miden-sdk/miden-sdk / WASM)
  - packages/react-sdk/CHANGELOG.md    (changes to @miden-sdk/react)
  - packages/vite-plugin/CHANGELOG.md  (changes to @miden-sdk/vite-plugin)

Trivial changes (typos, internal refactors, CI-only edits) can apply the
"no changelog" label on the PR to skip this check.
EOF
exit 1
