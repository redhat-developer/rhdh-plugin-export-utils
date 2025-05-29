# Override Sources Action

This GitHub Action applies patch files from a specified directory to the workspace.

## Usage

```yaml
- name: Override Sources
  uses: redhat-developer/rhdh-plugin-export-utils/override-sources@main
  with:
    overlay-root: ${{ github.workspace }}/overlay-repo
    workspace-root: .
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `overlay-root` | Absolute path to the overlay root directory (patches directory should be at overlay-root/patches) | Yes | |
| `workspace-root` | Directory to override sources to (use "." for current directory) | No | `.` |

## Outputs

| Output | Description |
|--------|-------------|
| `patches-applied` | Number of patches successfully applied |

## Behavior

- Finds all `.patch` files in the specified patches directory
- Applies patches in alphabetical order by filename
- Uses `git apply` to override sources cleanly
- Fails if any patch cannot be applied
- Outputs the number of patches applied

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