#!/usr/bin/env bash

# script to shorten a plugin name or object reference to something that won't fail in openshift due to string length limits
# for example, given 
#    backstage-community-plugin-catalog-backend-module-scaffolder-relation-processor 
# we return
#    bcp-ctlg-backend-mod-scaffolder-relation-processor

# to use this in your scripts
# source shorten-component-name.sh; shorter_name=$(shorten backstage-community-plugin-catalog-backend-module-scaffolder-relation-processor)
# or
# ./shorten-component-name.sh backstage-community-plugin-catalog-backend-module-scaffolder-relation-processor

function shorten {
    local componentNameShort
    componentNameShort="$1"
    componentNameShort="${componentNameShort/rhdh-plugin-catalog--/}"
    componentNameShort="${componentNameShort/red-hat-developer-hub-/rhdh-}"
    componentNameShort="${componentNameShort/backstage-community-plugin/bcp}"
    componentNameShort="${componentNameShort/backstage-plugin/bsp}"
    componentNameShort="${componentNameShort/backstage/bs}"
    componentNameShort="${componentNameShort/plugin/plgn}"
    componentNameShort="${componentNameShort/catalog/ctlg}"
    componentNameShort="${componentNameShort/module/mod}"
    componentNameShort="${componentNameShort/kubernetes/k8s}"
    componentNameShort="${componentNameShort/bitbucket/bbckt}"
    echo "${componentNameShort}"
}

if [[ $1 ]]; then 
    shorten "$1"
fi
