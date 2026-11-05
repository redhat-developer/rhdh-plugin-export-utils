# make-self-contained

In non-flat source repositories, Yarn configuration (`.yarn/` and `.yarnrc.yml`)
lives at the repository root while the workspace monorepo is a subdirectory. This module
copies that root-level config into the workspace monorepo so that `yarn` can run there
without the parent directory tree.

## Problem

For non-flat repos (community-plugins, rhdh-plugins), the overlay's sparse
checkout produces a structure where Yarn configuration lives at the repo root,
separate from the workspace:

```
source-repo/
├── .yarn/releases/yarn-X.Y.Z.cjs     ← repo root
├── .yarnrc.yml                         ← repo root
├── workspaces/<ws>/
│   ├── package.json                    ← workspace's own
│   ├── yarn.lock                       ← workspace's own
│   ├── .yarnrc.yml                     ← workspace's own (maybe)
│   └── plugins/...
```

The workspace at `source-repo/workspaces/<ws>/` depends on the parent's
`.yarn/releases/` and `.yarnrc.yml`. In the downstream repo (and in the OCI
artifact), each workspace must stand alone — no parent monorepo root above it.

## What the module does

- **Non-flat repos:** Merges repo-root `.yarn/` into the workspace's `.yarn/`
  and merges repo-root `.yarnrc.yml` into the workspace's `.yarnrc.yml`.
  Workspace-level settings always take precedence over root-level settings.
  After the merge, removes `nmMode` from `.yarnrc.yml` when present (same as
  sync-midstream.sh — hardlinked `node_modules` break `npm pack` with
  `bundleDependencies`), then validates that any `yarnPath` points to an
  existing binary.

- **Flat repos:** No-op — the checkout root IS the workspace, already
  self-contained.

After this module runs, `yarn --version` succeeds from the workspace directory
without access to the repo root, and all subsequent pipeline modules work from
the self-contained workspace.

## `.yarnrc.yml` merge strategy

When both root and workspace have `.yarnrc.yml`, the module merges them by
top-level YAML key:

- Workspace keys override root keys (for the same key name)
- Root-only keys are appended to the workspace config
- Multi-line values (arrays like `plugins:`, nested objects like `npmScopes:`)
  are treated as atomic blocks keyed by their top-level key

## `.yarn/` directory merge strategy

Files from the repo-root `.yarn/` are copied recursively into the workspace's
`.yarn/`. Files that already exist at the workspace level are **not**
overwritten — workspace files take precedence. This handles the common case
where the repo root provides `.yarn/releases/` (the Yarn binary) and
`.yarn/plugins/`, while allowing workspaces to override specific files.
