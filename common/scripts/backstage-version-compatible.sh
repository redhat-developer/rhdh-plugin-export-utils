#!/usr/bin/env bash

# Shared Backstage version compatibility helpers for overlay automation workflows.
#
# Exact minor match: same major.minor line (patch .z treated as equivalent).
#   Example: source 1.52.1 matches target 1.52.0.
#
# Best-effort match: target is a newer minor/patch on the same major line
#   (semver caret). Used by discovery to open review/test PRs for older plugins
#   that may still run on a newer Backstage; smoke/e2e gates verify them.
#   Example: source 1.49.3 matches target 1.52.0.
#
# Usage:
#   source common/scripts/backstage-version-compatible.sh
#   backstage_versions_exact_match "1.52.1" "1.52.0" && echo exact

# Extract major.minor from a semver-like string (x.y or x.y.z).
backstage_major_minor() {
  local version="$1"
  if [[ "${version}" =~ ^([0-9]+\.[0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

# Exact match: same major.minor line, regardless of patch direction.
backstage_versions_exact_match() {
  local source="$1"
  local target="$2"
  local source_mm target_mm
  source_mm="$(backstage_major_minor "${source}")" || return 1
  target_mm="$(backstage_major_minor "${target}")" || return 1
  if [[ "${source_mm}" == "${target_mm}" ]]; then
    return 0
  fi
  return 1
}

# Best-effort match: target satisfies the caret range of an older source line.
# Requires semver CLI. Does not match when source is newer than target.
backstage_versions_best_effort_match() {
  local source="$1"
  local target="$2"
  # Same major.minor is exact, not best-effort.
  if backstage_versions_exact_match "${source}" "${target}"; then
    return 1
  fi
  if [[ "${target}" == "$(semver -r "^${source}" "${target}")" ]]; then
    return 0
  fi
  return 1
}

# Either exact or best-effort (for callers that only need a yes/no).
backstage_versions_compatible() {
  local source="$1"
  local target="$2"
  if backstage_versions_exact_match "${source}" "${target}" ||
    backstage_versions_best_effort_match "${source}" "${target}"; then
    return 0
  fi
  return 1
}
