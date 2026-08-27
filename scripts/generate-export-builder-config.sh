#!/usr/bin/env bash
#
# Generate per-Node-major export-builder manifests and CLI install scripts from
# versions.json on active overlay release branches.
#
# Usage:
#   ./scripts/generate-export-builder-config.sh
#   OVERLAY_REPO=redhat-developer/rhdh-plugin-export-overlays \
#     OVERLAY_BRANCHES=main,release-1.10,release-1.9 \
#     ./scripts/generate-export-builder-config.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/build/generated}"
OVERLAY_REPO="${OVERLAY_REPO:-redhat-developer/rhdh-plugin-export-overlays}"
OVERLAY_BRANCHES="${OVERLAY_BRANCHES:-main,release-1.10,release-1.9}"
OVERLAY_LOCAL_DIR="${OVERLAY_LOCAL_DIR:-}"

mkdir -p "${OUTPUT_DIR}"

fetch_versions_json() {
  local branch="$1"
  if [[ -n "${OVERLAY_LOCAL_DIR}" ]]; then
    if git -C "${OVERLAY_LOCAL_DIR}" rev-parse --verify "${branch}" >/dev/null 2>&1; then
      git -C "${OVERLAY_LOCAL_DIR}" show "${branch}:versions.json"
      return 0
    fi
    if [[ -f "${OVERLAY_LOCAL_DIR}/versions.json" ]]; then
      cat "${OVERLAY_LOCAL_DIR}/versions.json"
      return 0
    fi
  fi
  if command -v gh >/dev/null 2>&1; then
    gh api "repos/${OVERLAY_REPO}/contents/versions.json?ref=${branch}" --jq '.content' \
      | base64 -d
    return 0
  fi
  echo "Error: cannot fetch versions.json for branch ${branch}. Set OVERLAY_LOCAL_DIR or install gh." >&2
  return 1
}

declare -A NODE_MAJORS
declare -A CLI_BY_NODE
declare -A BRANCHES_BY_CLI_NODE

IFS=',' read -r -a branches <<< "${OVERLAY_BRANCHES}"
for branch in "${branches[@]}"; do
  branch="${branch// /}"
  [[ -z "${branch}" ]] && continue
  echo "Reading versions.json from ${OVERLAY_REPO}@${branch}..."
  versions_json="$(fetch_versions_json "${branch}")"
  node_full="$(echo "${versions_json}" | jq -r '.node // empty')"
  cli_ver="$(echo "${versions_json}" | jq -r '.cli // empty')"
  cli_pkg="$(echo "${versions_json}" | jq -r '."cliPackage" // "@red-hat-developer-hub/cli"')"
  if [[ -z "${node_full}" || -z "${cli_ver}" ]]; then
    echo "Warning: skipping branch ${branch} (missing node or cli in versions.json)" >&2
    continue
  fi
  node_major="${node_full%%.*}"
  NODE_MAJORS["${node_major}"]="${node_full}"
  CLI_PACKAGE="${cli_pkg}"
  key="${node_major}|${cli_ver}"
  CLI_BY_NODE["${key}"]=1
  existing="${BRANCHES_BY_CLI_NODE["${key}"]:-}"
  if [[ -n "${existing}" ]]; then
    BRANCHES_BY_CLI_NODE["${key}"]="${existing},${branch}"
  else
    BRANCHES_BY_CLI_NODE["${key}"]="${branch}"
  fi
done

if [[ ${#NODE_MAJORS[@]} -eq 0 ]]; then
  echo "Error: no Node majors discovered from overlay branches." >&2
  exit 1
fi

generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
mapfile -t sorted_majors < <(printf '%s\n' "${!NODE_MAJORS[@]}" | sort -n)

for node_major in "${sorted_majors[@]}"; do
  node_full="${NODE_MAJORS[${node_major}]}"
  ubi_tag="ubi9-node${node_major}"
  manifest_path="${OUTPUT_DIR}/export-builder-node${node_major}.json"
  install_path="${OUTPUT_DIR}/cli-install-node${node_major}.sh"

  cli_versions_json='[]'
  for key in "${!CLI_BY_NODE[@]}"; do
    if [[ "${key%%|*}" != "${node_major}" ]]; then
      continue
    fi
    cli_ver="${key#*|}"
    cli_path="/opt/rhdh-cli/${cli_ver}/bin/rhdh-cli"
    branches_csv="${BRANCHES_BY_CLI_NODE[${key}]}"
    branches_json="$(echo "${branches_csv}" | jq -R 'split(",")')"
    cli_versions_json="$(echo "${cli_versions_json}" | jq \
      --arg version "${cli_ver}" \
      --arg path "${cli_path}" \
      --argjson overlayBranches "${branches_json}" \
      '. + [{version: $version, path: $path, overlayBranches: $overlayBranches}]')"
  done

  jq -n \
    --argjson major "${node_major}" \
    --arg full "${node_full}" \
    --arg ubiTag "${ubi_tag}" \
    --arg cliPackage "${CLI_PACKAGE}" \
    --argjson cliVersions "${cli_versions_json}" \
    --arg overlayRepo "${OVERLAY_REPO}" \
    --argjson overlayBranches "$(printf '%s\n' "${branches[@]}" | jq -R . | jq -s .)" \
    --arg generatedAt "${generated_at}" \
    '{
      node: {major: $major, full: $full, ubiTag: $ubiTag},
      cliPackage: $cliPackage,
      cliVersions: $cliVersions,
      builtFrom: {
        overlayRepo: $overlayRepo,
        overlayBranches: $overlayBranches,
        generatedAt: $generatedAt
      }
    }' > "${manifest_path}"

  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    echo 'export NPM_CONFIG_LOGLEVEL="${NPM_CONFIG_LOGLEVEL:-error}"'
    echo "CLI_PACKAGE='${CLI_PACKAGE}'"
    echo "${cli_versions_json}" | jq -r '.[].version' | while read -r ver; do
      [[ -z "${ver}" ]] && continue
      cat <<EOF
echo "Installing \${CLI_PACKAGE}@${ver}..."
mkdir -p "/opt/rhdh-cli/${ver}"
npm install -g "\${CLI_PACKAGE}@${ver}" \
  --prefix "/opt/rhdh-cli/${ver}" \
  --ignore-scripts \
  --omit=dev \
  --legacy-peer-deps
EOF
    done
  } > "${install_path}"
  chmod +x "${install_path}"

  echo "Wrote ${manifest_path}"
  echo "Wrote ${install_path}"
done

# Summary for CI matrix
jq -n \
  --argjson majors "$(printf '%s\n' "${sorted_majors[@]}" | jq -R 'tonumber' | jq -s .)" \
  '{nodeMajors: $majors}' > "${OUTPUT_DIR}/builder-matrix.json"
echo "Wrote ${OUTPUT_DIR}/builder-matrix.json"
