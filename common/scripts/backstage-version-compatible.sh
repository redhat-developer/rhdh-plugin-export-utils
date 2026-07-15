#!/usr/bin/env bash

# Shared Backstage version compatibility helpers for overlay automation workflows.
#
# Usage:
#   source common/scripts/backstage-version-compatible.sh
#   backstage_versions_exact_match "1.52.1" "1.52.0" && echo exact

# Exact match: same major.minor line, regardless of patch direction.
# Example: 1.52.1 is compatible with target 1.52.0.
backstage_versions_exact_match() {
  local source="$1"
  local target="$2"
  [[ "${target}" == "$(semver -r "~${source}" "${target}")" ]] ||
    [[ "${source}" == "$(semver -r "~${target}" "${source}")" ]]
}

# Best-effort match: target satisfies the caret range of an older source line.
# Example: 1.49.3 is compatible with target 1.52.0.
backstage_versions_best_effort_match() {
  local source="$1"
  local target="$2"
  [[ "${target}" == "$(semver -r "^${source}" "${target}")" ]]
}

# Combined check used by publish/compatibility validation.
backstage_versions_compatible() {
  local source="$1"
  local target="$2"
  backstage_versions_exact_match "${source}" "${target}" ||
    backstage_versions_best_effort_match "${source}" "${target}"
}
