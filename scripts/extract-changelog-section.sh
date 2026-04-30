#!/bin/bash
set -euo pipefail

# Extract a single version section from CHANGELOG.md.
#
# Usage: extract-changelog-section.sh <VERSION>
#   VERSION can be either "0.14.5" or "v0.14.5" (the leading 'v' is stripped).
#
# Prints the section body (everything between `## VERSION (...)` and the
# next `## ` heading, exclusive on both ends — the version heading is
# omitted) on stdout. Exits 0 on hit, 1 on miss.
#
# Used by .github/workflows/release-notes.yml to populate a GitHub
# release's body from CHANGELOG.md when a release tag is published.

VERSION_RAW="${1:?usage: extract-changelog-section.sh <version>}"
VERSION="${VERSION_RAW#v}"

awk -v ver="$VERSION" '
  BEGIN { in_section = 0 }
  # Match "## <ver> (anything)" — anchor on the version literal, allow
  # trailing date/TBA/TBD parens.
  /^## / {
    if (in_section) { exit }
    if ($2 == ver) { in_section = 1; next }
  }
  in_section { print }
' CHANGELOG.md
