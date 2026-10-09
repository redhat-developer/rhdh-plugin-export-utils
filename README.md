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
- **Hollow-OCI gates** (see below) so empty exports are not pushed to ghcr.io

#### Hollow / empty OCI payload gates

Before packaging or publishing, `export-dynamic` validates that each plugin has an installable payload:

1. **After `plugin export`** — `dist-dynamic/package.json` must exist, the package name must end with `-dynamic`, and a dist entry must be present: backend `index.cjs.js` / `index.esm.js` / `index.js` (or `main` under `dist/`), or frontend `remoteEntry.js` / `mf-manifest.json`.
2. **After `plugin package`, before push** — the local image must have a non-empty `io.backstage.dynamic-packages` annotation (or, if the annotation cannot be read, a non-empty layer `index.json`).

Failures are recorded in the `failed-exports` output **and the `export-dynamic` action/step fails** (non-zero exit). The image is **not** pushed and is **not** listed in `published-exports`. This applies to export-only runs as well as package/push — a hollow `dist-dynamic` fails before packaging.

If a workspace fails these checks, fix the overlay `plugins-list.yaml` (export args, `--embed-package`, missing packages) and re-run publish. Do not rely on midstream or weekly registry scans as the primary gate.

Helpers live in [`export-dynamic/validate-plugin-payload.sh`](export-dynamic/validate-plugin-payload.sh); unit tests: `bash export-dynamic/validate-plugin-payload.test.sh`.

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