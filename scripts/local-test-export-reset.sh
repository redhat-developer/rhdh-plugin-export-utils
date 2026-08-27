#!/usr/bin/env bash
#
# Reset local state created by scripts/local-test-export.sh so the next run
# starts from a clean slate.
#
# Usage:
#   ./scripts/local-test-export-reset.sh
#   ./scripts/local-test-export-reset.sh --purge-builder
#   ./scripts/local-test-export-reset.sh --keep-registry
#   ./scripts/local-test-export-reset.sh --no-prune
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/local-test-export-common.sh
source "${SCRIPT_DIR}/local-test-export-common.sh"

WORKDIR="${WORKDIR:-${DEFAULT_EXPORT_WORKDIR}}"
REGISTRY_NAME="${REGISTRY_NAME:-rhdh-export-local-registry}"
REGISTRY_VOLUME="${REGISTRY_VOLUME:-${REGISTRY_NAME}-data}"
REGISTRY_PORT="${REGISTRY_PORT:-5001}"
BUILDER_IMAGE="${BUILDER_IMAGE:-localhost/rhdh-plugin-export-builder:ubi9-node24}"
IMAGE_REPOSITORY_PREFIX="localhost:${REGISTRY_PORT}/rhdh-plugin-export-test"

KEEP_REGISTRY=false
PURGE_BUILDER=false
PRUNE_PODMAN=true

usage() {
  cat <<'EOF'
Reset local plugin export test state.

By default removes:
  - build/generated/ in this repo (export-builder config from local-test-export.sh)
  - The test workdir (clones, node_modules, archives, export-staging)
  - Publish result files in ~/tmp/rhdh-plugin-export-publish-output/
  - The local registry container (fresh catalog on next test run)
  - Locally cached test plugin images (localhost:5001/rhdh-plugin-export-test/*)
  - All unused podman images and build cache (podman system prune -af)

Options:
  --keep-registry    Leave the registry container running (only clear workdir/images)
  --purge-builder    Also remove export-builder images (ubi9-node* tags)
  --no-prune         Skip aggressive podman prune (keeps unrelated unused images)
  -d, --workdir DIR  Workdir to remove (default: ~/tmp/rhdh-plugin-export-test)
  -h, --help         Show this help

Environment (same as local-test-export.sh):
  WORKDIR, REGISTRY_NAME, REGISTRY_PORT, BUILDER_IMAGE

Warning: default prune removes ALL unused podman images on this machine, not only
export-test artifacts. Use --no-prune if you rely on other local podman images.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-registry) KEEP_REGISTRY=true; shift ;;
    --purge-builder) PURGE_BUILDER=true; shift ;;
    --no-prune) PRUNE_PODMAN=false; shift ;;
    -d|--workdir) WORKDIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# The export container entrypoint may leave root-owned files on the bind mount.

echo "=== Resetting local plugin export test state ==="

if [[ -d "${BUILD_GENERATED_DIR}" ]]; then
  echo "Removing repo-generated builder config: ${BUILD_GENERATED_DIR}"
  remove_build_generated "${BUILD_GENERATED_DIR}"
else
  echo "Repo-generated builder config not present: ${BUILD_GENERATED_DIR}"
fi

if [[ -d "${WORKDIR}" ]]; then
  echo "Removing workdir: ${WORKDIR}"
  remove_export_workdir "${WORKDIR}"
else
  echo "Workdir not present: ${WORKDIR}"
fi

if [[ -d "${DEFAULT_PUBLISH_OUTPUT_DIR}" ]]; then
  echo "Removing publish output dir: ${DEFAULT_PUBLISH_OUTPUT_DIR}"
  rm -rf "${DEFAULT_PUBLISH_OUTPUT_DIR}"
fi

if [[ "${KEEP_REGISTRY}" == "true" ]]; then
  echo "Keeping registry container: ${REGISTRY_NAME}"
else
  if podman container exists "${REGISTRY_NAME}" 2>/dev/null; then
    echo "Stopping and removing registry container: ${REGISTRY_NAME}"
    podman rm -f "${REGISTRY_NAME}" >/dev/null
  else
    echo "Registry container not present: ${REGISTRY_NAME}"
  fi
  if podman volume exists "${REGISTRY_VOLUME}" 2>/dev/null; then
    echo "Removing registry data volume: ${REGISTRY_VOLUME}"
    podman volume rm "${REGISTRY_VOLUME}" >/dev/null
  fi
fi

echo "Removing local test plugin images: ${IMAGE_REPOSITORY_PREFIX}/*"
mapfile -t test_images < <(podman images --format '{{.Repository}}:{{.Tag}}' \
  | grep -E "^${IMAGE_REPOSITORY_PREFIX}/" || true)
if [[ ${#test_images[@]} -gt 0 ]]; then
  podman rmi -f "${test_images[@]}"
else
  echo "  (none found)"
fi

if [[ "${PURGE_BUILDER}" == "true" ]]; then
  mapfile -t builder_images < <(podman images --format '{{.Repository}}:{{.Tag}}' \
    | grep -E '^localhost/rhdh-plugin-export-builder:ubi9(-node[0-9]+)?$' || true)
  if [[ ${#builder_images[@]} -gt 0 ]]; then
    echo "Removing export-builder images:"
    podman rmi -f "${builder_images[@]}"
  elif podman image exists "${BUILDER_IMAGE}" 2>/dev/null; then
    echo "Removing export-builder image: ${BUILDER_IMAGE}"
    podman rmi -f "${BUILDER_IMAGE}"
  else
    echo "Builder image not present: ${BUILDER_IMAGE}"
  fi
else
  echo "Keeping export-builder image(s) (use --purge-builder to remove)"
fi

if [[ "${PRUNE_PODMAN}" == "true" ]]; then
  echo ""
  echo "=== Aggressive podman prune (all unused images and build cache) ==="
  podman system prune -af
  echo "Podman prune complete."
else
  echo ""
  echo "Skipping podman prune (--no-prune)."
fi

echo ""
echo "Done. Run ./scripts/local-test-export.sh for a fresh test."
