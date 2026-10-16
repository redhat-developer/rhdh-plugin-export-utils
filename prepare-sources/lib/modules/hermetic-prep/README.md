# hermetic-prep

Prepares the workspace for hermetic (network-isolated) Konflux builds by
removing fields and scripts that would require network access or a parent
monorepo checkout.

## Problem

Two common `package.json` patterns break once a workspace is isolated for
downstream builds:

1. **`packageManager`** (e.g. `"packageManager": "yarn@4.9.2"`) causes
   Corepack to download that Yarn version. Hermetic builds have no network,
   so the download fails. This module first ensures Yarn is pinned via
   `.yarnrc.yml` `yarnPath` (downloading from `packageManager` when needed,
   same as sync-midstream), then removes the `packageManager` field.

2. **Monorepo `postinstall` scripts** that run `cd ../../ && yarn install`
   expect the parent monorepo root (and often `workspaces/repo-tools/`). In
   the prepared workspace / OCI artifact there is no parent monorepo, so those
   scripts fail.

## What the module does

1. **Ensure Yarn binary** (same as sync-midstream Loop 2): if `.yarnrc.yml`
   `yarnPath` is missing or the file is absent, derive the version from root
   `packageManager` (`yarn@X.Y.Z`), download the binary from
   `repo.yarnpkg.com`, and set `yarnPath`.
2. **Root `packageManager`:** If the workspace root `package.json` defines
   `packageManager`, delete that field and rewrite the file.
3. **Monorepo `postinstall`:** Walk every `package.json` under the workspace
   (skipping `node_modules/`). Remove `scripts.postinstall` when it matches
   the monorepo pattern:
   - the script string contains `cd ../../ && yarn install`, **or**
   - the script is a relative path starting with `./` and that file contains
     `cd ../../ && yarn install`.

Non-matching `postinstall` scripts are left unchanged. Overlay files are not
modified.
