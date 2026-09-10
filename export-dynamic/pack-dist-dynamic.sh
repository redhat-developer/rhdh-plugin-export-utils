#!/usr/bin/env bash
# Stage dist-dynamic to a short, hardlink-free copy, then npm pack.
#
# Yarn nmMode: hardlinks-local trees crash npm 11 (`Exit handler never called!`).
# `cp -r` (not `cp -a`) copies file contents and breaks those hardlinks.
# A short /tmp prefix also avoids npm pack failures on very long paths (RHDHBUGS-3556).

copy_dist_dynamic_without_hardlinks() {
    local src="$1"
    local dest="$2"

    if [[ ! -d "$src" ]]; then
        echo "  dist-dynamic directory not found: ${src}" >&2
        return 1
    fi
    mkdir -p "$dest" || return 1
    # Copy package contents into dest (not a nested dist-dynamic folder).
    # Do not use cp -a / --preserve=links: that keeps Yarn hardlinks.
    cp -r "${src}/." "${dest}/"
}

pack_dist_dynamic() {
    local dist_dynamic="$1"
    local pack_destination="$2"
    local stage_dir
    local output
    local pack_status=0

    mkdir -p "$pack_destination" || return 1

    stage_dir=$(mktemp -d /tmp/dist-XXXXXX) || return 1
    if ! copy_dist_dynamic_without_hardlinks "$dist_dynamic" "$stage_dir"; then
        rm -rf "$stage_dir"
        return 1
    fi

    # Pack the staged package root (equivalent to `npm pack .` in dist-dynamic).
    output=$(
        cd "$stage_dir" && npm pack --pack-destination "$pack_destination" --json --foreground-scripts=false
    ) || pack_status=$?

    rm -rf "$stage_dir"

    if [[ "$pack_status" -ne 0 ]]; then
        return "$pack_status"
    fi
    printf '%s' "$output"
}
