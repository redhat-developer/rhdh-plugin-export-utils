# rhdh-plugin-export-utils

Utilities for exporting backstage plugins as dynamic plugins for installation in Red Hat Developer Hub

## Security model and split export pipeline

Plugin export compiles **untrusted upstream source** (arbitrary git refs and
`yarn.lock` dependencies). OCI publish only packages pre-built `dist-dynamic`
artifacts (`FROM scratch` + `COPY`) and is much lower risk.

The `export-dynamic.yaml` reusable workflow splits work across three jobs:

| Job | Runner | Privileged | Registry secrets | What runs |
|-----|--------|------------|------------------|-----------|
| `export-compile` | `export-builder:ubi9-node{N}` | **no** | **no** | checkout, `override-sources`, monorepo `yarn install` (scripts **off**), `tsc`, `rhdh-cli plugin export` (per-plugin `dist-dynamic` install, scripts **on**), `.tgz` archives, catalog metadata validation (`continue-on-error`) |
| `export-publish` | `ubuntu-latest` + privileged `docker run` of `export-builder` | **no** | yes (`GITHUB_TOKEN` + `github.actor` for ghcr) | download staging artifact, baked `rhdh-cli plugin package`, `buildah push` |
| `export-metadata-gate` | `ubuntu-latest` | **no** | **no** | fails the workflow when compile-time metadata validation reported errors (OCI images already pushed — same semantics as `main`) |

`export-workspaces-as-dynamic` **prepare** reads branch `versions.json` and passes
`export-builder-image` and `cli-caller` into **both** compile and publish jobs. Bumping `cli` in
`versions.json` requires rebuilding the export-builder images
(`publish-export-builder` workflow).

### Two-phase `yarn install` and native dependencies

Compile runs **two separate installs** with different script policies:

| Phase | When | Purpose | Install scripts |
|-------|------|---------|-----------------|
| **Monorepo** | Before `yarn tsc` | Resolve workspace deps for TypeScript | **Disabled** (`NPM_CONFIG_IGNORE_SCRIPTS`, `YARN_ENABLE_SCRIPTS=false`) |
| **Per-plugin export** | Inside `rhdh-cli plugin export` (`dist-dynamic/`) | Production deps bundled into the dynamic plugin | **Enabled** (default; `export-dynamic.sh` unsets phase-1 env before calling the CLI) |

Phase 1 skips install scripts on purpose: the job checks out **untrusted upstream**
source and a large `yarn.lock`. Running every package `postinstall` there would
execute arbitrary code across the whole monorepo. Phase 1 only needs enough of
the tree for `yarn tsc` — not a full native build of every optional transitive
(e.g. `cpu-features` from `ssh2`).

Phase 2 is narrower: `rhdh-cli` derives a `package.json` in `dist-dynamic/`,
copies `yarn.lock`, and runs `yarn install` for **one plugin’s** production
dependencies. Allowed native modules compile here on the **UBI 9 / Node** ABI
(the export-builder image includes gcc, openssl, etc.).

**Per-plugin native policy** is already configured in overlay `plugins-list.yaml`
via `rhdh-cli` export flags (not a separate workspace toggle):

- `--allow-native-package <name>` — include and build a required native module
  (e.g. `isolated-vm` on `plugins/scaffolder-backend`)
- `--suppress-native-package <name>` — replace an optional native dep with a stub
  (e.g. `cpu-features` on `plugins/techdocs-backend`)

Frontend-only workspaces (e.g. `tech-radar`) typically need no `--allow-native-package`.
Backend workspaces with natives are validated by exporting `workspaces/backstage`.

## Export builder image (UBI 9)

Plugin exports that include native Node modules (for example `isolated-vm` in
`@backstage/plugin-scaffolder-backend`) must be built on the same RHEL/UBI ABI as
the RHDH runtime. The **compile** job runs inside a UBI 9 Node.js builder image.

- **Containerfile:** `build/containerfiles/export-builder.Containerfile`
- **Published images:** `ghcr.io/redhat-developer/rhdh-plugin-export-utils/export-builder:ubi9-node24` (and `:ubi9-node22` when needed)
- **Legacy alias:** `:ubi9` → `:ubi9-node24` (deprecated; remove after one release cycle)
- **Manifest:** `/etc/rhdh-export-builder/manifest.json` — baked `@red-hat-developer-hub/cli` versions per Node major
- **Generator:** `scripts/generate-export-builder-config.sh` (reads overlay branch `versions.json`)
- **Publish workflow:** `.github/workflows/publish-export-builder.yaml`

Each Node-major image pre-installs CLI versions from active overlay release
branches (`main`, `release-1.10`, …). No runtime `npx` in CI compile jobs.

CLI versions are installed from the **npm registry** (not `rhdh-cli` source +
`yarn.lock`). Installs use `--legacy-peer-deps` and `NPM_CONFIG_LOGLEVEL=error`
to avoid noisy peer-dependency warnings from `@backstage/cli` transitive deps.

When RHDH migrates to UBI 10, add a `:ubi10-node{N}` image tag family. The split
job structure stays the same.

### Local end-to-end test

`scripts/local-test-export.sh` mirrors CI: builds the export-builder image for the
Node major in `versions.json`, runs **compile** inside the builder container
(without `--privileged`), then **publish** on the host with buildah.

Default workdir: `~/tmp/rhdh-plugin-export-test` (override with `-d` or `WORKDIR`).

```bash
# Default: tech-radar workspace (small smoke test)
./scripts/local-test-export.sh

# Compile only — archives and staging, no OCI push
./scripts/local-test-export.sh --compile-only

# Publish OCI from a prior staging directory
./scripts/local-test-export.sh --publish-only ~/tmp/rhdh-plugin-export-test/export-staging

# Use the plugins-list.yaml from your overlays PR branch
./scripts/local-test-export.sh -f workspaces/backstage/plugins-list.yaml

# Point at a non-default overlays checkout (e.g. your PR branch)
./scripts/local-test-export.sh -o ../rhdh-plugin-export-overlays \
  -f workspaces/backstage/plugins-list.yaml

# Use a local rhdh-cli binary (publish step; compile uses baked CLI in image)
./scripts/local-test-export.sh --rhdh-cli /path/to/rhdh-cli

# Archives only — skip registry and OCI push (same as --no-push / --compile-only)
./scripts/local-test-export.sh --no-registry
```

`-f` accepts any `plugins-list.yaml` — including one with export CLI arguments
(`--allow-native-package`, `--embed-package`, etc.) exactly as committed in
`rhdh-plugin-export-overlays`. The file is copied into the workspace overlay
before export, matching CI.

#### How this compares to CI (`export-dynamic.yaml`)

Per **workspace**, both CI and this script:

1. Clone upstream **once**, apply overlay **once**, `override-sources` **once**
2. `yarn install` + `yarn tsc` **once** on the monorepo (compile job / builder container)
3. `export-dynamic.sh` loops `plugins-list.yaml` — per-plugin `rhdh-cli export` (including `yarn install` in each `dist-dynamic/`), write `.tgz` archives
4. **Publish job** (CI) or host `publish-export-staging.sh` (local) packages `dist-dynamic` with buildah

`--keep-workdir` reuses clone and `node_modules` when iterating.

#### Disk space (backstage workspace)

Plan for **~25 GiB free** on the workdir and container storage filesystem.

```bash
./scripts/local-test-export.sh --no-push -f workspaces/backstage/plugins-list.yaml
./scripts/local-test-export.sh --prune-podman -f workspaces/backstage/plugins-list.yaml
WORKDIR=/mnt/big/rhdh-plugin-export-backstage ./scripts/local-test-export-reset.sh
```

Reset local state (workdir, `build/generated/`, registry, test images, **aggressive `podman system prune -af`**):

```bash
./scripts/local-test-export-reset.sh
./scripts/local-test-export-reset.sh --purge-builder   # also remove the builder image
./scripts/local-test-export-reset.sh --no-prune        # keep other unused podman images
```

Requires `podman`, `buildah` (for OCI publish), `git`, and `jq`. Expects
`rhdh-plugin-export-overlays` as a sibling directory (or set `OVERLAYS_DIR` / `-o`).

Pull an image from the local registry:

```bash
buildah pull --tls-verify=false localhost:5001/rhdh-plugin-export-test/<plugin-name>:local__<version>
```

The builder entrypoint (`export-builder-entrypoint`) fixes GHA workspace ownership
then drops to UID 1001. The compile container does **not** need `--privileged`.

OCI publish runs the **export-builder image** via a privileged `docker run` on the
host runner (GHA service containers cannot run buildah — no user namespaces for
rootless mode). Local `local-test-export.sh` uses host buildah for convenience.
The local registry uses **host networking** on port `5001`.

For ghcr.io on GitHub Actions, publish authenticates with **`secrets.GITHUB_TOKEN`**
as the password and **`github.actor`** as the username (password via stdin only;
never passed on the command line).

### Lint workflow files locally

Before pushing workflow changes, run [actionlint](https://github.com/rhysd/actionlint) via:

```bash
./scripts/lint-workflows.sh
```

Lint specific files or enable shellcheck integration:

```bash
./scripts/lint-workflows.sh .github/workflows/export-dynamic.yaml
./scripts/lint-workflows.sh --shellcheck
```

The script uses `actionlint` from `PATH` when installed; otherwise it downloads a
pinned binary to `.cache/` (gitignored). This catches invalid expressions and many
`uses:` / context mistakes early. It does not replace a fork smoke test for nested
workflow permissions or registry access.

### Testing on a fork (GitHub Actions)

Local `scripts/local-test-export.sh` does not exercise GHA container jobs, artifact
handoff, or ghcr permissions. Use your **export-utils fork** to run the same
workflows as production without merging to upstream `main`.

#### 1. Publish export-builder images on your fork

Push your branch, then run **Publish export builder image**
(`.github/workflows/publish-export-builder.yaml`) via **Actions → Run workflow**.

Images are pushed to:

`ghcr.io/<your-user>/rhdh-plugin-export-utils/export-builder:ubi9-node24`

Confirm the package appears under your fork’s **Packages** tab before exporting.

#### 2. Smoke test the export pipeline (export-utils fork only)

On the same branch, run **Smoke test export pipeline**
(`.github/workflows/test-export-smoke.yaml`):

| Input | Default (smoke workflow) | Notes |
|-------|--------------------------|-------|
| `workspace-path` | `workspaces/tech-radar` | Use a small workspace first |
| `overlay-repo` | `redhat-developer/rhdh-plugin-export-overlays` | |
| `overlay-branch` | `main` | |
| `publish-container` | **`true`** | Push OCI images to your fork’s ghcr |
| `force-export` | **`true`** | Export even if unchanged since last publish |
| `skip-metadata-validation` | **`false`** | Same as production/overlays; set `true` to test compile+publish only |
| `export-builder-ghcr-image` | leave empty (uses your fork’s ghcr) | |

Set **`force-export: true`** (smoke workflow default) so plugins are exported and
OCI images are pushed even when the overlay workspace is unchanged since a prior
release (`last-publish-commit` optimization).

Metadata validation runs in the compile job (against post-`override-sources` trees)
and fails the workflow in a gate job **after** OCI publish — matching `main`
semantics. Use **`skip-metadata-validation: true`** only when you want to exercise
compile and publish without metadata checks (e.g. incomplete metadata on a large
workspace).

The smoke workflow calls the same reusable workflows as production, using:

- Your fork’s export-builder image (via `export-builder-ghcr-image`)
- Same-repo workflow and composite action paths (this commit, not upstream `@main`)
- Your fork’s ghcr for OCI plugin images when `publish-container` is true (default)

CLI equivalent:

```bash
# Default smoke run (tech-radar, publish OCI, metadata validation enabled):
gh workflow run test-export-smoke.yaml --ref ubi9-experiment

# Compile only (no ghcr push):
gh workflow run test-export-smoke.yaml \
  --ref ubi9-experiment \
  -f publish-container=false

# Skip metadata validation (e.g. workspaces/backstage with incomplete metadata):
gh workflow run test-export-smoke.yaml \
  --ref ubi9-experiment \
  -f workspace-path=workspaces/backstage \
  -f skip-metadata-validation=true
```

#### 3. Optional — test from your overlays fork

Upstream overlays keeps calling `redhat-developer/rhdh-plugin-export-utils@main`
until your PR merges. To mimic `/publish` on a fork, create a branch on your
**overlays fork** that points at your export-utils branch and passes fork overrides:

```yaml
jobs:
  export:
    uses: <your-user>/rhdh-plugin-export-utils/.github/workflows/export-workspaces-as-dynamic.yaml@<your-branch>
    with:
      overlay-branch: main
      workspace-path: workspaces/tech-radar
      publish-container: true
      export-builder-ghcr-image: ghcr.io/<your-user>/rhdh-plugin-export-utils/export-builder
      export-utils-repository: <your-user>/rhdh-plugin-export-utils
      export-utils-ref: <your-branch>
      image-repository-prefix: ghcr.io/<your-user>/<your-overlays-fork>
    secrets:
      image-registry-password: ${{ secrets.GITHUB_TOKEN }}
```

Then run the overlays **Export Workspace as Dynamic Plugins Packages** workflow
via `workflow_dispatch`.

#### Operational notes

- **Upstream is unaffected** until export-utils merges and overlays updates its
  `uses:` pin (if needed). Fork runs push plugin images only to **your** ghcr.
- **Reusable workflow inputs** `export-builder-ghcr-image`, `export-utils-repository`,
  and `export-utils-ref` default to upstream production values so existing overlays
  callers behave unchanged.
- After merge to upstream, run **Publish export builder image** once on
  `redhat-developer/rhdh-plugin-export-utils` before overlays `/publish` uses the
  new compile job.

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

- Handles both frontend and backend plugins
- Optional `staging-root` packs outputs for `publish-export-staging.sh` (OCI publish job)

### override-sources

Applies patches and source overlays to modify plugin sources before export. This should be run **before** the `export-dynamic` action.

**Features:**

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

- `workspace-root`: Directory to apply changes to (defaults to ".")
- `source-overlay-folder-name`: Name of subfolder within each plugin directory containing overlay files (defaults to "overlay")

**Outputs:**

- `source-overlay-applied`: Whether source overlay files were copied

### validate-metadata

Validates catalog metadata files against plugin `package.json` files to ensure consistency. This should be run **after** the `export-dynamic` action.

**Features:**

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

- `plugins-root`: Absolute path to the source plugins folder containing plugin directories with `package.json` files
- `target-backstage-version`: Target Backstage version for validating OCI tag format
- `image-repository-prefix`: Repository prefix for validating OCI reference format (optional)

**Outputs:**

- `validation-errors`: JSON array of validation errors (see [validate-metadata/README.md](validate-metadata/README.md) for format details)
- `validation-error-count`: Number of validation errors found

## Workflow Example

```yaml
jobs:
  export-compile:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/redhat-developer/rhdh-plugin-export-utils/export-builder:ubi9-node24
    env:
      NPM_CONFIG_IGNORE_SCRIPTS: "true"
      YARN_ENABLE_SCRIPTS: "false"
      INPUTS_CLI_CALLER: /opt/rhdh-cli/1.10.7/bin/rhdh-cli
    steps:
      - uses: actions/checkout@v6
      - uses: ./override-sources
        with:
          overlay-root: ${{ github.workspace }}/overlay-repo
          workspace-root: .
      - run: yarn install --immutable && yarn tsc
      - uses: ./export-dynamic
        with:
          plugins-root: plugins
          plugins-file: ${{ github.workspace }}/plugins-list.yaml
          destination: ${{ github.workspace }}/archives
          staging-root: ${{ github.workspace }}/export-staging
          image-tag-prefix: bs_1.48.3__
          cli-caller: /opt/rhdh-cli/1.10.7/bin/rhdh-cli

  export-publish:
    needs: export-compile
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: export-staging
          path: export-staging
      - run: sudo apt-get install -y buildah
      - run: npm install -g @red-hat-developer-hub/cli@1.10.7 --ignore-scripts --omit=dev --legacy-peer-deps
        env:
          NPM_CONFIG_LOGLEVEL: error
      - run: bash scripts/publish-export-staging.sh
        env:
          STAGING_ROOT: ${{ github.workspace }}/export-staging
          INPUTS_IMAGE_REPOSITORY_PREFIX: ghcr.io/my-org/my-repo
          INPUTS_CLI_CALLER: $(command -v rhdh-cli)
          INPUTS_CONTAINER_BUILD_TOOL: buildah
```
