# file-cleanup — design (grill session)

## Scope

Remove development-only files and directories from surviving workspace packages after `plugin-removal`. Does not change workspace structure — only deletes matching paths within the workspace tree.

## Source of truth

`sync-midstream.sh` lines 917–924 (the `find` + `rm` block). Match that behavior exactly; do not add patterns from the design-decisions summary table (`*.stories.*`, `*.mock.*`) unless they appear in bash.

## Removable paths

**Directories** (entire tree removed when the directory name matches):

- `dev`
- `e2e-tests`
- `__tests__`
- `__mocks__`

**Files** (basename match):

- `*.test.ts`
- `*.test.tsx`
- `*.spec.ts`
- `*.spec.tsx`

## Exclusions

Skip any path whose relative path contains:

- `/node_modules/`
- `/dist-dynamic/`

Same as bash `-not -path "*/node_modules/*" -not -path "*/dist-dynamic/*"`.

## Algorithm

1. Walk the workspace recursively from `ctx.workspacePath`.
2. Collect removable directory paths (name match, not under excluded segments).
3. Sort directories by depth descending; `rm -rf` each (deepest first avoids redundant work).
4. Walk again (or single walk with skip-under-removed); collect removable files not under excluded segments.
5. Delete files; log each removal via `ctx.log`.

## Non-goals

- No overlay reads (`plugins-list.yaml`, tier lists).
- No package.json or lockfile changes.
- No infrastructure or plugin directory removal (handled by `plugin-removal`).

## Pipeline position

After `plugin-removal`, before `protocol-resolution`.
