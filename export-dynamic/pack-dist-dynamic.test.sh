#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=export-dynamic/pack-dist-dynamic.sh
source "${SCRIPT_DIR}/pack-dist-dynamic.sh"

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

WORKDIR=$(mktemp -d /tmp/pack-dist-dynamic-test-XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

FIXTURE="${WORKDIR}/dist-dynamic"
DEST="${WORKDIR}/archives"
STAGE="${WORKDIR}/staged"

mkdir -p "${FIXTURE}/node_modules/dup"
cat > "${FIXTURE}/package.json" <<'EOF'
{
  "name": "test-hardlink-pack",
  "version": "1.0.0",
  "bundleDependencies": true
}
EOF
printf 'payload\n' > "${FIXTURE}/payload.txt"
# Same inode in two paths, matching Yarn hardlinks-local under node_modules.
ln "${FIXTURE}/payload.txt" "${FIXTURE}/node_modules/dup/payload.txt"

orig_hardlinks=$(find "$FIXTURE" -type f -links +1 | wc -l)
assert_true "fixture has hardlinked files" test "${orig_hardlinks}" -gt 0

copy_dist_dynamic_without_hardlinks "$FIXTURE" "$STAGE"
staged_hardlinks=$(find "$STAGE" -type f -links +1 | wc -l)
assert_eq "staged copy has no hardlinked files" "0" "${staged_hardlinks}"

after_copy_orig=$(find "$FIXTURE" -type f -links +1 | wc -l)
assert_eq "original tree still has hardlinks after copy" "${orig_hardlinks}" "${after_copy_orig}"

json=$(pack_dist_dynamic "$FIXTURE" "$DEST")
filename=$(echo "$json" | jq -r '.[0].filename')
integrity=$(echo "$json" | jq -r '.[0].integrity')

assert_true "npm pack returned a filename" test -n "$filename"
assert_true "tgz exists in destination" test -f "${DEST}/${filename}"
assert_true "integrity is non-empty" test -n "$integrity"

echo "$integrity" > "${DEST}/${filename}.integrity"
assert_true "integrity sidecar is written" test -f "${DEST}/${filename}.integrity"

after_pack_orig=$(find "$FIXTURE" -type f -links +1 | wc -l)
assert_eq "original tree still has hardlinks after pack" "${orig_hardlinks}" "${after_pack_orig}"

echo "All pack-dist-dynamic tests passed."
