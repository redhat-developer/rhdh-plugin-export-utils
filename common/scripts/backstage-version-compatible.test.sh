#!/usr/bin/env bash
set -euo pipefail

if ! command -v semver >/dev/null 2>&1; then
  npm install -g semver >/dev/null 2>&1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common/scripts/backstage-version-compatible.sh
source "${SCRIPT_DIR}/backstage-version-compatible.sh"

assert_true() {
  local description="$1"
  shift
  if "$@"; then
    echo "PASS: ${description}"
  else
    echo "FAIL: ${description}" >&2
    exit 1
  fi
}

assert_false() {
  local description="$1"
  shift
  if "$@"; then
    echo "FAIL: ${description}" >&2
    exit 1
  else
    echo "PASS: ${description}"
  fi
}

assert_true "1.52.0 exact matches 1.52.0" backstage_versions_exact_match "1.52.0" "1.52.0"
assert_true "1.52.1 exact matches 1.52.0" backstage_versions_exact_match "1.52.1" "1.52.0"
assert_true "1.52.0 exact matches 1.52.1" backstage_versions_exact_match "1.52.0" "1.52.1"
assert_false "1.49.3 is not an exact match for 1.52.0" backstage_versions_exact_match "1.49.3" "1.52.0"
assert_false "1.53.0 is not an exact match for 1.52.0" backstage_versions_exact_match "1.53.0" "1.52.0"

assert_true "1.49.3 best-effort matches 1.52.0" backstage_versions_best_effort_match "1.49.3" "1.52.0"
assert_false "1.52.1 best-effort does not replace exact semantics" backstage_versions_best_effort_match "1.52.1" "1.52.0"

assert_true "1.52.1 is compatible with 1.52.0" backstage_versions_compatible "1.52.1" "1.52.0"
assert_true "1.49.3 is compatible with 1.52.0" backstage_versions_compatible "1.49.3" "1.52.0"
assert_false "1.53.0 is not compatible with 1.52.0" backstage_versions_compatible "1.53.0" "1.52.0"

echo "All backstage version compatibility tests passed."
