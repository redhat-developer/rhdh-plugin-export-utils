#!/usr/bin/env bash
# Empty OCI / dist-dynamic payload checks. Sourced by export-dynamic.sh.

EMPTY_DYNAMIC_PACKAGES_ANNOTATION='W10=' # base64("[]")

_require_skopeo() {
    if ! command -v skopeo >/dev/null 2>&1; then
        echo "[ERROR] Skopeo is required to check OCI artifacts - install skopeo to continue. Must exit!" >&2
        exit 1
    fi
}

_is_json() {
    jq -e . >/dev/null 2>&1
}

# Exit 0 = empty, 1 = has payload.
is_empty_dynamic_packages_annotation() {
    local value="${1:-}"
    local trimmed decoded parsed

    trimmed=$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [[ -z "$trimmed" ]]; then
        return 0
    fi
    if [[ "$trimmed" == "$EMPTY_DYNAMIC_PACKAGES_ANNOTATION" ]]; then
        return 0
    fi

    # Linux: base64 -d; macOS: base64 -D / --decode
    if ! decoded=$(printf '%s' "$trimmed" | base64 -d 2>/dev/null \
        || printf '%s' "$trimmed" | base64 -D 2>/dev/null \
        || printf '%s' "$trimmed" | base64 --decode 2>/dev/null); then
        return 1
    fi
    if ! parsed=$(printf '%s' "$decoded" | jq -c . 2>/dev/null); then
        return 1
    fi
    if [[ "$parsed" == "[]" || "$parsed" == "{}" || "$parsed" == "null" ]]; then
        return 0
    fi
    return 1
}

assert_dist_dynamic_payload() {
    local dist_dynamic_dir="${1:-}"
    local pkg_path pkg_name main candidate

    if [[ -z "$dist_dynamic_dir" ]]; then
        echo "dist-dynamic path is required" >&2
        return 1
    fi
    pkg_path="${dist_dynamic_dir}/package.json"
    if [[ ! -f "$pkg_path" ]]; then
        echo "missing ${pkg_path}" >&2
        return 1
    fi
    if ! pkg_name=$(jq -r '.name // empty' "$pkg_path" 2>/dev/null); then
        echo "unreadable ${pkg_path}" >&2
        return 1
    fi
    if [[ -z "$pkg_name" || "$pkg_name" != *-dynamic ]]; then
        echo "package name must end with -dynamic (got ${pkg_name:-'(empty)'})" >&2
        return 1
    fi

    main=$(jq -r '.main // empty' "$pkg_path" 2>/dev/null | sed 's|^\./||')
    for candidate in \
        "${dist_dynamic_dir}/dist/index.cjs.js" \
        "${dist_dynamic_dir}/dist/index.esm.js" \
        "${dist_dynamic_dir}/dist/index.js"
    do
        if [[ -f "$candidate" ]]; then
            return 0
        fi
    done
    if [[ -n "$main" && "$main" == dist/* && -f "${dist_dynamic_dir}/${main}" ]]; then
        return 0
    fi
    if [[ -f "${dist_dynamic_dir}/dist/remoteEntry.js" ]] \
        || [[ -f "${dist_dynamic_dir}/dist/mf-manifest.json" ]]; then
        return 0
    fi
    echo "missing dist-dynamic entry (backend index.* or frontend remoteEntry.js) - empty export" >&2
    return 1
}

# Requires skopeo
_read_dynamic_packages_annotation() {
    local image_ref="$1"
    local transport raw annotation
    local tool="${INPUTS_CONTAINER_BUILD_TOOL:-podman}"

    image_ref="${image_ref#docker://}"
    image_ref="${image_ref#oci://}"

    _require_skopeo

    for transport in \
        "containers-storage:${image_ref}" \
        "docker-daemon:${image_ref}"
    do
        raw=$(skopeo inspect --raw "$transport" 2>/dev/null || true)
        if [[ -z "$raw" ]] || ! printf '%s' "$raw" | _is_json; then
            continue
        fi
        annotation=$(printf '%s' "$raw" | jq -r '.annotations["io.backstage.dynamic-packages"] // empty' 2>/dev/null)
        if [[ -n "$annotation" ]]; then
            printf '%s' "$annotation"
            return 0
        fi
        printf ''
        return 0
    done

    if command -v "$tool" >/dev/null 2>&1; then
        annotation=$("$tool" image inspect \
            --format '{{index .Annotations "io.backstage.dynamic-packages"}}' \
            "$image_ref" 2>/dev/null || true)
        if [[ -z "$annotation" || "$annotation" == "<no value>" ]]; then
            annotation=$("$tool" image inspect \
                --format '{{index .Config.Labels "io.backstage.dynamic-packages"}}' \
                "$image_ref" 2>/dev/null || true)
        fi
        if [[ -n "$annotation" && "$annotation" != "<no value>" ]]; then
            printf '%s' "$annotation"
            return 0
        fi
    fi
    return 1
}

# Requires skopeo
_assert_local_image_index_json() {
    local image_ref="$1"
    local tool="${INPUTS_CONTAINER_BUILD_TOOL:-podman}"
    local tmpdir archive extract_root layer_hash blob index_path payload_len oci_archive inspect_json

    _require_skopeo

    tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/rhdh-export-oci-verify.XXXXXX") || return 1
    archive="${tmpdir}/img.tar"
    extract_root="${tmpdir}/extract"

    if ! skopeo copy "containers-storage:${image_ref}" "oci-archive:${archive}" >/dev/null 2>&1 \
        && ! skopeo copy "docker-daemon:${image_ref}" "oci-archive:${archive}" >/dev/null 2>&1; then
        if ! "$tool" save -o "$archive" "$image_ref" >/dev/null 2>&1; then
            echo "failed to copy local image ${image_ref} for deep check" >&2
            rm -rf "$tmpdir"
            return 1
        fi
        oci_archive="${tmpdir}/img.oci.tar"
        if ! skopeo copy "docker-archive:${archive}" "oci-archive:${oci_archive}" >/dev/null 2>&1; then
            echo "failed to convert image ${image_ref} to oci-archive for deep check" >&2
            rm -rf "$tmpdir"
            return 1
        fi
        archive="$oci_archive"
    fi

    inspect_json=$(skopeo inspect --no-tags "oci-archive:${archive}" 2>/dev/null || true)
    if [[ -z "$inspect_json" ]] || ! printf '%s' "$inspect_json" | _is_json; then
        echo "skopeo inspect failed or returned non-JSON for ${image_ref}" >&2
        rm -rf "$tmpdir"
        return 1
    fi
    layer_hash=$(printf '%s' "$inspect_json" | jq -r '.Layers[0] // empty' | sed 's/^sha256://')
    if [[ -z "$layer_hash" ]]; then
        echo "no layers in OCI artifact ${image_ref}" >&2
        rm -rf "$tmpdir"
        return 1
    fi
    mkdir -p "$extract_root"
    tar xf "$archive" -C "$extract_root"
    blob="${extract_root}/blobs/sha256/${layer_hash}"
    if [[ ! -f "$blob" ]]; then
        echo "missing layer blob ${layer_hash}" >&2
        rm -rf "$tmpdir"
        return 1
    fi
    mkdir -p "${tmpdir}/layer"
    if ! tar xzf "$blob" -C "${tmpdir}/layer" 2>/dev/null && ! tar xf "$blob" -C "${tmpdir}/layer" 2>/dev/null; then
        echo "failed to unpack plugin layer" >&2
        rm -rf "$tmpdir"
        return 1
    fi
    index_path="${tmpdir}/layer/index.json"

    if [[ ! -f "$index_path" ]]; then
        echo "index.json missing in plugin layer" >&2
        rm -rf "$tmpdir"
        return 1
    fi
    payload_len=$(jq 'length' "$index_path" 2>/dev/null || echo 0)
    if [[ ! "$payload_len" =~ ^[0-9]+$ ]] || [[ "$payload_len" -eq 0 ]]; then
        echo "index.json is empty in plugin layer" >&2
        rm -rf "$tmpdir"
        return 1
    fi
    rm -rf "$tmpdir"
    return 0
}

# Requires skopeo
assert_local_plugin_image() {
    local image_ref="${1:-}"
    local annotation

    if [[ -z "$image_ref" ]]; then
        echo "image ref is required" >&2
        return 1
    fi
    image_ref="${image_ref#docker://}"
    image_ref="${image_ref#oci://}"

    _require_skopeo

    if annotation=$(_read_dynamic_packages_annotation "$image_ref"); then
        if is_empty_dynamic_packages_annotation "$annotation"; then
            echo "empty artifact (empty io.backstage.dynamic-packages annotation) for ${image_ref}" >&2
            return 1
        fi
        return 0
    fi

    echo "  annotation unreadable for ${image_ref}; falling back to layer index.json check" >&2
    _assert_local_image_index_json "$image_ref"
}
