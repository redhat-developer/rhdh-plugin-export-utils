#!/usr/bin/env bash

# Shared Backstage version compatibility helpers for overlay automation workflows.
#
# Compatibility means the same major.minor line (e.g. 1.52.*). Patch suffixes
# are ignored in either direction — 1.52.1 matches target 1.52.0 and vice versa.
# Different minors are not treated as compatible (1.49.x does not match 1.52.x).
#
# Usage:
#   source common/scripts/backstage-version-compatible.sh
#   backstage_versions_compatible "1.52.1" "1.52.0" && echo compatible

# Extract major.minor from a semver-like string (x.y or x.y.z).
backstage_major_minor() {
  local version="$1"
  if [[ "${version}" =~ ^([0-9]+\.[0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

# True when source and target share the same major.minor line.
backstage_versions_compatible() {
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
