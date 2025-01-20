#!/bin/bash

errors=()
images=()
IFS=$'\n'

optionalPatch="$(dirname ${INPUTS_PLUGINS_FILE})/${INPUTS_SOURCE_PATCH_FILE_NAME}"
if [ -f "${optionalPatch}" ]
then
    echo "  applying patch on plugin sources"
    patch <${optionalPatch}
    if [ $? -ne 0 ]
    then
        errors+=("${pluginPath}")
        set -e
        popd > /dev/null
        continue
    fi
fi

for plugin in $(cat ${INPUTS_PLUGINS_FILE})
do
    if [[ "$(echo $plugin | sed 's/ *//')" == "" ]]
    then
        echo "Skip empty line"
        continue
    fi
    if [[ "$(echo $plugin | sed 's/^#.*//')" == "" ]]
    then
        echo "Skip commented line"
        continue
    fi
    pluginPath=$(echo $plugin | sed 's/^\(^[^:]*\): *\(.*\)$/\1/')
    args=$(echo $plugin | sed 's/^\(^[^:]*\): *\(.*\)$/\2/')
    
    pushd $pluginPath > /dev/null
    
    if [[ "$(grep -e '"role" *: *"frontend-plugin' package.json)" != "" ]]
    then
        pluginType=frontend
        optionalScalprumConfigFile="$(dirname ${INPUTS_PLUGINS_FILE})/${pluginPath}/${INPUTS_SCALPRUM_CONFIG_FILE_NAME}"
        if [ -f "${optionalScalprumConfigFile}" ]
        then
            args="$args --scalprum-config ${optionalScalprumConfigFile}"
        fi
    else
        pluginType=backend
    fi
    
    echo "========== Exporting $pluginType plugin $pluginPath =========="
    
    optionalSourceOverlay="$(dirname ${INPUTS_PLUGINS_FILE})/${pluginPath}/${INPUTS_SOURCE_OVERLAY_FOLDER_NAME}"
    if [ -d "${optionalSourceOverlay}" ]
    then
        echo "  copying source overlay"
        cp -Rfv ${optionalSourceOverlay}/* .
    fi

    set +e
    echo "  running the 'export-dynamic-plugin' command with args: $args"
    echo "$args" | xargs npx --yes @janus-idp/cli@${INPUTS_JANUS_CLI_VERSION} package export-dynamic-plugin
    if [ $? -ne 0 ]
    then
        errors+=("${pluginPath}")
        set -e
        popd > /dev/null
        continue
    fi

    # package the dynamic plugin in a container image
    if [[ "${INPUTS_IMAGE_REPOSITORY_PREFIX}" != "" ]]
    then
        PLUGIN_NAME=$(jq -r '.name | sub("^@"; "") | sub("[/@]"; "-")' package.json)
        PLUGIN_VERSION="${INPUTS_IMAGE_TAG_PREFIX}$(jq -r '.version' package.json)"
        PLUGIN_CONTAINER_TAG="${INPUTS_IMAGE_REPOSITORY_PREFIX}/${PLUGIN_NAME}:${PLUGIN_VERSION}"

        echo "========== Packaging Container ${PLUGIN_CONTAINER_TAG} =========="
        npx --yes @janus-idp/cli@${INPUTS_JANUS_CLI_VERSION} package package-dynamic-plugins --tag "${PLUGIN_CONTAINER_TAG}"
        if [ $? -eq 0 ] 
        then
            if [[ "${INPUTS_PUSH_CONTAINER_IMAGE}" == "true" ]]
            then
                echo "========== Publishing Container ${PLUGIN_CONTAINER_TAG} =========="
                podman push $PLUGIN_CONTAINER_TAG
                if [ $? -eq 0 ] 
                then
                    images+=("${PLUGIN_CONTAINER_TAG}")
                else
                    echo " Error pushing container image"
                    errors+=("${pluginPath}")
                fi
            else
                    images+=("${PLUGIN_CONTAINER_TAG}")
            fi
        else
            echo " Error building container image"
            errors+=("${pluginPath}")
        fi
    fi

    if [[ "${INPUTS_DESTINATION}" != "" ]]
    then
        echo "========== Moving $pluginType plugin $pluginPath archive into ${INPUTS_DESTINATION} =========="

        packDestination=${INPUTS_DESTINATION}
        mkdir -pv ${packDestination}

        echo "  running npm pack on the exported './dist-dynamic' sub-folder"
        json=$(npm pack ./dist-dynamic --pack-destination $packDestination --json)
        if [ $? -ne 0 ]
        then
            errors+=("${pluginPath}")
            set -e
            popd > /dev/null
            continue
        fi
        set -e
        
        filename=$(echo "$json" | jq -r '.[0].filename')
        integrity=$(echo "$json" | jq -r '.[0].integrity')
        echo "$integrity" > $packDestination/${filename}.integrity
        optionalConfigFile="$(dirname ${INPUTS_PLUGINS_FILE})/${pluginPath}/${INPUTS_APP_CONFIG_FILE_NAME}"
        if [ -f "${optionalConfigFile}" ]
        then
            echo "  copying default app-config"
            cp -v "${optionalConfigFile}" "$packDestination/${filename}.${INPUTS_APP_CONFIG_FILE_NAME}"
        fi
    fi
    set -e
    popd > /dev/null
done
echo "Plugins with failed exports: $errors"

FAILED_EXPORTS_OUTPUT=${FAILED_EXPORTS_OUTPUT:-"failed-exports-output"}
touch $FAILED_EXPORTS_OUTPUT
for error in "${errors[@]}"
do
    echo "$error" >> $FAILED_EXPORTS_OUTPUT
done

PUBLISHED_EXPORTS_OUTPUT=${PUBLISHED_EXPORTS_OUTPUT:-"published-exports-output"}
touch $PUBLISHED_EXPORTS_OUTPUT
for image in "${images[@]}"
do
    echo "$image" >> $PUBLISHED_EXPORTS_OUTPUT
done

if [[ "$GITHUB_OUTPUT" != "" ]]
then
    echo "FAILED_EXPORTS<<EOF" >> $GITHUB_OUTPUT
    cat $FAILED_EXPORTS_OUTPUT >> $GITHUB_OUTPUT
    echo "EOF" >> $GITHUB_OUTPUT

    echo "PUBLISHED_EXPORTS<<EOF" >> $GITHUB_OUTPUT
    cat $PUBLISHED_EXPORTS_OUTPUT >> $GITHUB_OUTPUT
    echo "EOF" >> $GITHUB_OUTPUT
fi
