#!/usr/bin/env bash
#
# Local end-to-end test for the UBI 9 plugin export pipeline.
#
# Builds the export-builder image, optionally starts a local OCI registry,
# checks out upstream sources, applies overlay patches, and runs export-dynamic.sh
# inside the builder container (matching CI).
#
# Usage:
#   ./scripts/local-test-export.sh
#   ./scripts/local-test-export.sh -w workspaces/tech-radar
#   ./scripts/local-test-export.sh -f workspaces/backstage/plugins-list.yaml
#   ./scripts/local-test-export.sh -w workspaces/backstage -f workspaces/backstage/plugins-list.yaml -d ~/tmp/rhdh-plugin-export-backstage
#   ./scripts/local-test-export.sh --no-push --no-registry
#
# Reset all local test state before a fresh run (includes aggressive podman prune):
#   ./scripts/local-test-export-reset.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/local-test-export-common.sh
source "${SCRIPT_DIR}/local-test-export-common.sh"
UTILS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OVERLAYS_DIR="${OVERLAYS_DIR:-$(cd "${UTILS_DIR}/../rhdh-plugin-export-overlays" 2>/dev/null && pwd || true)}"
WORKDIR="${WORKDIR:-${DEFAULT_EXPORT_WORKDIR}}"
WORKSPACE="workspaces/tech-radar"
PLUGINS_FILE=""
BUILDER_IMAGE="localhost/rhdh-plugin-export-builder:ubi9-node24"
REGISTRY_NAME="rhdh-export-local-registry"
REGISTRY_VOLUME="${REGISTRY_NAME}-data"
REGISTRY_PORT="5001"
START_REGISTRY=true
PUSH_OCI=true
IMAGE_TAG_PREFIX="local__"
RHDH_CLI_CALLER=""
KEEP_WORKDIR=false
PRUNE_PODMAN=false
WORKSPACE_EXPLICIT=false

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  echo ""
  echo "Options:"
  echo "  -w, --workspace PATH     Overlay workspace (default: workspaces/tech-radar)"
  echo "  -f, --plugins-file PATH  plugins-list.yaml (default: <workspace>/plugins-list.yaml)"
  echo "                           Relative paths resolve under the overlays repo (-o)."
  echo "                           If the path contains workspaces/<name>/, -w is inferred."
  echo "  -o, --overlays DIR       Path to rhdh-plugin-export-overlays clone"
  echo "  -d, --workdir DIR        Working directory (default: ~/tmp/rhdh-plugin-export-test)"
  echo "  --keep-workdir           Reuse existing workdir (skip rm -rf; faster re-exports)"
  echo "  --prune-podman           Run podman system prune -af before export (free disk)"
  echo "  --no-registry            Skip starting the local registry container"
  echo "  --no-push                Skip OCI image build/push (compile-only; saves disk)"
  echo "  --compile-only           Same as --no-push"
  echo "  --publish-only DIR       Publish OCI from existing staging directory"
  echo "  --registry-port PORT     Local registry port (default: 5001)"
  echo "  --builder-image IMAGE    Export builder image tag (default: localhost/...:ubi9-node24)"
  echo "  --rhdh-cli PATH          Use a local rhdh-cli binary for the publish step"
  echo "  -h, --help               Show this help"
}

PUBLISH_ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--workspace) WORKSPACE="$2"; WORKSPACE_EXPLICIT=true; shift 2 ;;
    -f|--plugins-file|--plugins-list) PLUGINS_FILE="$2"; shift 2 ;;
    -o|--overlays) OVERLAYS_DIR="$2"; shift 2 ;;
    -d|--workdir) WORKDIR="$2"; shift 2 ;;
    --keep-workdir) KEEP_WORKDIR=true; shift ;;
    --prune-podman) PRUNE_PODMAN=true; shift ;;
    --no-registry) START_REGISTRY=false; PUSH_OCI=false; shift ;;
    --no-push|--compile-only) PUSH_OCI=false; shift ;;
    --publish-only) PUBLISH_ONLY="$2"; PUSH_OCI=true; shift 2 ;;
    --registry-port) REGISTRY_PORT="$2"; shift 2 ;;
    --builder-image) BUILDER_IMAGE="$2"; shift 2 ;;
    --rhdh-cli) RHDH_CLI_CALLER="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "${OVERLAYS_DIR}" || ! -d "${OVERLAYS_DIR}" ]]; then
  echo "Error: rhdh-plugin-export-overlays not found. Set OVERLAYS_DIR or use -o." >&2
  exit 1
fi

# Resolve -f to an absolute path: cwd first, then overlays repo root.
resolve_plugins_file() {
  local path="$1"
  if [[ -z "${path}" ]]; then
    return 1
  fi
  if [[ -f "${path}" ]]; then
    realpath "${path}"
    return 0
  fi
  if [[ -f "${OVERLAYS_DIR}/${path}" ]]; then
    realpath "${OVERLAYS_DIR}/${path}"
    return 0
  fi
  return 1
}

infer_workspace_from_plugins_path() {
  local path="$1"
  if [[ "${path}" =~ workspaces/([^/]+)/ ]]; then
    echo "workspaces/${BASH_REMATCH[1]}"
  fi
}

if [[ -n "${PLUGINS_FILE}" ]]; then
  plugins_arg="${PLUGINS_FILE}"
  if ! PLUGINS_FILE="$(resolve_plugins_file "${plugins_arg}")"; then
    echo "Error: plugins-list not found: ${plugins_arg}" >&2
    echo "  (tried cwd and \${OVERLAYS_DIR}/${plugins_arg})" >&2
    exit 1
  fi
  if [[ "${WORKSPACE_EXPLICIT}" == "false" ]]; then
    inferred="$(infer_workspace_from_plugins_path "${PLUGINS_FILE}")"
    if [[ -n "${inferred}" ]]; then
      WORKSPACE="${inferred}"
    fi
  fi
fi

OVERLAY_ROOT="${OVERLAYS_DIR}/${WORKSPACE}"
SOURCE_JSON="${OVERLAY_ROOT}/source.json"
PLUGINS_FILE="${PLUGINS_FILE:-${OVERLAY_ROOT}/plugins-list.yaml}"
VERSIONS_JSON="${OVERLAYS_DIR}/versions.json"

for required in "${SOURCE_JSON}" "${PLUGINS_FILE}" "${VERSIONS_JSON}"; do
  if [[ ! -f "${required}" ]]; then
    echo "Error: required file not found: ${required}" >&2
    exit 1
  fi
done

CLI_PACKAGE="$(jq -r '.cliPackage' "${VERSIONS_JSON}")"
CLI_VERSION="$(jq -r '.cli' "${VERSIONS_JSON}")"
NODE_VERSION="$(jq -r '.node' "${VERSIONS_JSON}")"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ "${BUILDER_IMAGE}" == "localhost/rhdh-plugin-export-builder:ubi9-node24" ]] || \
   [[ "${BUILDER_IMAGE}" == "localhost/rhdh-plugin-export-builder:ubi9" ]]; then
  BUILDER_IMAGE="localhost/rhdh-plugin-export-builder:ubi9-node${NODE_MAJOR}"
fi
if [[ -z "${RHDH_CLI_CALLER}" ]]; then
  RHDH_CLI_CALLER="/opt/rhdh-cli/${CLI_VERSION}/bin/rhdh-cli"
fi
SOURCE_REPO="$(jq -r '.repo' "${SOURCE_JSON}")"
SOURCE_REF="$(jq -r '."repo-ref"' "${SOURCE_JSON}")"
SOURCE_FLAT="$(jq -r '."repo-flat"' "${SOURCE_JSON}")"
if [[ "${SOURCE_FLAT}" == "true" ]]; then
  PLUGINS_ROOT="."
else
  PLUGINS_ROOT="${WORKSPACE}"
fi

REGISTRY="localhost:${REGISTRY_PORT}"
IMAGE_REPOSITORY_PREFIX="${REGISTRY}/rhdh-plugin-export-test"

warn_low_disk_space() {
  local target dir
  target="$(df -Pk "${1}" 2>/dev/null | awk 'NR==2 {print $4}')" || return 0
  dir="$(dirname "${1}")"
  if [[ -z "${target}" ]]; then
    target="$(df -Pk "${dir}" 2>/dev/null | awk 'NR==2 {print $4}')" || return 0
  fi
  # df -Pk reports 1K blocks; 25G ≈ 26214400 blocks
  if [[ "${target}" -lt 26214400 ]]; then
    echo "WARNING: less than ~25 GiB free on ${1} (df reports ${target} 1K blocks)." >&2
    echo "  The backstage workspace needs a full monorepo clone, yarn install, tsc," >&2
  echo "  and OCI builds. Use -d on a larger filesystem, --prune-podman, export a" >&2
  echo "  smaller plugins-list via -f, --no-push for archives-only, or run" >&2
  echo "  ./scripts/local-test-export-reset.sh to reclaim disk (aggressive prune)." >&2
  fi
}

if [[ "${PRUNE_PODMAN}" == "true" ]]; then
  echo "=== Pruning unused podman data (all unused images) ==="
  podman system prune -af
fi

warn_low_disk_space "${WORKDIR}"

echo "=== RHDH plugin export local test ==="
echo "Utils:      ${UTILS_DIR}"
echo "Overlays:   ${OVERLAY_ROOT}"
echo "Plugins:    ${PLUGINS_FILE}"
echo "Source:     ${SOURCE_REPO} @ ${SOURCE_REF}"
echo "Plugins:    ${PLUGINS_ROOT} (repo-flat=${SOURCE_FLAT})"
echo "Builder:    ${BUILDER_IMAGE}"
echo "Workdir:    ${WORKDIR}"
echo "Registry:   ${REGISTRY} (push=${PUSH_OCI})"
echo ""

echo "=== Building export-builder image ==="
OVERLAY_LOCAL_DIR="${OVERLAYS_DIR}" bash "${UTILS_DIR}/scripts/generate-export-builder-config.sh"
podman build \
  --build-arg "NODE_MAJOR=${NODE_MAJOR}" \
  -f "${UTILS_DIR}/build/containerfiles/export-builder.Containerfile" \
  -t "${BUILDER_IMAGE}" \
  "${UTILS_DIR}"

ensure_local_registry() {
  if [[ "${START_REGISTRY}" != "true" ]]; then
    return 0
  fi
  echo "=== Ensuring local OCI registry on port ${REGISTRY_PORT} ==="
  local recreate_registry=false
  if podman container exists "${REGISTRY_NAME}" 2>/dev/null; then
    local network_mode
    network_mode="$(podman inspect -f '{{.HostConfig.NetworkMode}}' "${REGISTRY_NAME}")"
    if [[ "${network_mode}" != "host" ]]; then
      echo "Recreating ${REGISTRY_NAME}: switching from port mapping to host networking"
      podman rm -f "${REGISTRY_NAME}" >/dev/null
      recreate_registry=true
    elif [[ "$(podman inspect -f '{{.State.Running}}' "${REGISTRY_NAME}")" != "true" ]]; then
      podman start "${REGISTRY_NAME}"
    fi
  else
    recreate_registry=true
  fi
  if [[ "${recreate_registry}" == "true" ]]; then
    podman run -d \
      --name "${REGISTRY_NAME}" \
      --network host \
      -e "REGISTRY_HTTP_ADDR=0.0.0.0:${REGISTRY_PORT}" \
      -v "${REGISTRY_VOLUME}:/var/lib/registry" \
      --restart unless-stopped \
      docker.io/library/registry:2
  fi
}

run_local_publish() {
  local staging_root="$1"
  echo "=== Publishing OCI images from staging (host buildah) ==="
  ensure_local_registry
  if ! command -v buildah >/dev/null 2>&1; then
    echo "Error: buildah is required for local publish. Install buildah or use podman." >&2
    exit 1
  fi
  if [[ -z "${RHDH_CLI_CALLER}" ]] || [[ ! -x "${RHDH_CLI_CALLER}" ]]; then
    if command -v rhdh-cli >/dev/null 2>&1; then
      RHDH_CLI_CALLER="$(command -v rhdh-cli)"
    else
      NPM_CONFIG_LOGLEVEL="${NPM_CONFIG_LOGLEVEL:-error}" \
      npm install -g "${CLI_PACKAGE}@${CLI_VERSION}" \
        --ignore-scripts --omit=dev --legacy-peer-deps
      RHDH_CLI_CALLER="$(command -v rhdh-cli)"
    fi
  fi
  buildah login "${REGISTRY}" -u test -p test --tls-verify=false 2>/dev/null || true
  mkdir -p "${DEFAULT_PUBLISH_OUTPUT_DIR}"
  STAGING_ROOT="${staging_root}" \
    INPUTS_IMAGE_REPOSITORY_PREFIX="${IMAGE_REPOSITORY_PREFIX}" \
    INPUTS_IMAGE_TAG_PREFIX="${IMAGE_TAG_PREFIX}" \
    INPUTS_CLI_CALLER="${RHDH_CLI_CALLER}" \
    INPUTS_CONTAINER_BUILD_TOOL=buildah \
    INPUTS_PUSH_CONTAINER_IMAGE=true \
    PUBLISHED_EXPORTS_OUTPUT="${DEFAULT_PUBLISH_OUTPUT_DIR}/published-exports-output" \
    FAILED_EXPORTS_OUTPUT="${DEFAULT_PUBLISH_OUTPUT_DIR}/failed-exports-output" \
    bash "${UTILS_DIR}/scripts/publish-export-staging.sh"
}

if [[ -n "${PUBLISH_ONLY}" ]]; then
  run_local_publish "${PUBLISH_ONLY}"
  exit 0
fi

ensure_local_registry

echo "=== Preparing source checkout ==="
mkdir -p "$(dirname "${WORKDIR}")"
if [[ "${KEEP_WORKDIR}" == "true" ]]; then
  echo "Keeping existing workdir: ${WORKDIR}"
else
  remove_export_workdir "${WORKDIR}"
fi
mkdir -p "${WORKDIR}/archives" "${WORKDIR}/overlay-repo/${WORKSPACE}" "${WORKDIR}/source-repo"

cp -a "${OVERLAY_ROOT}/." "${WORKDIR}/overlay-repo/${WORKSPACE}/"
cp "${PLUGINS_FILE}" "${WORKDIR}/overlay-repo/${WORKSPACE}/plugins-list.yaml"

if [[ ! -d "${WORKDIR}/source-repo/.git" ]]; then
  git clone "${SOURCE_REPO}" "${WORKDIR}/source-repo"
  git -C "${WORKDIR}/source-repo" fetch --depth 1 origin "${SOURCE_REF}" 2>/dev/null || \
    git -C "${WORKDIR}/source-repo" fetch origin "${SOURCE_REF}" 2>/dev/null || true
  git -C "${WORKDIR}/source-repo" checkout -q "${SOURCE_REF}"
elif [[ "${KEEP_WORKDIR}" == "true" ]]; then
  echo "Reusing existing source checkout in ${WORKDIR}/source-repo"
else
  git -C "${WORKDIR}/source-repo" fetch --depth 1 origin "${SOURCE_REF}" 2>/dev/null || \
    git -C "${WORKDIR}/source-repo" fetch origin "${SOURCE_REF}" 2>/dev/null || true
  git -C "${WORKDIR}/source-repo" checkout -q "${SOURCE_REF}"
fi

echo "=== Applying overlay patches and source overlays ==="
bash "${UTILS_DIR}/override-sources/override-sources.sh" \
  "${WORKDIR}/overlay-repo/${WORKSPACE}" \
  "${WORKDIR}/source-repo/${PLUGINS_ROOT}"

SOURCE_WORKDIR="${WORKDIR}/source-repo/${PLUGINS_ROOT}"
if [[ "${PLUGINS_ROOT}" == "." ]]; then
  SOURCE_WORKDIR="${WORKDIR}/source-repo"
fi

CLI_ENV=()
if [[ -n "${RHDH_CLI_CALLER}" ]]; then
  CLI_ENV+=(-e "INPUTS_CLI_CALLER=${RHDH_CLI_CALLER}")
fi

echo "=== Running compile export inside UBI builder (no privileged) ==="
STAGING_DIR="${WORKDIR}/export-staging"
EXPORT_PODMAN_ARGS=(
  run --rm --network host --user 0
  -v "${WORKDIR}:/work:z"
  -v "${UTILS_DIR}:/utils:ro,z"
  -e "GITHUB_WORKSPACE=/work"
  -w "/work/source-repo/${PLUGINS_ROOT}"
)
EXPORT_PODMAN_ARGS+=("${CLI_ENV[@]}")
EXPORT_PODMAN_ARGS+=(-e "NPM_CONFIG_IGNORE_SCRIPTS=true" -e "YARN_ENABLE_SCRIPTS=false")
EXPORT_PODMAN_ARGS+=(-e "NPM_CONFIG_cache=/work/.npm-cache")
EXPORT_PODMAN_ARGS+=(-e "NODE_OPTIONS=--max-old-space-size=8192")

podman "${EXPORT_PODMAN_ARGS[@]}" "${BUILDER_IMAGE}" \
  bash -lc "
    set -euo pipefail
    corepack enable
    yarn --version
    yarn install --immutable
    yarn tsc
    export INPUTS_PLUGINS_FILE='/work/overlay-repo/${WORKSPACE}/plugins-list.yaml'
    export INPUTS_DESTINATION='/work/archives'
    export INPUTS_CLI_PACKAGE='${CLI_PACKAGE}'
    export INPUTS_CLI_VERSION='${CLI_VERSION}'
    export INPUTS_IMAGE_TAG_PREFIX='${IMAGE_TAG_PREFIX}'
    bash /utils/export-dynamic/export-dynamic.sh
    STAGING_ROOT='/work/export-staging' \
      INPUTS_PLUGINS_ROOT='/work/source-repo/${PLUGINS_ROOT}' \
      INPUTS_PLUGINS_FILE='/work/overlay-repo/${WORKSPACE}/plugins-list.yaml' \
      INPUTS_DESTINATION='/work/archives' \
      INPUTS_IMAGE_TAG_PREFIX='${IMAGE_TAG_PREFIX}' \
      bash /utils/export-dynamic/create-export-staging.sh
  "

echo ""
echo "=== Compile export complete ==="
echo "Archives: ${WORKDIR}/archives"
ls -la "${WORKDIR}/archives" 2>/dev/null || true

if [[ "${PUSH_OCI}" == "true" ]]; then
  run_local_publish "${STAGING_DIR}"
  if [[ -f "${DEFAULT_PUBLISH_OUTPUT_DIR}/published-exports-output" ]]; then
    echo ""
    echo "Published OCI images:"
    cat "${DEFAULT_PUBLISH_OUTPUT_DIR}/published-exports-output"
  fi
  echo ""
  echo "Registry catalog (${REGISTRY}):"
  curl -s "http://${REGISTRY}/v2/_catalog" | jq . 2>/dev/null || \
    echo "(install jq or inspect with: curl -s http://${REGISTRY}/v2/_catalog)"
  echo ""
  echo "Pull example:"
  echo "  buildah pull --tls-verify=false ${IMAGE_REPOSITORY_PREFIX}/<plugin-name>:${IMAGE_TAG_PREFIX}<version>"
fi

echo ""
echo "Tip: ./scripts/local-test-export-reset.sh reclaims disk (workdir, test images, podman prune -af)."
