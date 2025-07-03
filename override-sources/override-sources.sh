#!/bin/bash
set -e

# Absolute path to the overlay root directory (patches directory will be overlay-root/patches)
OVERLAY_ROOT_DIR="$1" 

# Expected to be "." if CWD is already the target, or an absolute path to cd into
TARGET_APPLY_DIR_ARG="$2"

# Name of the overlay subdirectory (defaults to "overlay" if not provided)
SOURCE_OVERLAY_FOLDER_NAME="${3:-overlay}"

# Construct the patches directory path
PATCHES_SOURCE_DIR="${OVERLAY_ROOT_DIR}/patches"

# Construct the source overlay directory path using the configurable folder name
SOURCE_OVERLAY_DIR="${OVERLAY_ROOT_DIR}/${SOURCE_OVERLAY_FOLDER_NAME}"

echo "=== Override Sources Script ==="
echo "  Overlay root: ${OVERLAY_ROOT_DIR}"
echo "  Source of patches: ${PATCHES_SOURCE_DIR}"
echo "  Source overlay folder: ${SOURCE_OVERLAY_DIR}"

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

# Apply source overlays after patches
if [[ -d "$SOURCE_OVERLAY_DIR" ]]; then
  echo "Found source overlay directory: $SOURCE_OVERLAY_DIR"
  echo "Copying source overlay files to $(pwd)..."
  
  # Copy overlay files, preserving structure
  if cp -Rfv "${SOURCE_OVERLAY_DIR}"/* .; then
    echo "Source overlay files copied successfully."
    SOURCE_OVERLAY_APPLIED=true
  else
    echo "Error: Failed to copy source overlay files." >&2
    exit 1
  fi
else
  echo "No source overlay directory found at $SOURCE_OVERLAY_DIR. Skipping overlay copy."
  SOURCE_OVERLAY_APPLIED=false
fi

# Output number of patches applied for GitHub Actions
if [[ "$GITHUB_OUTPUT" != "" ]]; then
  echo "PATCHES_APPLIED=${PATCHES_APPLIED}" >> $GITHUB_OUTPUT
  echo "SOURCE_OVERLAY_APPLIED=${SOURCE_OVERLAY_APPLIED}" >> $GITHUB_OUTPUT
fi

echo "=== Override Sources Script Finished ==="
exit 0