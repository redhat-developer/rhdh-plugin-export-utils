#!/usr/bin/env bash
#
# Resolve INPUTS_CLI_CALLER from a baked export-builder manifest and CLI version.
#
# Env:
#   INPUTS_CLI_VERSION — required unless INPUTS_CLI_CALLER set
#   EXPORT_BUILDER_MANIFEST — default /etc/rhdh-export-builder/manifest.json
#
set -euo pipefail

if [[ -n "${INPUTS_CLI_CALLER:-}" ]]; then
  if [[ -x "${INPUTS_CLI_CALLER}" ]] || command -v "${INPUTS_CLI_CALLER%% *}" >/dev/null 2>&1; then
    echo "${INPUTS_CLI_CALLER}"
    exit 0
  fi
  echo "Error: INPUTS_CLI_CALLER is set but not executable: ${INPUTS_CLI_CALLER}" >&2
  exit 1
fi

cli_version="${INPUTS_CLI_VERSION:-}"
if [[ -z "${cli_version}" ]]; then
  echo "Error: INPUTS_CLI_VERSION is required." >&2
  exit 1
fi

manifest="${EXPORT_BUILDER_MANIFEST:-/etc/rhdh-export-builder/manifest.json}"
default_path="/opt/rhdh-cli/${cli_version}/bin/rhdh-cli"

if [[ -f "${manifest}" ]]; then
  path="$(jq -r --arg v "${cli_version}" \
    '.cliVersions[] | select(.version == $v) | .path' "${manifest}" | head -n1)"
  if [[ -n "${path}" && "${path}" != "null" && -x "${path}" ]]; then
    echo "${path}"
    exit 0
  fi
  supported="$(jq -r '[.cliVersions[].version] | join(", ")' "${manifest}")"
  echo "Error: CLI ${cli_version} not found in ${manifest}." >&2
  echo "Supported versions: ${supported}" >&2
  echo "Rebuild the export-builder image (publish-export-builder workflow)." >&2
  exit 1
fi

if [[ -x "${default_path}" ]]; then
  echo "${default_path}"
  exit 0
fi

echo "Error: no manifest at ${manifest} and ${default_path} is missing." >&2
exit 1
