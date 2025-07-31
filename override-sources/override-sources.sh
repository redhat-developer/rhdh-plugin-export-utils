#!/bin/bash
set -e

# Absolute path to the overlay root directory (patches directory will be overlay-root/patches)
OVERLAY_ROOT_DIR="$1" 

# Expected to be "." if CWD is already the target, or an absolute path to cd into
TARGET_APPLY_DIR_ARG="$2"

# Construct the patches directory path
PATCHES_SOURCE_DIR="${OVERLAY_ROOT_DIR}/patches"

echo "=== Override Sources Script ==="
echo "  Overlay root: ${OVERLAY_ROOT_DIR}"
echo "  Source of patches: ${PATCHES_SOURCE_DIR}"

EFFECTIVE_TARGET_APPLY_DIR=$(pwd)
PUSHED_DIR=false # Flag to track if we actually changed directory

# Cleanup function to ensure we pop back if a directory was pushed
_cleanup() {
  if [ "$PUSHED_DIR" = true ]
  then
    popd > /dev/null
  fi
}
trap _cleanup EXIT 

if [[ -f "${OVERLAY_ROOT_DIR}/backstage.json" ]]
then
  echo "Overriding backstage.json file"
  cp -fv "${OVERLAY_ROOT_DIR}/backstage.json" "${TARGET_APPLY_DIR_ARG}/backstage.json"
fi

if [[ "${TARGET_APPLY_DIR_ARG}" != "." ]]
then
  if [ ! -d "$TARGET_APPLY_DIR_ARG" ]
  then
    echo "Error: Specified target directory for applying patches ($TARGET_APPLY_DIR_ARG) does not exist."
    exit 1
  fi
  pushd "$TARGET_APPLY_DIR_ARG" > /dev/null
  PUSHED_DIR=true
  echo "  Changed working directory to: $(pwd) for applying patches"
else
  echo "  Applying patches in current working directory: $(pwd)"
fi

if [[ ! -d "$PATCHES_SOURCE_DIR" ]]
then
  echo "Patches directory ($PATCHES_SOURCE_DIR) not found. Skipping patching."
  # Output 0 patches applied for GitHub Actions
  if [[ "$GITHUB_OUTPUT" != "" ]]; then
    echo "PATCHES_APPLIED=0" >> $GITHUB_OUTPUT
  fi
  exit 0
fi

# Find and sort .patch files to ensure ordered application
readarray -t PATCH_FILES < <(find "$PATCHES_SOURCE_DIR" -maxdepth 1 -type f -name "*.patch" | sort)

if [ ${#PATCH_FILES[@]} -eq 0 ]
then
  echo "No .patch files found in $PATCHES_SOURCE_DIR. Skipping patching."
  # Output 0 patches applied for GitHub Actions
  if [[ "$GITHUB_OUTPUT" != "" ]]; then
    echo "PATCHES_APPLIED=0" >> $GITHUB_OUTPUT
  fi
  exit 0
fi

echo "Found patch files to apply in $(pwd):"
printf "  - %s\n" "${PATCH_FILES[@]}"

PATCHES_APPLIED=0
for patch_file in "${PATCH_FILES[@]}"; do
  echo "Attempting to apply patch: $patch_file"
  if git apply --check "$patch_file"; then
    git apply "$patch_file"
    echo "Successfully applied patch: $patch_file"
    ((++PATCHES_APPLIED))
  else
    echo "Error: Patch $patch_file could not be applied cleanly in $(pwd)." >&2
    exit 1 # Fail if a patch cannot be applied
  fi
done

echo "All ${PATCHES_APPLIED} patches applied successfully in $(pwd)."

# Output number of patches applied for GitHub Actions
if [[ "$GITHUB_OUTPUT" != "" ]]; then
  echo "PATCHES_APPLIED=${PATCHES_APPLIED}" >> $GITHUB_OUTPUT
fi

echo "=== Override Sources Script Finished ==="
exit 0