#!/usr/bin/env bash
#
# Lint GitHub Actions workflow YAML with actionlint before push.
#
# Usage:
#   ./scripts/lint-workflows.sh
#   ./scripts/lint-workflows.sh .github/workflows/export-dynamic.yaml
#   ./scripts/lint-workflows.sh --shellcheck
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ACTIONLINT_VERSION="${ACTIONLINT_VERSION:-1.7.12}"
CACHE_DIR="${REPO_ROOT}/.cache"
CACHED_ACTIONLINT="${CACHE_DIR}/actionlint"

ENABLE_SHELLCHECK=false
WORKFLOW_PATHS=()

usage() {
  cat <<'EOF'
Lint GitHub Actions workflow files with actionlint.

By default runs shellcheck integration off (-shellcheck=) so output focuses on
workflow syntax/expression errors. Pass --shellcheck to enable shell lint too.

Uses actionlint from PATH when available; otherwise downloads a pinned binary
to .cache/actionlint (gitignored).

Examples:
  ./scripts/lint-workflows.sh
  ./scripts/lint-workflows.sh .github/workflows/test-export-smoke.yaml
  ./scripts/lint-workflows.sh --shellcheck
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --shellcheck)
      ENABLE_SHELLCHECK=true
      shift
      ;;
    --)
      shift
      WORKFLOW_PATHS+=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      WORKFLOW_PATHS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#WORKFLOW_PATHS[@]} -eq 0 ]]; then
  WORKFLOW_PATHS=("${REPO_ROOT}"/.github/workflows/*.yaml)
fi

resolve_actionlint() {
  if command -v actionlint >/dev/null 2>&1; then
    command -v actionlint
    return 0
  fi

  if [[ -x "${CACHED_ACTIONLINT}" ]]; then
    echo "${CACHED_ACTIONLINT}"
    return 0
  fi

  mkdir -p "${CACHE_DIR}"
  local os arch ext archive url tmp
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${arch}" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *)
      echo "Error: unsupported architecture for actionlint download: ${arch}" >&2
      echo "Install actionlint manually: https://github.com/rhysd/actionlint" >&2
      exit 1
      ;;
  esac
  case "${os}" in
    linux) ext=tar.gz ;;
    darwin) ext=tar.gz ;;
    *)
      echo "Error: unsupported OS for actionlint download: ${os}" >&2
      echo "Install actionlint manually: https://github.com/rhysd/actionlint" >&2
      exit 1
      ;;
  esac

  archive="actionlint_${ACTIONLINT_VERSION}_${os}_${arch}.${ext}"
  url="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${archive}"
  tmp="$(mktemp "${CACHE_DIR}/actionlint.XXXXXX.${ext}")"
  echo "Downloading actionlint v${ACTIONLINT_VERSION} to ${CACHED_ACTIONLINT}..." >&2
  curl -fsSL "${url}" -o "${tmp}"
  tar -xzf "${tmp}" -C "${CACHE_DIR}"
  rm -f "${tmp}"
  chmod +x "${CACHED_ACTIONLINT}"
  echo "${CACHED_ACTIONLINT}"
}

ACTIONLINT_BIN="$(resolve_actionlint)"
args=("${ACTIONLINT_BIN}" -color)
if [[ "${ENABLE_SHELLCHECK}" == "false" ]]; then
  args+=(-shellcheck=)
fi
args+=("${WORKFLOW_PATHS[@]}")

echo "Running: ${args[*]}"
"${args[@]}"
