#!/usr/bin/env bash
set -euo pipefail

# Check if web-client package.json version has been bumped relative to what's
# currently published on npm. Publishes only if the local version is NOT yet on
# the registry, regardless of which commit introduced the bump.
#
# Usage: check-web-client-version-release.sh <RELEASE_SHA>
#
# Outputs to $GITHUB_OUTPUT:
#   - should_publish: true/false
#   - current_version: version from release commit (always emitted)

# RELEASE_SHA is unused — kept for backward compatibility with the workflow
# call site. Version is read from the checked-out tree.
RELEASE_SHA="${1:-}"

PKG_NAME="@miden-sdk/miden-sdk"
PKG_PATH="crates/web-client/package.json"

write_skip_and_exit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "should_publish=false" >> "$GITHUB_OUTPUT"
    echo "current_version=$CURRENT_VERSION" >> "$GITHUB_OUTPUT"
  else
    echo "should_publish=false"
    echo "current_version=$CURRENT_VERSION"
  fi
  exit 0
}

CURRENT_VERSION=$(jq -r '.version' "$PKG_PATH")

if [ -z "$CURRENT_VERSION" ] || [ "$CURRENT_VERSION" = "null" ]; then
  echo "Unable to read version from $PKG_PATH."
  CURRENT_VERSION=""
  write_skip_and_exit
fi

# `npm view <pkg>@<version> version` prints the version if published, empty otherwise.
PUBLISHED_VERSION=$(npm view "${PKG_NAME}@${CURRENT_VERSION}" version 2>/dev/null || echo "")

if [ "$CURRENT_VERSION" = "$PUBLISHED_VERSION" ]; then
  echo "$PKG_NAME@$CURRENT_VERSION already published to npm; skipping."
  write_skip_and_exit
fi

echo "$PKG_NAME@$CURRENT_VERSION not on npm; will publish."
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "should_publish=true" >> "$GITHUB_OUTPUT"
  echo "current_version=$CURRENT_VERSION" >> "$GITHUB_OUTPUT"
else
  echo "should_publish=true"
  echo "current_version=$CURRENT_VERSION"
fi
