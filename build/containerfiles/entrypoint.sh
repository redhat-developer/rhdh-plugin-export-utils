#!/usr/bin/env bash
# Drop privileges after fixing GHA workspace ownership when the job starts as root.
set -euo pipefail

RUN_UID="${EXPORT_BUILDER_UID:-1001}"
RUN_GID="${EXPORT_BUILDER_GID:-1001}"

fix_workspace_owner() {
  local dir="$1"
  if [[ -z "${dir}" || ! -d "${dir}" ]]; then
    return 0
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R "${RUN_UID}:${RUN_GID}" "${dir}" 2>/dev/null || true
  fi
}

if [[ "$(id -u)" -eq 0 ]]; then
  fix_workspace_owner "${GITHUB_WORKSPACE:-}"
  fix_workspace_owner "${EXPORT_WORKSPACE_DIRS:-}"
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid="${RUN_UID}" --regid="${RUN_GID}" --init-groups "$@"
  fi
  if command -v gosu >/dev/null 2>&1; then
    exec gosu "${RUN_UID}:${RUN_GID}" "$@"
  fi
  exec su -s /bin/bash -c 'exec "$@"' "default" -- "$@"
fi

exec "$@"
