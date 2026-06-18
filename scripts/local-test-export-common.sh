#!/usr/bin/env bash
#
# Shared helpers for local-test-export.sh and local-test-export-reset.sh
#

# Under $HOME/tmp (not system /tmp): user-owned, fewer SELinux surprises with podman bind mounts.
DEFAULT_EXPORT_WORKDIR="${HOME}/tmp/rhdh-plugin-export-test"
# Host-writable publish logs (compile workdir is container subuid-owned under rootless podman).
DEFAULT_PUBLISH_OUTPUT_DIR="${HOME}/tmp/rhdh-plugin-export-publish-output"

# Repo-local output from generate-export-builder-config.sh (local-test-export.sh).
_EXPORT_UTILS_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_GENERATED_DIR="${BUILD_GENERATED_DIR:-${_EXPORT_UTILS_REPO_ROOT}/build/generated}"

remove_build_generated() {
  local dir="${1:-${BUILD_GENERATED_DIR}}"
  if [[ -d "${dir}" ]]; then
    rm -rf "${dir}"
  fi
  return 0
}

# Rootless podman creates bind-mount files as subuids (e.g. 525287). chown from a container
# does not remap them on the host; podman unshare operates in the user namespace that owns them.
remove_export_workdir() {
  local dir="$1"
  if [[ ! -e "${dir}" ]]; then
    return 0
  fi
  if rm -rf "${dir}" 2>/dev/null; then
    return 0
  fi
  echo "  Workdir not removable as $(id -un); removing via podman unshare..."
  if podman unshare rm -rf "${dir}" 2>/dev/null; then
    return 0
  fi
  echo "Error: could not remove ${dir}." >&2
  return 1
}
