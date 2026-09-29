# hermetic-prep

Prepares the workspace for hermetic (network-isolated) Konflux builds by
removing fields and scripts that would require network access or a parent
monorepo checkout.

**Pipeline position:** after `package-cleanup`, before `inject-build-tools` —
see `modules.ts` for the current ordering.

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

## Design choices

- **Filesystem-only I/O** — same contract as other pipeline modules: read and
  write under `ctx.workspacePath`, no in-memory pipeline state.
- **Node built-ins only** — JSON parse/stringify and recursive directory walk
  instead of `jq` / `find` / `grep`.
- **Stable JSON rewrite** — `JSON.stringify(..., null, 2)` plus a trailing
  newline, matching other modules.
- **Root-only `packageManager` strip** — matches `sync-midstream.sh`, which
  only deletes the field from the workspace root `package.json`, not nested
  packages.
- **Fuller postinstall detection than `batchExportPlugins.sh`** — that script
  only checks the inline script string; this module follows
  `sync-midstream.sh`'s `has_monorepo_postinstall` and also inspects external
  `./…` script files.

## Differences from sync-midstream.sh

Source behaviors live in `rhdh-plugin-catalog` `build/ci/sync-midstream.sh`:

| Behavior                     | Bash                                                                                        | This module                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Strip `packageManager`       | Inline in Loop 2, after ensuring `yarnPath` (may download Yarn from `packageManager` first) | Deletes the field only. YarnPath / binary download is **not** here — it belongs to earlier modules (`make-self-contained`). |
| Strip monorepo `postinstall` | `remove_postinstall_scripts` at the start of `install_tsc_build`                            | Same detection rules, run as part of this single module.                                                                    |
| When they run                | Two separate call sites in Loop 2                                                           | Combined into one pipeline step before `inject-build-tools` / `build`.                                                      |
| Logging                      | Special message when multiple matching postinstalls exist                                   | Logs each removal with a workspace-relative path.                                                                           |

This is a clean TypeScript rewrite of the _outcomes_ (what ends up on disk),
not a line-by-line port of the bash.
