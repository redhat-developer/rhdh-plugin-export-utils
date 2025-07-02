# rhdh-plugin-export-utils
Utilities for exporting backstage plugins as dynamic plugins for installation in Red Hat Developer Hub

## Actions

### export-dynamic

Exports plugins as dynamic plugin archives. Supports per-plugin source overlays and should be run **after** `override-sources` if patch modifications are needed.

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

## Workflow Example

```yaml
jobs:
  export-plugins:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        
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
```