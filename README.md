# rhdh-plugin-export-utils
Utilities for exporting backstage plugins as dynamic plugins for installation in Red Hat Developer Hub

## Actions

### export-dynamic

Exports plugins as dynamic plugin archives. This should be run **after** the `override-sources` action in order to support per-plugin source overlays, or if patch modifications are needed.

**Usage:**
```yaml
- name: Export Dynamic Plugins
  uses: ./export-dynamic
  with:
    plugins-root: plugins
    plugins-file: ${{ github.workspace }}/plugins-list.yaml
    destination: ${{ github.workspace }}/archives
```

**Key Features:**
- Exports plugins as dynamic plugin packages
- Handles both frontend and backend plugins
- Optional container image packaging
- Verifies registry artifacts before skipping an unchanged workspace (requires `skopeo`)

**Environment requirements:**

When `last-publish-commit` is provided together with `image-repository-prefix`, the action uses
`skopeo` to verify that all expected container images exist in the registry with valid dynamic
package metadata before deciding to skip an unchanged workspace. If `skopeo` is not available in
that situation, the script exits non-zero and sets `WORKSPACE_SKIPPED_UNCHANGED_SINCE=false` so
that downstream steps treat the workspace as requiring export rather than silently skipping
verification.

`skopeo` is **pre-installed** in both known production environments:

| Environment | Tool availability |
|---|---|
| GitHub Actions `ubuntu-latest` (Ubuntu 24.04) | `skopeo` 1.13+ included by default |
| RHDH Konflux builder image (`builder.Containerfile`) | `skopeo` installed via `dnf` |

If you invoke `export-dynamic.sh` directly in another environment and intend to use the
workspace-skip path with container publishing, install `skopeo` before running the script.

**Tag prefix changes force a full re-export:**

The skip check looks for existing images using the tag prefix from `image-tag-prefix` (set from
`versions.json` in the overlay flow). Because `versions.json` lives outside any workspace folder,
a bump to that file does not appear in the `git merge-base` ancestor check, so every workspace
looks unchanged. However, skopeo then fails to find the images under the new prefix, which
correctly causes every workspace to be re-exported and published on that one run. This is the
intended self-healing behaviour — workspaces that were previously published under the old prefix
now also get tags under the new prefix — but it means that run will be longer than usual.

### override-sources

Applies patches and source overlays to modify plugin sources before export. This should be run **before** the `export-dynamic` action.

**Features:**
- Applies patches from `<overlay-root>/patches/` directory using `git apply`
- Copies source overlay files from `<overlay-root>/plugins/{plugin-name}/overlay/` directories
- Robust error handling and cleanup
- Ordered patch application (by filename)
- Configurable overlay subfolder name (defaults to "overlay")

**Usage:**
```yaml
- name: Override Sources
  uses: ./override-sources
  with:
    overlay-root: ${{ github.workspace }}/my-overlay-repo
    workspace-root: .
```

**Inputs:**
- `overlay-root`: Absolute path to the overlay root directory (expects `patches/` and `plugins/` subdirectories)
- `workspace-root`: Directory to apply changes to (defaults to ".")
- `source-overlay-folder-name`: Name of subfolder within each plugin directory containing overlay files (defaults to "overlay")

**Outputs:**
- `patches-applied`: Number of patches applied
- `source-overlay-applied`: Whether source overlay files were copied

### validate-metadata

Validates catalog metadata files against plugin `package.json` files to ensure consistency. This should be run **after** the `export-dynamic` action.

**Features:**
- Validates `packageName` corresponds to a plugin from `plugins-list.yaml`
- Validates `version` matches the plugin's `package.json` version
- Validates OCI reference format in `dynamicArtifact` (tag and repository prefix)
- Validates `backstage.supportedVersions` matches major.minor of `dist-dynamic/package.json`
- Reports detailed errors to GitHub workflow summary
- Provides JSON output for downstream workflow consumption

**Usage:**
```yaml
- name: Validate Catalog Metadata
  uses: ./validate-metadata
  with:
    overlay-root: ${{ github.workspace }}/overlay-repo/workspaces/my-workspace
    plugins-root: ${{ github.workspace }}/source-repo/workspaces/my-workspace
    target-backstage-version: 1.42.5
    image-repository-prefix: ghcr.io/my-org/my-repo  # Optional
```

**Inputs:**
- `overlay-root`: Absolute path to the overlay workspace folder containing `metadata/` and `plugins-list.yaml`
- `plugins-root`: Absolute path to the source plugins folder containing plugin directories with `package.json` files
- `target-backstage-version`: Target Backstage version for validating OCI tag format
- `image-repository-prefix`: Repository prefix for validating OCI reference format (optional)

**Outputs:**
- `validation-passed`: Whether the metadata validation passed (`true`/`false`)
- `validation-errors`: JSON array of validation errors (see [validate-metadata/README.md](validate-metadata/README.md) for format details)
- `validation-error-count`: Number of validation errors found

## Workflow Example

```yaml
jobs:
  export-plugins:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        
      - name: Override Sources (apply patches and overlays)
        uses: ./override-sources
        with:
          overlay-root: ${{ github.workspace }}/overlay-repo
          workspace-root: .
          
      - name: Export Dynamic Plugins
        uses: ./export-dynamic
        with:
          plugins-root: plugins
          plugins-file: ${{ github.workspace }}/plugins-list.yaml
          destination: ${{ github.workspace }}/archives

      - name: Validate Catalog Metadata
        uses: ./validate-metadata
        with:
          overlay-root: ${{ github.workspace }}/overlay-repo
          plugins-root: ${{ github.workspace }}/plugins
```