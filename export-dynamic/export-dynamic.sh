#!/usr/bin/env bash
#
# Export plugins to dist-dynamic archives (.tgz). OCI image build/push is handled
# separately by scripts/publish-export-staging.sh (export-publish CI job).
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

errors=()
IFS=$'\n'

workspaceOverlayFolder="$(dirname "${INPUTS_PLUGINS_FILE}")"
skipWorkspace=false

INPUTS_CLI_PACKAGE=${INPUTS_CLI_PACKAGE:-"@red-hat-developer-hub/cli"}
EXPORT_COMMAND=("plugin" "export")

if [[ -z "${INPUTS_CLI_CALLER:-}" ]]; then
  INPUTS_CLI_CALLER="$("${SCRIPT_DIR}/resolve-export-cli.sh")"
fi

run_cli() {
    # Phase 2 install: rhdh-cli runs yarn install in dist-dynamic/ where
    # --allow-native-package modules must compile (UBI/Node ABI). Unset phase-1
    # env from the monorepo compile job (NPM_CONFIG_IGNORE_SCRIPTS / YARN_ENABLE_SCRIPTS).
    unset NPM_CONFIG_IGNORE_SCRIPTS YARN_ENABLE_SCRIPTS

    local cli_args=("$@")
    local cli_bin=()

    IFS=" " read -r -a cli_bin <<< "$INPUTS_CLI_CALLER"
    IFS=" " read -r -a cli_args_split <<< "${cli_args[@]}"

    # shellcheck disable=SC2145
    echo "  > ${cli_bin[@]} ${cli_args_split[@]}"
    # shellcheck disable=SC2068
    if ! "${cli_bin[@]}" ${cli_args_split[@]} >/tmp/export-dynamic-cli.log 2>&1; then
        echo "Error running CLI: "
		echo "##########################################################"
        cat /tmp/export-dynamic-cli.log
		echo "##########################################################"

        local yarn_install_logs=("yarn-install.log" "rhdh-cli.yarn-install.log")
        for log_file in "${yarn_install_logs[@]}"; do
            if [[ -f "$log_file" ]]; then
                cat "$log_file"
                echo "##########################################################"
            fi
        done
        return 1
    fi
    rm -f /tmp/export-dynamic-cli.log
    return 0
}

set -e
if [[ "${INPUTS_FORCE_EXPORT:-}" == "true" ]]; then
    echo "Force export enabled — skipping unchanged-since-last-publish check"
elif [[ "${INPUTS_LAST_PUBLISH_COMMIT}" != "" ]]; then
    pushd "${workspaceOverlayFolder}" > /dev/null
    workspaceLastCommit="$(git log -1 --format=%H .)"
    echo "Checking if workspace last commit (${workspaceLastCommit}) is an ancestor of the last published commit (${INPUTS_LAST_PUBLISH_COMMIT})"
    if git merge-base --is-ancestor "${workspaceLastCommit}" "${INPUTS_LAST_PUBLISH_COMMIT}"; then
        skipWorkspace=true
    fi
    popd > /dev/null
fi

if [[ "${skipWorkspace}" == "true" ]]; then
    echo "Skipping workspace since it didn't change since last published commit (${INPUTS_LAST_PUBLISH_COMMIT})"
else
    overlay_backstage_json="${workspaceOverlayFolder}/backstage.json"
    overlay_supported_version=""
    if [[ -f "$overlay_backstage_json" ]]; then
        overlay_supported_version=$(jq -r '.version' "$overlay_backstage_json")
        if [[ "$overlay_supported_version" == "null" ]]; then
            overlay_supported_version=""
        fi
    fi

    while IFS= read -r plugin || [[ -n "$plugin" ]]; do
        if [[ -z "${plugin// /}" ]]; then
            echo "Skip empty line"
            continue
        fi
        # shellcheck disable=SC2001
        if [[ "$(echo "$plugin" | sed 's/^#.*//')" == "" ]]; then
            echo "Skip commented line"
            continue
        fi
        # shellcheck disable=SC2001
        pluginPath=$(echo "$plugin" | sed 's/^\(^[^:]*\): *\(.*\)$/\1/')
        # shellcheck disable=SC2001
        args=$(echo "$plugin" | sed 's/^\(^[^:]*\): *\(.*\)$/\2/')

        if [ ! -d "$pluginPath" ]; then
            echo "Skip missing package folder $pluginPath"
            continue
        fi
        pushd "$pluginPath" > /dev/null

        if [[ "$(grep -e '"role" *: *"frontend-plugin' package.json)" != "" ]]; then
            pluginType=frontend
            optionalScalprumConfigFile="${workspaceOverlayFolder}/${pluginPath}/${INPUTS_SCALPRUM_CONFIG_FILE_NAME}"
            if [[ -f "${optionalScalprumConfigFile}" ]]; then
                args="$args --scalprum-config ${optionalScalprumConfigFile}"
            fi
        else
            pluginType=backend
        fi

        echo "========== Exporting $pluginType plugin $pluginPath =========="

        optionalSourceOverlay="${workspaceOverlayFolder}/${pluginPath}/${INPUTS_SOURCE_OVERLAY_FOLDER_NAME}"
        if [[ -d "${optionalSourceOverlay}" ]]; then
            echo "  copying source overlay"
            cp -Rfv "${optionalSourceOverlay}"/* .
        fi

        set +e
        if ! run_cli "${EXPORT_COMMAND[@]}" "$args"; then
            errors+=("${pluginPath}")
            set -e
            popd > /dev/null
            continue
        fi

        if [[ -n "$overlay_supported_version" ]] && [[ -f "dist-dynamic/package.json" ]]; then
            echo "  Setting supported-versions to ${overlay_supported_version} from overlay backstage.json"
            jq --arg ver "$overlay_supported_version" \
               '.backstage["supported-versions"] = $ver' \
               dist-dynamic/package.json > dist-dynamic/package.json.tmp \
               && mv dist-dynamic/package.json.tmp dist-dynamic/package.json
        fi
        echo

        if [[ "${INPUTS_DESTINATION}" != "" ]]; then
            echo "========== Moving $pluginType plugin $pluginPath archive into ${INPUTS_DESTINATION} =========="

            packDestination=${INPUTS_DESTINATION}
            mkdir -pv "${packDestination}"

            echo "  running npm pack on the exported './dist-dynamic' sub-folder"
            if ! json=$(npm pack ./dist-dynamic --pack-destination "$packDestination" --json); then
                errors+=("${pluginPath}")
                set -e
                popd > /dev/null
                continue
            fi
            set -e

            filename=$(echo "$json" | jq -r '.[0].filename')
            integrity=$(echo "$json" | jq -r '.[0].integrity')
            echo "$integrity" > "$packDestination/${filename}.integrity"
            optionalConfigFile="${workspaceOverlayFolder}/${pluginPath}/${INPUTS_APP_CONFIG_FILE_NAME}"
            if [[ -f "${optionalConfigFile}" ]]; then
                echo "  copying default app-config"
                cp -v "${optionalConfigFile}" "$packDestination/${filename}.${INPUTS_APP_CONFIG_FILE_NAME}"
            fi
        fi
        set -e
        popd > /dev/null
    done < "${INPUTS_PLUGINS_FILE}"
    if [[ ${#errors[@]} -gt 0 ]]; then
        echo "Plugins with failed exports: ${errors[*]}"
    fi
fi

FAILED_EXPORTS_OUTPUT=${FAILED_EXPORTS_OUTPUT:-"failed-exports-output"}
touch "$FAILED_EXPORTS_OUTPUT"
for error in "${errors[@]}"; do
    echo "$error" >> "$FAILED_EXPORTS_OUTPUT"
done

# Write step outputs to a workspace file; the workflow/composite step shell merges
# this into GITHUB_OUTPUT. Writing from a subprocess in container jobs often misses
# the runner's GITHUB_OUTPUT file (empty GITHUB_OUTPUT falls back to /tmp).
EXPORT_STEP_OUTPUTS="${GITHUB_WORKSPACE}/.export-dynamic-outputs"
workspace_skipped_value="false"
if [[ "${skipWorkspace}" == "true" ]]; then
    workspace_skipped_value="${INPUTS_LAST_PUBLISH_COMMIT}"
fi

{
    if [[ -s "$FAILED_EXPORTS_OUTPUT" ]]; then
        echo "failed-exports<<EOF"
        cat "$FAILED_EXPORTS_OUTPUT"
        echo "EOF"
    else
        echo "failed-exports="
    fi
    echo "workspace-skipped-unchanged-since=${workspace_skipped_value}"
} > "$EXPORT_STEP_OUTPUTS"

exit $((${#errors[@]}))
