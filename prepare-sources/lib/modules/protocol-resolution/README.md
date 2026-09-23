# protocol-resolution

Resolves `workspace:^` and `backstage:^` protocol references to concrete npm
semver ranges so the prepared workspace can build without the upstream monorepo.
Also creates `packages/type-shims` when surviving code needs types from scrubbed
packages.

## Pipeline position

After `file-cleanup`, before `package-cleanup`.

## Inputs

| Path                      | Description                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `manifest.json`           | Workspace package inventory (from `generate-manifests`, pre-scrub) |
| `backstage-manifest.json` | Backstage release packages (optional)                              |
| `package.json` files      | All workspace packages                                             |
| `yarn.lock`               | Workspace lockfile                                                 |
| `tsconfig.json`           | Root TypeScript config (for type-shims references)                 |

## Outputs

| Path                   | Description                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `package.json` files   | Protocol refs resolved to `^version` for scrubbed packages; surviving local `workspace:^` preserved |
| `yarn.lock`            | Workspace blocks replaced with npm blocks; dangling deps wired; specifiers enriched                 |
| `packages/type-shims/` | Aggregated host deps and `@types/*` when needed                                                     |
| Root `package.json`    | `packages/type-shims` added to workspaces                                                           |
| Root `tsconfig.json`   | Reference to `packages/type-shims`                                                                  |

## Behavior

**Surviving local packages** keep `workspace:^` in `package.json` so `rhdh-cli`
can resolve them during re-export. Only references to scrubbed packages (no
longer on disk) are converted to npm ranges.

**yarn.lock transformation** uses the shared `yarn-lock-parser` (`parseLockfile` /
`serializeLockfile`) and `yarn-lock-helpers` utilities. It deletes stale
workspace-path blocks for removed directories, converts non-local `workspace:^` /
`backstage:^` blocks to npm resolution blocks (using manifest or registry
metadata), runs dangling-dependency passes, and enriches combined block keys.

**type-shims** aggregates `react`/`react-dom` host deps from scrubbed `app`
packages and needed `@types/*` from scrubbed devDependencies. Skipped when
nothing is required.

## Errors

- Missing `manifest.json` or `yarn.lock`
- Cannot fetch npm metadata for a package that needs a new resolution block
- Surviving `linkType: soft` blocks keyed as npm (inconsistent lockfile)

## Tests

Fixture-based I/O tests under `__fixtures__/`. Each subdirectory name is the
Vitest case title; see the fixture catalog comment in `index.test.ts`.

Scenarios cover package.json protocol resolution, yarn.lock block lifecycle
(stale paths, combined keys for local packages, specifier enrichment, dangling
deps), type-shims
creation, no-op paths, and error cases. Scrubbed packages in `manifest.json`
should include `dependencies` (even `{}`) so resolution blocks can be built
without registry fetches.
