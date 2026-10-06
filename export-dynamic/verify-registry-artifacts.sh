#!/usr/bin/env bash
# Verifies that a container image exists in the registry and contains valid,
# non-empty dynamic package metadata (io.backstage.dynamic-packages).
#
# Supports both single-architecture OCI manifests (e.g. GHCR) and multi-architecture
# image indexes / manifest lists (e.g. Quay/Konflux) by dereferencing child manifests.

verify_registry_artifact() {
    local repo_prefix="$1"
    local plugin_name="$2"
    local version="$3"
    local transport="${4:-docker}"

    local target="${transport}://${repo_prefix}/${plugin_name}:${version}"
    if [[ "$transport" == "dir" ]]; then
        target="dir:${repo_prefix}/${plugin_name}"
    fi

    local raw_manifest
    raw_manifest=$(skopeo inspect --raw "${target}" 2>/dev/null) || raw_manifest=""
    # If the image is an index/manifest list without direct annotations, resolve the first child manifest
    if [[ -n "$raw_manifest" ]] && ! echo "$raw_manifest" | jq -e '.annotations["io.backstage.dynamic-packages"]' >/dev/null 2>&1 && echo "$raw_manifest" | jq -e '.manifests != null' >/dev/null 2>&1; then
        local child_digest
        child_digest=$(echo "$raw_manifest" | jq -r '.manifests[0].digest // empty')
        if [[ -n "$child_digest" ]]; then
            local child_target="${transport}://${repo_prefix}/${plugin_name}@${child_digest}"
            if [[ "$transport" == "dir" ]]; then
                child_target="dir:${repo_prefix}/${plugin_name}_child"
            fi
            raw_manifest=$(skopeo inspect --raw "${child_target}" 2>/dev/null) || raw_manifest=""
        fi
    fi

    if [[ -z "$raw_manifest" ]] || ! echo "$raw_manifest" | jq -e '.annotations["io.backstage.dynamic-packages"] | @base64d | fromjson | length > 0' >/dev/null 2>&1; then
        return 1
    fi
    return 0
}
