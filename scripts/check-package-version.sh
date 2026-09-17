#!/usr/bin/env bash
set -euo pipefail

# Decide whether one package in scripts/publish-manifest.json should publish.
#
# Usage: check-package-version.sh <mode> <pkg-path> <BASE_SHA|RELEASE_SHA>
#   mode = release | pr
#
# Generalised replacement for the per-package check-<pkg>-version-{release,pr}.sh
# scripts. Adding a package to the manifest is enough; no new script is needed.
#
# Prints `<should_publish> <current_version>` on stdout so the caller can build a
# plan, and appends nothing to $GITHUB_OUTPUT — a matrix of 11 packages cannot
# share one output namespace.
#
# BOTH modes end in a registry probe. That matters: the pre-existing
# check-*-version-pr.sh scripts compare only against the base branch, so if a
# `next`-channel release fails partway through, a retry re-reports every
# already-published package as publishable and dies on `EPUBLISHCONFLICT`,
# stranding everything after the failure point. Probing the registry makes the
# whole flow idempotent and safe to re-run.

MODE="${1:?mode required: release|pr}"
PKG_PATH="${2:?package path required}"
BASE_SHA="${3:-}"

MANIFEST_PKG="${PKG_PATH}/package.json"

emit() { printf '%s %s\n' "$1" "$2"; }

if [ ! -f "$MANIFEST_PKG" ]; then
  echo "check-package-version: no manifest at $MANIFEST_PKG" >&2
  emit false ""
  exit 0
fi

PKG_NAME=$(jq -r '.name' "$MANIFEST_PKG")
CURRENT_VERSION=$(jq -r '.version' "$MANIFEST_PKG")

if [ -z "$PKG_NAME" ] || [ "$PKG_NAME" = "null" ] ||
   [ -z "$CURRENT_VERSION" ] || [ "$CURRENT_VERSION" = "null" ]; then
  echo "check-package-version: $MANIFEST_PKG has no name/version" >&2
  emit false ""
  exit 0
fi

# In pr mode the manifest must have changed on this branch. This is a cheap
# early-out, not the authority — the registry probe below is.
if [ "$MODE" = "pr" ]; then
  if [ -z "$BASE_SHA" ]; then
    echo "check-package-version: pr mode needs a base sha" >&2
    emit false "$CURRENT_VERSION"
    exit 0
  fi
  if ! git diff --name-only "$BASE_SHA"...HEAD -- "$MANIFEST_PKG" | grep -q .; then
    emit false "$CURRENT_VERSION"
    exit 0
  fi
fi

# Authoritative for both modes: publish iff this exact version is not on npm.
PUBLISHED=$(npm view "${PKG_NAME}@${CURRENT_VERSION}" version 2>/dev/null || echo "")
if [ "$CURRENT_VERSION" = "$PUBLISHED" ]; then
  emit false "$CURRENT_VERSION"
  exit 0
fi

emit true "$CURRENT_VERSION"
