#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=export-dynamic/verify-registry-artifacts.sh
source "${SCRIPT_DIR}/verify-registry-artifacts.sh"

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

WORKDIR=$(mktemp -d /tmp/verify-artifacts-test-XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

# --- Offline tests using dir: transport ---

# 1. Valid single OCI manifest with dynamic-packages annotation
mkdir -p "${WORKDIR}/valid-pkg"
cat << 'JSON' > "${WORKDIR}/valid-pkg/manifest.json"
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 2
  },
  "layers": [],
  "annotations": {
    "io.backstage.dynamic-packages": "W3sidGVzdC1wbHVnaW4iOnsidmVyc2lvbiI6IjEuMC4wIn19XQ=="
  }
}
JSON

res=0
verify_registry_artifact "${WORKDIR}" "valid-pkg" "1.0.0" "dir" || res=$?
assert_eq "offline: valid manifest accepted" "0" "$res"

# 2. Manifest with empty annotation
mkdir -p "${WORKDIR}/empty-pkg"
cat << 'JSON' > "${WORKDIR}/empty-pkg/manifest.json"
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 2
  },
  "layers": [],
  "annotations": {
    "io.backstage.dynamic-packages": ""
  }
}
JSON

res=0
verify_registry_artifact "${WORKDIR}" "empty-pkg" "1.0.0" "dir" || res=$?
assert_eq "offline: empty annotation rejected" "1" "$res"

# 3. Manifest missing dynamic-packages annotation entirely
mkdir -p "${WORKDIR}/missing-pkg"
cat << 'JSON' > "${WORKDIR}/missing-pkg/manifest.json"
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 2
  },
  "layers": [],
  "annotations": {}
}
JSON

res=0
verify_registry_artifact "${WORKDIR}" "missing-pkg" "1.0.0" "dir" || res=$?
assert_eq "offline: missing annotation rejected" "1" "$res"

# 4. Manifest with empty array annotation (W10= is base64 of "[]")
mkdir -p "${WORKDIR}/empty-arr-pkg"
cat << 'JSON' > "${WORKDIR}/empty-arr-pkg/manifest.json"
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 2
  },
  "layers": [],
  "annotations": {
    "io.backstage.dynamic-packages": "W10="
  }
}
JSON

res=0
verify_registry_artifact "${WORKDIR}" "empty-arr-pkg" "1.0.0" "dir" || res=$?
assert_eq "offline: empty array annotation rejected" "1" "$res"

# 5. Non-existent image/directory
res=0
verify_registry_artifact "${WORKDIR}" "non-existent" "1.0.0" "dir" || res=$?
assert_eq "offline: non-existent target rejected" "1" "$res"

# 6. Image index dereferencing valid child manifest
mkdir -p "${WORKDIR}/index-valid-pkg" "${WORKDIR}/index-valid-pkg_child"
cat << 'JSON' > "${WORKDIR}/index-valid-pkg/manifest.json"
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:childvalid",
      "size": 100
    }
  ]
}
JSON
cat << 'JSON' > "${WORKDIR}/index-valid-pkg_child/manifest.json"
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 2
  },
  "layers": [],
  "annotations": {
    "io.backstage.dynamic-packages": "W3sidGVzdC1wbHVnaW4iOnsidmVyc2lvbiI6IjEuMC4wIn19XQ=="
  }
}
JSON

res=0
verify_registry_artifact "${WORKDIR}" "index-valid-pkg" "1.0.0" "dir" || res=$?
assert_eq "offline: image index with valid child accepted" "0" "$res"

# 7. Image index dereferencing child manifest with empty annotation
mkdir -p "${WORKDIR}/index-empty-pkg" "${WORKDIR}/index-empty-pkg_child"
cat << 'JSON' > "${WORKDIR}/index-empty-pkg/manifest.json"
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:childempty",
      "size": 100
    }
  ]
}
JSON
cat << 'JSON' > "${WORKDIR}/index-empty-pkg_child/manifest.json"
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 2
  },
  "layers": [],
  "annotations": {
    "io.backstage.dynamic-packages": ""
  }
}
JSON

res=0
verify_registry_artifact "${WORKDIR}" "index-empty-pkg" "1.0.0" "dir" || res=$?
assert_eq "offline: image index with empty child annotation rejected" "1" "$res"

# --- Online live tests against real registries (if reachable) ---
if skopeo inspect --raw docker://quay.io/rhdh/red-hat-developer-hub-backstage-plugin-scorecard-backend-module-dependabot:2.0.0--1.1.2 >/dev/null 2>&1; then
    echo "Running online live registry tests..."

    # Broken Quay scorecard image (empty annotation on child manifest, from RHDHBUGS-3834)
    res=0
    verify_registry_artifact "quay.io/rhdh" "red-hat-developer-hub-backstage-plugin-scorecard-backend-module-dependabot" "2.0.0--1.1.1" || res=$?
    assert_eq "online: broken scorecard image on Quay rejected" "1" "$res"

    # Fixed Quay scorecard image (valid annotation on child manifest)
    res=0
    verify_registry_artifact "quay.io/rhdh" "red-hat-developer-hub-backstage-plugin-scorecard-backend-module-dependabot" "2.0.0--1.1.2" || res=$?
    assert_eq "online: fixed scorecard image on Quay accepted" "0" "$res"

    # Valid GHCR image (single OCI manifest)
    res=0
    verify_registry_artifact "ghcr.io/redhat-developer/rhdh-plugin-export-overlays" "backstage-community-plugin-github-actions" "bs_1.54.9__1.4.0" || res=$?
    assert_eq "online: valid GHCR image accepted" "0" "$res"

    # Non-existent image tag
    res=0
    verify_registry_artifact "ghcr.io/redhat-developer/rhdh-plugin-export-overlays" "backstage-community-plugin-github-actions" "bs_1.54.9__99.99.99" || res=$?
    assert_eq "online: non-existent tag rejected" "1" "$res"
else
    echo "Skipping online tests (registry unreachable or network offline)"
fi

echo "All verify-registry-artifacts tests passed."
