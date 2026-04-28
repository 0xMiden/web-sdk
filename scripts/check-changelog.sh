#!/bin/bash
set -uo pipefail

# Pass if the root CHANGELOG.md differs from the PR base ref.
# Override: apply the "no changelog" label on the PR.

CHANGELOG_FILE="CHANGELOG.md"

if [ "${NO_CHANGELOG_LABEL}" = "true" ]; then
  echo "\"no changelog\" label is set — skipping changelog check."
  exit 0
fi

if ! git diff --exit-code "origin/${BASE_REF}" -- "${CHANGELOG_FILE}" > /dev/null 2>&1; then
  echo "Changelog updated: ${CHANGELOG_FILE}"
  exit 0
fi

>&2 cat <<EOF
No CHANGELOG.md change detected.

Add an entry to ${CHANGELOG_FILE} describing the user-visible change,
or apply the "no changelog" label to the PR for trivial / non-user-
visible changes (typos, internal refactors, CI-only edits).
EOF
exit 1
