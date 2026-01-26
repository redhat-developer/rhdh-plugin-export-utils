# Validate Catalog Metadata Action

This GitHub Action validates catalog metadata files against plugin `package.json` files to ensure consistency during the dynamic plugin export workflow.

## Validations Performed

For each YAML file in the `metadata/` folder of the overlay workspace, the following checks are performed:

1. **Package Exists**: The `packageName` field in the metadata must correspond to a plugin from `plugins-list.yaml` whose `package.json` has a matching `name` field

2. **Version Match**: The `version` field in the metadata matches the `version` field in the corresponding plugin's `package.json`

3. **OCI Reference Validation** (if `dynamicArtifact` starts with `oci://ghcr.io`):
   - **Tag Format**: The image tag should be `bs_<target backstage version>__<plugin version>`
   - **Reference Format**: The image reference (without tag) should be `<image repository prefix>/<package name with @ and / replaced by ->`

4. **Backstage Supported Versions Match**: The `backstage.supportedVersions` field in the metadata matches the major.minor version of `supportedVersions` in the plugin's `dist-dynamic/package.json`

## Usage

```yaml
- name: Validate Catalog Metadata
  uses: redhat-developer/rhdh-plugin-export-utils/validate-metadata@main
  with:
    overlay-root: ${{ github.workspace }}/overlay-repo/workspaces/my-workspace
    plugins-root: ${{ github.workspace }}/source-repo/workspaces/my-workspace
    target-backstage-version: 1.42.5
    image-repository-prefix: ghcr.io/my-org/my-repo  # Optional
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `overlay-root` | Yes | - | Absolute path to the overlay workspace folder containing `metadata/` and `plugins-list.yaml` |
| `plugins-root` | Yes | - | Absolute path to the source plugins folder containing plugin directories with `package.json` files |
| `target-backstage-version` | Yes | - | Target Backstage version for validating OCI tag format (e.g., "1.42.5") |
| `image-repository-prefix` | No | `""` | Repository prefix for validating OCI reference format in `dynamicArtifact` |

## Outputs

| Output | Description |
|--------|-------------|
| `validation-passed` | Whether the metadata validation passed (`true`/`false`) |
| `validation-errors` | JSON array of validation errors, empty array if validation passed |
| `validation-error-count` | Number of validation errors found |

### JSON Output Format

The `validation-errors` output is a JSON array of error objects. Each error has a `kind` field that determines its structure:

### Error Kinds

#### `mismatch` - Field value doesn't match expected

```json
{
  "kind": "mismatch",
  "file": "plugin-name.yaml",
  "field": "version",
  "expected": "1.2.3",
  "actual": "1.2.0",
  "message": "Version mismatch: expected \"1.2.3\" but got \"1.2.0\""
}
```

#### `missing-field` - Required field is missing

```json
{
  "kind": "missing-field",
  "file": "plugin-name.yaml",
  "field": "spec",
  "message": "Missing required field: spec"
}
```

#### `missing-file` - Required file or directory is missing

```json
{
  "kind": "missing-file",
  "file": "metadata",
  "message": "Metadata directory not found at /path/to/metadata"
}
```

#### `parse-error` - File could not be parsed

```json
{
  "kind": "parse-error",
  "file": "plugin-name.yaml",
  "message": "Failed to parse YAML"
}
```

#### `unknown-package` - Package not found in plugins-list.yaml

```json
{
  "kind": "unknown-package",
  "file": "plugin-name.yaml",
  "packageName": "@org/unknown-plugin",
  "message": "Package \"@org/unknown-plugin\" not found in plugins-list.yaml"
}
```

### Common Properties

| Property | Description |
|----------|-------------|
| `kind` | Error type: `mismatch`, `missing-field`, `missing-file`, `parse-error`, or `unknown-package` |
| `file` | Filename of the metadata file with the validation error |
| `message` | Human-readable description of the validation error |

## Error Reporting

When validation fails, the action:

1. **Writes to GitHub Step Summary**: A detailed markdown table is added to the workflow summary showing all mismatches
2. **Sets Workflow Outputs**: The validation errors are available as JSON for downstream steps
3. **Fails the Workflow**: The step exits with a non-zero code, failing the workflow

## Testing

The `test/` directory contains fixtures for testing the validation action. The test workflow is located at [.github/workflows/test-validate-metadata.yaml](../.github/workflows/test-validate-metadata.yaml), which runs automatically on CI when changes are made to `validate-metadata/**`.

### Running Tests Locally

#### Direct Script Execution

You can test the validation script directly:

```bash
cd validate-metadata

# Install dependencies
npm install

# Run validation (should pass)
INPUTS_OVERLAY_ROOT="$(pwd)/test/cases/pass" \
INPUTS_PLUGINS_ROOT="$(pwd)/test/source" \
INPUTS_IMAGE_REPOSITORY_PREFIX="ghcr.io/test-org/test-repo" \
INPUTS_TARGET_BACKSTAGE_VERSION="1.42.5" \
node validate-metadata.ts
```

#### Using `act` (GitHub Actions Local Runner)

You can use [act](https://github.com/nektos/act) to run the test workflow locally:

```bash
# Run all test jobs
act -W .github/workflows/test-validate-metadata.yaml

# Run a specific test job (e.g., test-validation-pass)
act -j test-validation-pass -W .github/workflows/test-validate-metadata.yaml
```

See [.github/workflows/test-validate-metadata.yaml](../.github/workflows/test-validate-metadata.yaml) for available test jobs.
