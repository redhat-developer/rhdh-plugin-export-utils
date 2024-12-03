#!/bin/bash

errors=''
packDestination=${INPUTS_DESTINATION}
mkdir -pv ${packDestination}
IFS=$'\n'
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
        args="$args --no-in-place"
        
        optionalScalprumConfigFile="$(dirname ${INPUTS_PLUGINS_FILE})/${pluginPath}/${INPUTS_SCALPRUM_CONFIG_FILE_NAME}"
        if [ -f "${optionalScalprumConfigFile}" ]
        then
            args="$args --scalprum-config ${optionalScalprumConfigFile}"
        fi
        
    else
        pluginType=backend
        args="$args --embed-as-dependencies"
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
        errors="${errors}\n${pluginPath}"
        set -e
        popd > /dev/null
        continue
    fi

    # package the dynamic plugin in a container image
    if [ "${INPUTS_BASE_IMAGE_TAG_NAME}" ]
    then
        PLUGIN_NAME=$(grep -o  '"name":\s*".*"' package.json  | cut -d' ' -f2-| sed 's/"//g; s/\//-/g; s/@//g')
        PLUGIN_VERSION=$(grep -o  '"version":\s*".*"' package.json  | cut -d' ' -f2- | sed 's/"//g; s/^://g')
        PLUGIN_CONTAINER_TAG="${INPUTS_BASE_IMAGE_TAG_NAME}/${PLUGIN_NAME}:${PLUGIN_VERSION}"
        echo "========== Packaging Container ${PLUGIN_CONTAINER_TAG} =========="

        npx --yes @janus-idp/cli@${INPUTS_JANUS_CLI_VERSION} package package-dynamic-plugins --tag $PLUGIN_CONTAINER_TAG
        if [ $? -eq 0 ] 
        then
            echo "========== Publishing Container ${PLUGIN_CONTAINER_TAG} =========="
            podman push $PLUGIN_CONTAINER_TAG
        else
            echo " Error building container image"
        fi
    fi

    echo "  running npm pack on the exported './dist-dynamic' sub-folder"
    json=$(npm pack ./dist-dynamic --pack-destination $packDestination --json)
    if [ $? -ne 0 ]
    then
        errors="${errors}\n${pluginPath}"
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
    popd > /dev/null
done
echo "Plugins with failed exports: $errors"
echo "ERRORS=$errors" >> $GITHUB_OUTPUT
