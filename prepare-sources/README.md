# prepare-sources

A TypeScript CLI that transforms a workspace — after the overlay `export-dynamic` workflow has performed the initial `rhdh-cli plugin export` — into a prepared source OCI artifact suitable for downstream Konflux builds.

## What It Does

The CLI runs a fixed pipeline of 13 modules in sequence. Each module transforms the workspace on disk, and modules communicate exclusively through the file system — no in-memory state is passed between them.

```
seed-frontend-lockfiles → make-self-contained → generate-manifests → plugin-removal →
file-cleanup → protocol-resolution → package-cleanup → hermetic-prep →
inject-build-tools → build → re-export → validate → construct-artifact
```

The starting state is a workspace with patches applied, overlays merged, `yarn install` + `yarn tsc` completed, and a successful initial `rhdh-cli plugin export` already done by `export-dynamic.yaml`.

## Usage

```bash
node src/cli.ts \
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

### Zero runtime dependencies

The package has no `dependencies` — only `devDependencies` for tooling (Vite+, TypeScript, `@types/node`). All utilities (yarn.lock parser, version comparison, etc.) are implemented in-house using only Node.js built-in modules. This avoids dependency conflicts with the workspace being transformed.

### File-system communication

Modules read inputs from files on disk and write outputs to files on disk. The only shared context object (`ModuleContext`) carries the workspace path, overlay path, parsed `source.json`, and a name-prefixed logger. This makes each module independently testable with fixture directories.

### Inter-module metadata

Modules that produce metadata not intended for the OCI artifact's content layers write to `.source-prep/` under the workspace root (e.g., `.source-prep/plugin-annotations.json`). This directory is consumed by `construct-artifact` for OCI annotations but excluded from the artifact's content layers.

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

### Native TypeScript execution

The CLI runs `.ts` files directly via Node.js type stripping (Node 22.18+). No transpilation step. `tsconfig.json` enables `allowImportingTsExtensions` and `erasableSyntaxOnly`.

## Pipeline Modules

| #   | Module                    | Purpose                                                                        |
| --- | ------------------------- | ------------------------------------------------------------------------------ |
| 1   | `seed-frontend-lockfiles` | Seed `dist-dynamic/yarn.lock` for frontend plugins after the initial export    |
| 2   | `make-self-contained`     | Merge repo-root `.yarn/` and `.yarnrc.yml` into the workspace (non-flat repos) |
| 3   | `generate-manifests`      | Produce `manifest.json` and `backstage-manifest.json` for protocol resolution  |
| 4   | `plugin-removal`          | Remove unsupported/community plugins and update `plugins-list.yaml`            |
| 5   | `file-cleanup`            | Strip test files, mocks, stories, and dev-only artifacts                       |
| 6   | `protocol-resolution`     | Resolve `workspace:^` and `backstage:^` protocols; generate `type-shims`       |
| 7   | `package-cleanup`         | Remove scrubbed entries from `yarn.lock`, clean `package.json` workspaces list |
| 8   | `hermetic-prep`           | Remove `packageManager` and monorepo `postinstall` scripts for Konflux         |
| 9   | `inject-build-tools`      | Add `rhdh-cli` as a `file:` devDependency for offline export                   |
| 10  | `build`                   | Run `yarn install` + `tsc` + build to validate the transformation              |
| 11  | `re-export`               | Re-export plugins, seed frontend lockfiles, extract OCI annotations            |
| 12  | `validate`                | Compare initial-export vs. re-export to detect dependency drift                |
| 13  | `construct-artifact`      | Bundle the validated workspace into an OCI artifact with annotations           |

Each module lives in `src/modules/<name>/` with co-located tests and `__fixtures__/`. See the `template` module (`src/modules/template/`) for the canonical structure.

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

The `testInputOutputExpectations()` helper in `src/test-utils.ts` auto-generates test cases from all fixture subdirectories. See `src/modules/template/index.test.ts` for a complete example.

## Development

Install dependencies:

```bash
npm install
```

Lint, format, and typecheck:

```bash
npm run check
```

Run tests:

```bash
npm test
```

## Source Files

| File                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `src/cli.ts`            | Entry point — argument parsing and pipeline invocation        |
| `src/args.ts`           | CLI argument parsing via `node:util` `parseArgs`              |
| `src/pipeline.ts`       | Pipeline runner, input loading, module selection, logging     |
| `src/types.ts`          | Shared types: `SourceJson`, `PipelineInputs`, `ModuleContext` |
| `src/modules.ts`        | Ordered module registry                                       |
| `src/test-utils.ts`     | Test helpers: `loadFixture`, `testInputOutputExpectations`    |
| `src/modules/template/` | Reference module implementation with all 6 fixture patterns   |
