# file-cleanup

Removes test, mock, and dev-only files from surviving workspace packages after
`plugin-removal`. Reduces source size and avoids TypeScript errors from test
files that reference devDependencies removed during scrubbing.

## Problem

Surviving plugin directories still contain test specs, mock directories, and
local dev utilities. Downstream Konflux builds do not run tests; these files
only add noise and can fail `tsc` when they import types from scrubbed packages
(for example `@types/jest`).

## What the module does

Recursively scans `ctx.workspacePath` and removes:

| Kind                      | Patterns                                             |
| ------------------------- | ---------------------------------------------------- |
| Directories (entire tree) | `dev/`, `e2e-tests/`, `__tests__/`, `__mocks__/`     |
| Files                     | `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx` |

Paths under `node_modules/` or `dist-dynamic/` are never touched.

## Non-obvious behavior

**Full workspace scan.** The bash original searches the entire workspace tree
(`$folder_name`), not only `plugins/`. This module does the same — a stray
`packages/shared/src/foo.test.ts` is removed too.

**Directory before file.** Removable directories are deleted deepest-first so
nested content is not processed twice.

**dist-dynamic is preserved.** Test files inside `dist-dynamic/` are kept
because the downstream export step may reference lockfile metadata there; bash
explicitly excludes `*/dist-dynamic/*`.

## Tests

Fixture-based I/O tests under `__fixtures__/`. Each subdirectory name is the
Vitest case title; see the fixture catalog comment in `index.test.ts`.

Typical layout: surviving plugin under `plugins/<name>/` with production
source, test dirs, and spec files. Include `dist-dynamic/` and `node_modules/`
subtrees when testing exclusion boundaries.
