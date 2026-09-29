# hermetic-prep

Prepares the workspace for hermetic (network-isolated) Konflux builds by
removing fields and scripts that would require network access or a parent
monorepo checkout.

## Problem

Two common `package.json` patterns break once a workspace is isolated for
downstream builds:

1. **`packageManager`** (e.g. `"packageManager": "yarn@4.9.2"`) causes
   Corepack to download that Yarn version. Hermetic builds have no network,
   so the download fails. Yarn must already be pinned via `.yarnrc.yml`
   `yarnPath` (typically established earlier by `make-self-contained`).

2. **Monorepo `postinstall` scripts** that run `cd ../../ && yarn install`
   expect the parent monorepo root (and often `workspaces/repo-tools/`). In
   the prepared workspace / OCI artifact there is no parent monorepo, so those
   scripts fail.

## What the module does

- **Root `packageManager`:** If the workspace root `package.json` defines
  `packageManager`, delete that field and rewrite the file.

- **Monorepo `postinstall`:** Walk every `package.json` under the workspace
  (skipping `node_modules/`). Remove `scripts.postinstall` when it matches
  the monorepo pattern:
  - the script string contains `cd ../../ && yarn install`, **or**
  - the script is a relative path starting with `./` and that file contains
    `cd ../../ && yarn install`.

Non-matching `postinstall` scripts are left unchanged. Overlay files are not
modified.
