#!/usr/bin/env bash
set -uo pipefail

# Build a publish plan from scripts/publish-manifest.json, then execute it in
# dependency-level order so a dependent never lands before the package it pins.
#
# Usage:
#   publish-plan.sh plan    <mode> <base-sha>      -> writes the plan to stdout as JSON
#   publish-plan.sh publish <plan-json> <dist-tag> -> builds and publishes it
#
# Deliberately no `set -e`: one package failing must not abandon the rest
# silently. Failures are counted and reported, and the script exits non-zero.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/scripts/publish-manifest.json"

cmd_plan() {
  local mode="$1" base_sha="${2:-}" plan="[]"
  while IFS=$'\t' read -r name path level build; do
    local out should version
    out=$("$ROOT/scripts/check-package-version.sh" "$mode" "$path" "$base_sha" </dev/null)
    should=$(printf '%s' "$out" | awk '{print $1}')
    version=$(printf '%s' "$out" | awk '{print $2}')
    if [ "$should" = "true" ]; then
      plan=$(printf '%s' "$plan" | jq -c \
        --arg n "$name" --arg p "$path" --arg v "$version" \
        --argjson l "$level" --argjson b "$build" \
        '. + [{name:$n, path:$p, version:$v, level:$l, build:$b}]')
    fi
  # Read the manifest into the loop WITHOUT giving it the loop's stdin: a child
  # that reads stdin (an npm prompt, a stray `read`) would otherwise swallow the
  # rest of the manifest and the loop would end early, silently, exit 0.
  done < <(jq -r '.packages[] | [.name, .path, (.level|tostring), (.build|tostring)] | @tsv' "$MANIFEST")
  printf '%s\n' "$plan"
}

cmd_publish() {
  local plan="$1" dist_tag="$2"
  local expected attempted=0 failed=0
  expected=$(printf '%s' "$plan" | jq 'length')

  if [ "$expected" = "0" ]; then
    echo "publish-plan: nothing to publish."
    return 0
  fi

  echo "publish-plan: $expected package(s) to publish with --tag $dist_tag"

  local levels
  levels=$(printf '%s' "$plan" | jq -r '[.[].level] | unique | .[]')
  for level in $levels; do
    echo "--- level $level ---"
    while IFS=$'\t' read -r name path version build; do
      attempted=$((attempted + 1))
      if [ "$build" = "true" ]; then
        echo "building $name ..."
        if ! pnpm --filter "$name" run build </dev/null; then
          echo "::error::build failed for $name"
          failed=$((failed + 1))
          continue
        fi
      fi
      echo "publishing $name@$version (--tag $dist_tag) ..."
      if ! pnpm --filter "$name" publish \
            --tag "$dist_tag" --access public --provenance --no-git-checks </dev/null; then
        echo "::error::publish failed for $name@$version"
        failed=$((failed + 1))
      fi
    done < <(printf '%s' "$plan" | jq -r --argjson l "$level" \
        '.[] | select(.level == $l) | [.name, .path, .version, (.build|tostring)] | @tsv')
  done

  # A loop that publishes nothing and exits 0 is the failure mode this guards:
  # a malformed plan, a jq that produced no rows, or a swallowed stdin would all
  # otherwise read as success.
  if [ "$attempted" -ne "$expected" ]; then
    echo "::error::plan had $expected entries but only $attempted were attempted"
    return 1
  fi
  if [ "$failed" -ne 0 ]; then
    echo "::error::$failed of $expected package(s) failed to publish"
    return 1
  fi
  echo "publish-plan: published $expected package(s)."
  return 0
}

case "${1:-}" in
  plan)    shift; cmd_plan "$@" ;;
  publish) shift; cmd_publish "$@" ;;
  *) echo "usage: publish-plan.sh {plan <mode> <base-sha> | publish <plan-json> <dist-tag>}" >&2; exit 2 ;;
esac
