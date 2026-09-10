# plugin-removal

Removes plugin source from the workspace that is not needed for building
supported dynamic plugins, and rewrites `plugins-list.yaml` to list only the
surviving supported entries.

**Pipeline position:** after `generate-manifests`, before `file-cleanup` — see
`modules.ts` for the current ordering.

## Problem

After the overlay `export-dynamic` workflow runs, the workspace checkout still
contains the full upstream tree: infrastructure shells (`packages/app`,
`packages/backend`), plugins not exported from this workspace, and plugins not
in the Red Hat supported tier.

Downstream Konflux builds only need supported plugin source plus any embedded
packages referenced from the initial export's `dist-dynamic/embedded/` output.

`generate-manifests` must run **before** this module so versions of packages
about to be scrubbed are still on disk for `protocol-resolution`.

## What the module does

1. Intersect `plugins-list.yaml` with `rhdh-supported-packages.txt` for this
   workspace (`path.basename(ctx.overlayPath)`)
2. Collect embedded package names from all `dist-dynamic/embedded/*/package.json`
   files under the workspace
3. Remove infrastructure directories (`examples/`, `packages/app`,
   `packages/backend`, `packages/app-next`, `.storybook`, `node_modules`)
4. Remove plugin directories not in the surviving list (unless preserved as an
   embedded package, matched by npm `name`)
5. Write filtered `plugins-list.yaml` back to the overlay path (full lines
   preserved, including export CLI args)

Test and dev file removal is **not** done here — see `file-cleanup`.

## Inputs and outputs

| Input               | Location                                          |
| ------------------- | ------------------------------------------------- |
| Workspace tree      | `ctx.workspacePath`                               |
| Plugins list        | `ctx.overlayPath/plugins-list.yaml`               |
| Supported tier list | `ctx.overlayRepoRoot/rhdh-supported-packages.txt` |

| Output                | Location                            |
| --------------------- | ----------------------------------- |
| Scrubbed workspace    | `ctx.workspacePath` (in place)      |
| Filtered plugins list | `ctx.overlayPath/plugins-list.yaml` |

## Non-obvious behavior

**Whitelist, not community blacklist.** Only `rhdh-supported-packages.txt` is
read. Community plugins are removed because they are absent from that list.
`rhdh-community-packages.txt` is used elsewhere (compatibility checks, wiki,
PR labeling) — not here.

**Embedded packages.** The pipeline starts after the initial export, so
`dist-dynamic/embedded/` already exists. Packages referenced there are kept
even when not in `plugins-list.yaml`, matching `sync-midstream.sh` embedded
preservation logic.

**`overlayRepoRoot`.** Tier list files live at the overlay repo root, not under
`workspaces/<name>/`. The pipeline exposes `ctx.overlayRepoRoot` explicitly
rather than resolving `../..` inside the module.

**Metadata untouched.** `workspaces/*/metadata/*.yaml` and catalog entities are
not modified. Catalog filtering is a separate concern (`remove-pre-GA-entities.js`).

## Differences from `sync-midstream.sh`

| Aspect            | `sync-midstream.sh`                            | This module                      |
| ----------------- | ---------------------------------------------- | -------------------------------- |
| Checkout          | Sparse; early plugins-list filter drives fetch | Full workspace already on disk   |
| Pass structure    | Filter list, then scrub dirs (separate steps)  | Single pass                      |
| Community removal | Repo-wide blacklist pass                       | Implicit via supported whitelist |
| Test file removal | Same loop as scrub                             | `file-cleanup` module            |

Source references: embedded collection and plugin scrubbing in
`sync-midstream.sh` lines 857–915; infrastructure removal lines 878–884.

## Error conditions

| Condition                                                  | Behavior                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `rhdh-supported-packages.txt` missing at overlay repo root | Throw                                                                   |
| `plugins-list.yaml` missing in overlay path                | Throw                                                                   |
| No surviving plugins-list entries                          | Empty `plugins-list.yaml`; remove scannable plugin dirs except embedded |

## Tests

Fixture-based I/O tests under `__fixtures__/`. Each subdirectory name is the
Vitest case title; see the fixture catalog comment in `index.test.ts`.

Typical workspace layout: exportable plugins under `plugins/`, infrastructure
shells and shared libs under `packages/`. Tier-list files go under
`input/overlay-root/` when needed (fixture directory name = workspace name for
tier-list entries). See `test-utils.ts` for the full fixture convention.
