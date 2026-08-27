#!/usr/bin/env bash
#
# Pack export outputs into a staging directory for the publish job.
#
# Env:
#   STAGING_ROOT          — output directory (required)
#   INPUTS_PLUGINS_FILE   — plugins-list.yaml path (required)
#   INPUTS_PLUGINS_ROOT   — absolute path to monorepo plugins root (required)
#   INPUTS_DESTINATION    — dynamic-plugin-archives folder (optional)
#   INPUTS_IMAGE_TAG_PREFIX — OCI tag prefix (optional)
#   INPUTS_APP_CONFIG_FILE_NAME — default app-config.dynamic.yaml
#   WORKSPACE_OVERLAY_FOLDER — overlay workspace folder (dirname of plugins file)
#
set -euo pipefail

STAGING_ROOT="${STAGING_ROOT:?STAGING_ROOT is required}"
INPUTS_PLUGINS_FILE="${INPUTS_PLUGINS_FILE:?INPUTS_PLUGINS_FILE is required}"
INPUTS_PLUGINS_ROOT="${INPUTS_PLUGINS_ROOT:?INPUTS_PLUGINS_ROOT is required}"
INPUTS_APP_CONFIG_FILE_NAME="${INPUTS_APP_CONFIG_FILE_NAME:-app-config.dynamic.yaml}"
WORKSPACE_OVERLAY_FOLDER="${WORKSPACE_OVERLAY_FOLDER:-$(dirname "${INPUTS_PLUGINS_FILE}")}"

rm -rf "${STAGING_ROOT}"
mkdir -p "${STAGING_ROOT}/plugins" "${STAGING_ROOT}/overlay" "${STAGING_ROOT}/archives"

if [[ -d "${WORKSPACE_OVERLAY_FOLDER}" ]]; then
  cp -a "${WORKSPACE_OVERLAY_FOLDER}/." "${STAGING_ROOT}/overlay/"
fi

plugins_json='[]'

while IFS= read -r plugin || [[ -n "${plugin}" ]]; do
  if [[ -z "${plugin// /}" ]]; then
    continue
  fi
  if [[ "$(echo "$plugin" | sed 's/^#.*//')" == "" ]]; then
    continue
  fi
  pluginPath=$(echo "$plugin" | sed 's/^\(^[^:]*\): *\(.*\)$/\1/')
  if [[ ! -d "${INPUTS_PLUGINS_ROOT}/${pluginPath}" ]]; then
    continue
  fi
  if [[ ! -d "${INPUTS_PLUGINS_ROOT}/${pluginPath}/dist-dynamic" ]]; then
    echo "Warning: skipping ${pluginPath} (no dist-dynamic)" >&2
    continue
  fi

  dest="${STAGING_ROOT}/plugins/${pluginPath}"
  mkdir -p "$(dirname "${dest}")"
  cp -a "${INPUTS_PLUGINS_ROOT}/${pluginPath}/." "${dest}/"

  name="$(jq -r '.name' "${INPUTS_PLUGINS_ROOT}/${pluginPath}/package.json")"
  version="$(jq -r '.version' "${INPUTS_PLUGINS_ROOT}/${pluginPath}/package.json")"
  image_name="$(jq -r '.name | sub("^@"; "") | sub("[/@]"; "-")' \
    "${INPUTS_PLUGINS_ROOT}/${pluginPath}/package.json")"

  plugins_json="$(echo "${plugins_json}" | jq \
    --arg path "${pluginPath}" \
    --arg name "${name}" \
    --arg version "${version}" \
    --arg imageName "${image_name}" \
    '. + [{path: $path, name: $name, version: $version, imageName: $imageName}]')"
done < "${INPUTS_PLUGINS_FILE}"

if [[ -n "${INPUTS_DESTINATION:-}" && -d "${INPUTS_DESTINATION}" ]]; then
  cp -a "${INPUTS_DESTINATION}/." "${STAGING_ROOT}/archives/" 2>/dev/null || true
fi

jq -n \
  --argjson plugins "${plugins_json}" \
  --arg imageTagPrefix "${INPUTS_IMAGE_TAG_PREFIX:-}" \
  --arg appConfigFileName "${INPUTS_APP_CONFIG_FILE_NAME}" \
  '{
    plugins: $plugins,
    imageTagPrefix: $imageTagPrefix,
    appConfigFileName: $appConfigFileName
  }' > "${STAGING_ROOT}/manifest.json"

echo "Created export staging at ${STAGING_ROOT} ($(echo "${plugins_json}" | jq length) plugins)"
