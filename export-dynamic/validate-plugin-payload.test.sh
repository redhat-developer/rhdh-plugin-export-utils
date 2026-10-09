#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=export-dynamic/validate-plugin-payload.sh
source "${SCRIPT_DIR}/validate-plugin-payload.sh"

assert_eq() {
    local description="$1"
    local expected="$2"
    local actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "PASS: ${description}"
    else
        echo "FAIL: ${description} (expected '${expected}', got '${actual}')" >&2
        exit 1
    fi
}

assert_true() {
    local description="$1"
    shift
    if "$@"; then
        echo "PASS: ${description}"
    else
        echo "FAIL: ${description}" >&2
        exit 1
    fi
}

assert_false() {
    local description="$1"
    shift
    if "$@"; then
        echo "FAIL: ${description} (expected failure)" >&2
        exit 1
    else
        echo "PASS: ${description}"
    fi
}

WORKDIR=$(mktemp -d /tmp/validate-plugin-payload-test-XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

# --- is_hollow_dynamic_packages_annotation ---
assert_true "null/blank is hollow" is_hollow_dynamic_packages_annotation ""
assert_true "whitespace is hollow" is_hollow_dynamic_packages_annotation "   "
assert_true "W10= sentinel is hollow" is_hollow_dynamic_packages_annotation "W10="
empty_list_b64=$(printf '[]' | base64)
assert_true "base64([]) is hollow" is_hollow_dynamic_packages_annotation "$empty_list_b64"
empty_obj_b64=$(printf '{}' | base64)
assert_true "base64({}) is hollow" is_hollow_dynamic_packages_annotation "$empty_obj_b64"
payload_b64=$(printf '[{"plugin":{"name":"@scope/pkg-dynamic","version":"1.0.0"}}]' | base64)
assert_false "non-empty package list is healthy" is_hollow_dynamic_packages_annotation "$payload_b64"
assert_false "non-base64 junk is not treated as hollow" is_hollow_dynamic_packages_annotation "not-base64!!!"

# --- assert_dist_dynamic_payload ---
missing_dir="${WORKDIR}/missing"
mkdir -p "$missing_dir"
assert_false "missing package.json fails" assert_dist_dynamic_payload "$missing_dir"

bad_name="${WORKDIR}/bad-name"
mkdir -p "${bad_name}/dist"
printf '%s\n' '{"name":"@scope/pkg","version":"1.0.0"}' > "${bad_name}/package.json"
printf 'module.exports = {};\n' > "${bad_name}/dist/index.cjs.js"
assert_false "name without -dynamic suffix fails" assert_dist_dynamic_payload "$bad_name"

no_entry="${WORKDIR}/no-entry"
mkdir -p "${no_entry}/dist"
printf '%s\n' '{"name":"@scope/pkg-dynamic","version":"1.0.0"}' > "${no_entry}/package.json"
assert_false "missing dist entry fails" assert_dist_dynamic_payload "$no_entry"

good_cjs="${WORKDIR}/good-cjs"
mkdir -p "${good_cjs}/dist"
printf '%s\n' '{"name":"@scope/pkg-dynamic","version":"1.0.0"}' > "${good_cjs}/package.json"
printf 'module.exports = {};\n' > "${good_cjs}/dist/index.cjs.js"
assert_true "good dist-dynamic with index.cjs.js passes" assert_dist_dynamic_payload "$good_cjs"

good_main="${WORKDIR}/good-main"
mkdir -p "${good_main}/dist"
printf '%s\n' '{"name":"@scope/pkg-dynamic","version":"1.0.0","main":"dist/custom.js"}' > "${good_main}/package.json"
printf 'module.exports = {};\n' > "${good_main}/dist/custom.js"
assert_true "good dist-dynamic with pkg.main under dist/ passes" assert_dist_dynamic_payload "$good_main"

good_frontend="${WORKDIR}/good-frontend"
mkdir -p "${good_frontend}/dist"
printf '%s\n' '{"name":"@scope/pkg-dynamic","version":"1.0.0","main":"src/index.ts"}' > "${good_frontend}/package.json"
printf '// mf\n' > "${good_frontend}/dist/remoteEntry.js"
assert_true "good frontend dist-dynamic with remoteEntry.js passes" assert_dist_dynamic_payload "$good_frontend"

# --- assert_local_plugin_image (usage / offline only) ---
assert_false "empty image ref fails" assert_local_plugin_image ""

# --- optional Gate 2 smoke with local podman images (skipped if podman unavailable) ---
run_oci_smoke() {
    local smoke_dir good_ann hollow_tag good_tag
    if ! command -v podman >/dev/null 2>&1; then
        echo "SKIP: OCI smoke (podman not installed)"
        return 0
    fi
    if ! podman info >/dev/null 2>&1; then
        echo "SKIP: OCI smoke (podman not running)"
        return 0
    fi

    smoke_dir=$(mktemp -d /tmp/validate-plugin-payload-oci-XXXXXX)
    hollow_tag="localhost/rhdh-hollow-smoke:test"
    good_tag="localhost/rhdh-good-smoke:test"
    # cleanup images + dir even on failure
    # shellcheck disable=SC2064
    trap "podman rmi -f '${hollow_tag}' '${good_tag}' >/dev/null 2>&1 || true; rm -rf '${smoke_dir}'; rm -rf '${WORKDIR}'" EXIT

    good_ann=$(printf '[{"plugin":{"name":"@x/y-dynamic","version":"1.0.0"}}]' | base64 | tr -d '\n')
    cat > "${smoke_dir}/Containerfile" <<'EOF'
FROM scratch
COPY index.json /
EOF

    printf '[]\n' > "${smoke_dir}/index.json"
    podman build --quiet --no-cache \
        --annotation "io.backstage.dynamic-packages=W10=" \
        -t "${hollow_tag}" -f "${smoke_dir}/Containerfile" "${smoke_dir}" >/dev/null

    printf '[{"name":"@x/y-dynamic"}]\n' > "${smoke_dir}/index.json"
    podman build --quiet --no-cache \
        --annotation "io.backstage.dynamic-packages=${good_ann}" \
        -t "${good_tag}" -f "${smoke_dir}/Containerfile" "${smoke_dir}" >/dev/null

    assert_false "Gate2 rejects hollow W10= image" assert_local_plugin_image "${hollow_tag}"
    assert_true "Gate2 accepts image with non-empty dynamic-packages" assert_local_plugin_image "${good_tag}"
}

run_oci_smoke

echo "All validate-plugin-payload tests passed."
