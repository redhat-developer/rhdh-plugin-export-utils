# prepare-sources

A TypeScript CLI that transforms a workspace — after the overlay `export-dynamic` workflow has performed the initial `rhdh-cli plugin export` — into a prepared source OCI artifact suitable for downstream Konflux builds.

Part of [RHDHPLAN-1568](https://redhat.atlassian.net/browse/RHDHPLAN-1568). See the [design decisions](../docs/source-preparation-design-decisions.md) and [issue breakdown](../docs/source-preparation-issues.md) for full context.

## Usage

```bash
node lib/cli.ts \
  --workspace-path <path-to-source-workspace> \
  --overlay-path <path-to-overlay-workspace>
```

`source.json` is read from `<overlay-path>/source.json` automatically.

**Debugging flags:**

| Flag                    | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `--list-modules`        | Print ordered module names and exit      |
| `--stop-after=<module>` | Halt after completing the named module   |
| `--start-from=<module>` | Skip all modules before the named module |

## Design Choices

### Stateless modules

Each module performs an isolated transformation on the workspace directory in sequence. The only shared context (`ModuleContext`) carries the workspace path, overlay path, parsed `source.json`, and a name-prefixed logger. This makes each module independently testable with fixture directories.

### Minimal dependencies

The package currently has no runtime `dependencies` — only `devDependencies` for tooling. Where possible, utilities are implemented using Node.js built-in modules to avoid dependency conflicts with the workspace being transformed. This is a preference, not a hard constraint; future modules may introduce dependencies when the benefit outweighs the cost (e.g., using Yarn's own API for lockfile transformations).

### Inter-module metadata

Some modules produce metadata that is not part of the OCI artifact's content layers but is needed by later modules. For example, the `re-export` module extracts per-plugin OCI annotations and writes them to `.source-prep/plugin-annotations.json`, which `construct-artifact` then reads to set annotations on the OCI manifest. This avoids mixing build metadata into the artifact's file layers while keeping it accessible across module boundaries.

### Structured logging

All output goes to stderr. Module lifecycle messages (`starting`, `done`, `failed`) are flush-left. Module-internal messages are indented and prefixed with the module name:

```
Pipeline starting
  workspace: /path/to/workspace
  overlay:   /path/to/overlay
  repo:      https://github.com/org/repo @ v1.2.3
[seed-frontend-lockfiles] starting
[seed-frontend-lockfiles]   seeding lockfile for @backstage/plugin-catalog
[seed-frontend-lockfiles] done
```

## Pipeline Modules

| #   | Module                    | Purpose                                                                        | Status          |
| --- | ------------------------- | ------------------------------------------------------------------------------ | --------------- |
| 1   | `seed-frontend-lockfiles` | Seed `dist-dynamic/yarn.lock` for frontend plugins after the initial export    | Not implemented |
| 2   | `make-self-contained`     | Merge repo-root `.yarn/` and `.yarnrc.yml` into the workspace (non-flat repos) | Not implemented |
| 3   | `generate-manifests`      | Produce `manifest.json` and `backstage-manifest.json` for protocol resolution  | Not implemented |
| 4   | `plugin-removal`          | Remove unsupported/community plugins and update `plugins-list.yaml`            | Not implemented |
| 5   | `file-cleanup`            | Strip test files, mocks, stories, and dev-only artifacts                       | Not implemented |
| 6   | `protocol-resolution`     | Resolve `workspace:^` and `backstage:^` protocols; generate `type-shims`       | Not implemented |
| 7   | `package-cleanup`         | Remove scrubbed entries from `yarn.lock`, clean `package.json` workspaces list | Not implemented |
| 8   | `hermetic-prep`           | Remove `packageManager` and monorepo `postinstall` scripts for Konflux         | Not implemented |
| 9   | `inject-build-tools`      | Add `rhdh-cli` as a `file:` devDependency for offline export                   | Not implemented |
| 10  | `build`                   | Run `yarn install` + `tsc` + build to validate the transformation              | Not implemented |
| 11  | `re-export`               | Re-export plugins, seed frontend lockfiles, extract OCI annotations            | Not implemented |
| 12  | `validate`                | Compare initial-export vs. re-export to detect dependency drift                | Not implemented |
| 13  | `construct-artifact`      | Bundle the validated workspace into an OCI artifact with annotations           | Not implemented |

Each module lives in `lib/modules/<name>/` with co-located tests and `__fixtures__/`. See the `template` module (`lib/modules/template/`) for the canonical structure.

## Test Strategy

Every module test follows the file-system-in, file-system-out pattern:

1. Create a fixture directory with the module's expected input files
2. Invoke the module's `run` function, passing a `ModuleContext` pointing at the fixture
3. Assert on the output files (contents, presence/absence, structure)

### Fixture conventions

Each fixture case is a subdirectory under `__fixtures__/`:

```
__fixtures__/<case>/
├── input/
│   ├── workspace/        → copied into a temp workspace dir
│   └── overlay/          → copied into a temp overlay dir
│       └── source.json   → parsed into ctx.source
├── output/               → (optional)
│   ├── workspace/        → asserted against workspace after run
│   └── overlay/          → asserted against overlay after run
└── error                 → (optional) expected error message or /regex/
```

- If `output/<side>/` is present, the test asserts the result matches it exactly.
- If `output/<side>/` is absent, the test asserts no changes from `input/<side>/` (immutability).
- If an `error` file is present, the test asserts the module throws with the given message (or regex pattern if wrapped in `/slashes/`).

The `testInputOutputExpectations()` helper in `lib/test-utils.ts` auto-generates test cases from all fixture subdirectories. See `lib/modules/template/index.test.ts` for a complete example.

## Development

Install [Vite+](https://viteplus.dev/guide/) globally, then:

```bash
vp install
```

Lint, format, and typecheck:

```bash
vp check
```

Run tests:

```bash
vp test
```
