#!/usr/bin/env bash
set -euo pipefail

if ! command -v semver >/dev/null 2>&1; then
  npm install -g semver >/dev/null 2>&1
fi

readonly BS_1_52_0="1.52.0"
readonly BS_1_52_1="1.52.1"
readonly BS_1_49_3="1.49.3"
readonly BS_1_53_0="1.53.0"

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

# Minor match: same major.minor, patch ignored either way
assert_true "${BS_1_52_0} minor matches ${BS_1_52_0}" backstage_versions_minor_match "${BS_1_52_0}" "${BS_1_52_0}"
assert_true "${BS_1_52_1} minor matches ${BS_1_52_0}" backstage_versions_minor_match "${BS_1_52_1}" "${BS_1_52_0}"
assert_true "${BS_1_52_0} minor matches ${BS_1_52_1}" backstage_versions_minor_match "${BS_1_52_0}" "${BS_1_52_1}"
assert_false "${BS_1_49_3} is not a minor match for ${BS_1_52_0}" backstage_versions_minor_match "${BS_1_49_3}" "${BS_1_52_0}"
assert_false "${BS_1_53_0} is not a minor match for ${BS_1_52_0}" backstage_versions_minor_match "${BS_1_53_0}" "${BS_1_52_0}"

# Best-effort: older minor against newer target (gated by smoke/e2e)
assert_true "${BS_1_49_3} best-effort matches ${BS_1_52_0}" backstage_versions_best_effort_match "${BS_1_49_3}" "${BS_1_52_0}"
assert_false "${BS_1_52_1} is minor not best-effort vs ${BS_1_52_0}" backstage_versions_best_effort_match "${BS_1_52_1}" "${BS_1_52_0}"
assert_false "${BS_1_53_0} best-effort does not match older ${BS_1_52_0}" backstage_versions_best_effort_match "${BS_1_53_0}" "${BS_1_52_0}"

# Combined
assert_true "${BS_1_52_1} compatible with ${BS_1_52_0}" backstage_versions_compatible "${BS_1_52_1}" "${BS_1_52_0}"
assert_true "${BS_1_49_3} compatible with ${BS_1_52_0}" backstage_versions_compatible "${BS_1_49_3}" "${BS_1_52_0}"
assert_false "${BS_1_53_0} not compatible with ${BS_1_52_0}" backstage_versions_compatible "${BS_1_53_0}" "${BS_1_52_0}"

echo "All backstage version compatibility tests passed."
