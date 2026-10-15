# seed-frontend-lockfiles

Seeds `dist-dynamic/yarn.lock` for frontend plugins after the initial dynamic
plugin export.

**Pipeline position:** first module — runs before `make-self-contained`. See
`modules.ts` for the current ordering.

## Problem

After `rhdh-cli plugin export`, backend plugins already have a resolved
`yarn.lock` inside their `dist-dynamic/` directory (because the export process
creates a private `node_modules` and runs `yarn install` for them). Frontend
plugins do not get this treatment — their `dist-dynamic/` contains
`package.json` but no lockfile.

Downstream Konflux builds and later pipeline modules (`re-export`, `validate`)
need a lockfile in every plugin's `dist-dynamic/` to ensure reproducible
dependency resolution.

## What the module does

1. Scan the workspace for all `dist-dynamic/` directories
2. For each, determine the plugin type from the parent's `package.json`
   (`backstage.role` field)
3. If the plugin is **frontend** and `dist-dynamic/yarn.lock` does not exist:
   - Copy the workspace-level `yarn.lock` into `dist-dynamic/`
   - Run `yarn install --no-immutable` inside `dist-dynamic/` to filter the
     lockfile down to only the plugin's dependencies
4. Skip backend plugins (already have a lockfile) and non-plugin packages

## Inputs and outputs

| Input                               | Location                      |
| ----------------------------------- | ----------------------------- |
| Workspace with `dist-dynamic/` dirs | `ctx.workspacePath`           |
| Workspace lockfile                  | `ctx.workspacePath/yarn.lock` |

| Output                    | Location                                      |
| ------------------------- | --------------------------------------------- |
| Seeded frontend lockfiles | `plugins/*/dist-dynamic/yarn.lock` (in place) |

## Non-obvious behavior

**Plugin type detection.** The module reads `backstage.role` from each
plugin's `package.json`. Roles starting with `"frontend"` (e.g.,
`"frontend-plugin"`, `"frontend-plugin-module"`) are treated as frontend.
Roles starting with `"backend"` are backend. Missing or unrecognized roles
are treated as `"none"` and skipped.

**Idempotent.** If `dist-dynamic/yarn.lock` already exists (backend plugin,
or a future version of the export tool that handles frontend lockfiles), the
plugin is skipped. Running the module twice is safe.

**Yarn resolution.** The module invokes bare `yarn` and relies on Yarn
Berry's `yarnPath` walk-up resolution from the workspace directory tree to
find the correct Yarn binary.

## Error conditions

| Condition                                                       | Behavior                        |
| --------------------------------------------------------------- | ------------------------------- |
| No `dist-dynamic/` dirs in workspace                            | No-op (logged)                  |
| Frontend plugin needs seeding but workspace `yarn.lock` missing | Throw                           |
| `yarn install` fails                                            | Throw with stderr output        |
| `package.json` missing in plugin dir                            | Treated as type "none", skipped |
| `package.json` invalid JSON                                     | Throw                           |

## Tests

Fixture-based tests under `__fixtures__/`. `execFileSync` is mocked via
`vi.mock("node:child_process")` — tests verify decision logic and subprocess
arguments without running yarn.

Typical fixtures: frontend plugin needing seeding, backend plugin with
existing lockfile, mixed workspace, missing workspace lockfile, yarn install
failure.
