#!/usr/bin/env bash
set -euo pipefail

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

assert_true "${BS_1_52_0} compatible with ${BS_1_52_0}" backstage_versions_compatible "${BS_1_52_0}" "${BS_1_52_0}"
assert_true "${BS_1_52_1} compatible with ${BS_1_52_0}" backstage_versions_compatible "${BS_1_52_1}" "${BS_1_52_0}"
assert_true "${BS_1_52_0} compatible with ${BS_1_52_1}" backstage_versions_compatible "${BS_1_52_0}" "${BS_1_52_1}"
assert_false "${BS_1_49_3} not compatible with ${BS_1_52_0}" backstage_versions_compatible "${BS_1_49_3}" "${BS_1_52_0}"
assert_false "${BS_1_53_0} not compatible with ${BS_1_52_0}" backstage_versions_compatible "${BS_1_53_0}" "${BS_1_52_0}"

echo "All backstage version compatibility tests passed."
