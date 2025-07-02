# Override Sources Action

This GitHub Action applies patch files and source overlay files from a specified directory to the workspace.

## Usage

```yaml
- name: Override Sources
  uses: redhat-developer/rhdh-plugin-export-utils/override-sources@main
  with:
    overlay-root: ${{ github.workspace }}/overlay-repo/workspaces/workspace-name
    workspace-root: .
    # source-overlay-folder-name: overlay  # optional, defaults to "overlay"
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `overlay-root` | Absolute path to the overlay root directory (patches at overlay-root/patches/, plugin overlays in overlay-root/plugins/) | Yes | |
| `workspace-root` | Directory to override sources to (use "." for current directory) | No | `.` |
| `source-overlay-folder-name` | Name of the subfolder within each plugin directory containing files to copy to the workspace | No | `overlay` |

## Outputs

| Output | Description |
|--------|-------------|
| `patches-applied` | Number of patches successfully applied |
| `source-overlay-applied` | Whether source overlay files were applied |

## Behavior

### Patches
- Finds all `*.patch` files in the specified patches directory (`overlay-root/patches/`)
- Applies patches in alphabetical order by filename
- Uses `git apply` to override sources cleanly
- Fails if any patch cannot be applied
- Outputs the number of patches applied

### Source Overlays
- After patches are applied, uses `plugins-list.yaml` to discover plugin directories
- For each plugin directory found, copies files from the overlay subfolder (default: `overlay/`)
- Uses `cp -Rf` (force) to allow overwriting existing files
- Only processes plugins that have both:
  - A corresponding directory in the workspace
  - An overlay subfolder in the overlay repository
- Automatically skips the `patches/` directory when scanning the overlay root
- Provides detailed logging showing which files were copied
- Outputs whether any source overlay files were applied

## Example Workflow Integration

```yaml
- name: Override Sources before building
  uses: redhat-developer/rhdh-plugin-export-utils/override-sources@main
  with:
    overlay-root: ${{ github.workspace }}/overlay-repo/${{ inputs.overlay-root }}
    workspace-root: source-repo/${{ inputs.plugins-root }}

- name: Run yarn install
  run: |
    yarn --version
    yarn install --immutable

- name: Export dynamic plugins
  uses: redhat-developer/rhdh-plugin-export-utils/export-dynamic@main
  with:
    # ... other inputs
``` 