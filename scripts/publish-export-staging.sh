#!/usr/bin/env bash
#
# Build and push OCI images from an export-staging artifact (compile job output).
#
# Env:
#   STAGING_ROOT — unpacked staging directory (required)
#   INPUTS_IMAGE_REPOSITORY_PREFIX — ghcr.io/org/repo (required when pushing)
#   INPUTS_IMAGE_TAG_PREFIX — tag prefix (optional)
#   INPUTS_CLI_CALLER — rhdh-cli command (required)
#   INPUTS_CONTAINER_BUILD_TOOL — buildah (default)
#   INPUTS_PUSH_CONTAINER_IMAGE — true|false (default true)
#   IMAGE_REGISTRY_USER — registry username (default: GITHUB_ACTOR for ghcr.io)
#   IMAGE_REGISTRY_PASSWORD — registry password (use GITHUB_TOKEN for ghcr.io; never logged)
#   GITHUB_WORKSPACE — workspace root for CI step outputs (optional; see PUBLISH_STEP_OUTPUTS)
#   PUBLISH_STEP_OUTPUTS — path for GHA-style step outputs (default: alongside FAILED_EXPORTS_OUTPUT)
#
set -euo pipefail

STAGING_ROOT="${STAGING_ROOT:?STAGING_ROOT is required}"
INPUTS_IMAGE_REPOSITORY_PREFIX="${INPUTS_IMAGE_REPOSITORY_PREFIX:?INPUTS_IMAGE_REPOSITORY_PREFIX is required}"
INPUTS_CONTAINER_BUILD_TOOL="${INPUTS_CONTAINER_BUILD_TOOL:-buildah}"
INPUTS_PUSH_CONTAINER_IMAGE="${INPUTS_PUSH_CONTAINER_IMAGE:-true}"
INPUTS_CLI_CALLER="${INPUTS_CLI_CALLER:-}"

if [[ -z "${INPUTS_CLI_CALLER}" ]]; then
  # shellcheck source=scripts/resolve-export-cli.sh
  INPUTS_CLI_CALLER="$(bash "$(dirname "$0")/resolve-export-cli.sh")"
fi

manifest="${STAGING_ROOT}/manifest.json"
if [[ ! -f "${manifest}" ]]; then
  echo "Error: missing ${manifest}" >&2
  exit 1
fi

IFS=" " read -r -a cli_bin <<< "${INPUTS_CLI_CALLER}"

run_cli() {
  local cli_args=("$@")
  local cli_args_split=()
  IFS=" " read -r -a cli_args_split <<< "${cli_args[*]}"
  echo "  > ${cli_bin[*]} ${cli_args_split[*]}"
  # shellcheck disable=SC2068
  "${cli_bin[@]}" ${cli_args_split[@]}
}

if [[ "${INPUTS_PUSH_CONTAINER_IMAGE}" == "true" ]]; then
  registry="$(echo "${INPUTS_IMAGE_REPOSITORY_PREFIX}" | cut -d/ -f1)"
  registry_user="${IMAGE_REGISTRY_USER:-${GITHUB_ACTOR:-}}"
  if [[ -n "${IMAGE_REGISTRY_PASSWORD:-}" ]]; then
    if [[ -z "${registry_user}" ]]; then
      echo "Error: IMAGE_REGISTRY_PASSWORD is set but no registry username (set IMAGE_REGISTRY_USER or GITHUB_ACTOR)" >&2
      exit 1
    fi
    echo "Logging in to ${registry} as ${registry_user}"
    echo "${IMAGE_REGISTRY_PASSWORD}" | ${INPUTS_CONTAINER_BUILD_TOOL} login "${registry}" \
      -u "${registry_user}" --password-stdin
  fi
fi

errors=()
images=()
image_tag_prefix="$(jq -r '.imageTagPrefix // ""' "${manifest}")"

mapfile -t plugin_paths < <(jq -r '.plugins[].path' "${manifest}")

for pluginPath in "${plugin_paths[@]}"; do
  plugin_dir="${STAGING_ROOT}/plugins/${pluginPath}"
  if [[ ! -d "${plugin_dir}/dist-dynamic" ]]; then
    echo "Error: missing dist-dynamic for ${pluginPath}" >&2
    errors+=("${pluginPath}")
    continue
  fi

  image_name="$(jq -r --arg p "${pluginPath}" \
    '.plugins[] | select(.path == $p) | .imageName' "${manifest}")"
  version="$(jq -r --arg p "${pluginPath}" \
    '.plugins[] | select(.path == $p) | .version' "${manifest}")"
  tag="${INPUTS_IMAGE_REPOSITORY_PREFIX}/${image_name}:${image_tag_prefix}${version}"

  echo "========== Packaging Container ${tag} =========="
  pushd "${plugin_dir}" > /dev/null
  if run_cli plugin package --container-tool "${INPUTS_CONTAINER_BUILD_TOOL}" --tag "${tag}"; then
    if [[ "${INPUTS_PUSH_CONTAINER_IMAGE}" == "true" ]]; then
      echo "========== Publishing Container ${tag} =========="
      if ${INPUTS_CONTAINER_BUILD_TOOL} push "${tag}"; then
        images+=("${tag}")
      else
        errors+=("${pluginPath}")
      fi
    else
      images+=("${tag}")
    fi
  else
    errors+=("${pluginPath}")
  fi
  popd > /dev/null
done

FAILED_EXPORTS_OUTPUT="${FAILED_EXPORTS_OUTPUT:-failed-exports-output}"
PUBLISHED_EXPORTS_OUTPUT="${PUBLISHED_EXPORTS_OUTPUT:-published-exports-output}"
: > "${FAILED_EXPORTS_OUTPUT}"
: > "${PUBLISHED_EXPORTS_OUTPUT}"

for e in "${errors[@]}"; do echo "${e}" >> "${FAILED_EXPORTS_OUTPUT}"; done
for i in "${images[@]}"; do echo "${i}" >> "${PUBLISHED_EXPORTS_OUTPUT}"; done

publish_output_dir="$(dirname "${FAILED_EXPORTS_OUTPUT}")"
mkdir -p "${publish_output_dir}"
PUBLISH_STEP_OUTPUTS="${PUBLISH_STEP_OUTPUTS:-${publish_output_dir}/.publish-export-staging.outputs}"
{
  if [[ -s "${FAILED_EXPORTS_OUTPUT}" ]]; then
    echo "failed-exports<<EOF"
    cat "${FAILED_EXPORTS_OUTPUT}"
    echo "EOF"
  else
    echo "failed-exports="
  fi
  if [[ -s "${PUBLISHED_EXPORTS_OUTPUT}" ]]; then
    echo "published-exports<<EOF"
    cat "${PUBLISHED_EXPORTS_OUTPUT}"
    echo "EOF"
  else
    echo "published-exports="
  fi
} > "${PUBLISH_STEP_OUTPUTS}"

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "Publish failures: ${errors[*]}" >&2
  exit "${#errors[@]}"
fi
