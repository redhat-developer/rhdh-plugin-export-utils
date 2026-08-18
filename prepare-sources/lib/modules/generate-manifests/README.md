# generate-manifests

Generates package inventories consumed by `protocol-resolution` to resolve
`workspace:^` and `backstage:^` references to concrete npm semver ranges.

**Pipeline position:** after `make-self-contained`, before `plugin-removal` —
see `modules.ts` for the current ordering.

**Shared types:** `WorkspaceManifest`, `BackstageManifest`, and their entry
types live in `lib/manifest-types.ts`. Both this module and
`protocol-resolution` depend on those types.

## Problem

The `protocol-resolution` module needs to rewrite `workspace:^` and
`backstage:^` protocol references in `package.json` and `yarn.lock`. To do
this, it needs a lookup table mapping package names to their concrete versions
and dependency metadata.

This information must be captured **before scrubbing** (`plugin-removal`),
because scrubbed packages are removed from disk but their versions are still
needed for protocol resolution — surviving packages may depend on scrubbed
ones via `workspace:^`.

## What the module produces

### `manifest.json`

Inventory of all local workspace packages. Always generated.

```json
{
  "packages": [
    {
      "name": "@scope/plugin-foo",
      "version": "1.2.3",
      "path": "plugins/plugin-foo/package.json",
      "dependencies": { "@scope/plugin-bar": "workspace:^" },
      "peerDependencies": { "react": "^18.0.0" },
      "peerDependenciesMeta": { "react": { "optional": true } },
      "optionalDependencies": { "@emotion/react": "^11.0.0" },
      "devDependencies": { "@types/react": "^18.0.0" },
      "bin": { "foo": "./dist/cli.js" }
    }
  ]
}
```

All dependency fields are optional — only included when non-empty.

**Package discovery:** Packages are discovered via the `workspaces` field in
the root `package.json` (glob resolution), plus the root package itself. For
flat repos (no `workspaces` field), only the root package is included.

**Filtering:** Glob matches whose path segments include any of `node_modules`,
`dist-dynamic`, `dist-scalprum`, `dist`, or `build` are excluded. This
prevents build output directories from polluting the manifest.

**`backstage:^` detection:** The module checks `dependencies`,
`devDependencies`, `peerDependencies`, and `optionalDependencies` across all
packages for `backstage:^` values. If none are found, `backstage-manifest.json`
is skipped entirely.

### `backstage-manifest.json`

Backstage release packages with dependency metadata. Only generated when the
workspace has `backstage:^` dependencies. Requires `backstage.json` at the
workspace root (throws if missing).

```json
{
  "backstageVersion": "1.42.5",
  "packages": [
    {
      "name": "@backstage/core-plugin-api",
      "version": "1.10.9",
      "dependencies": { "@backstage/types": "npm:^1.2.3" },
      "peerDependencies": { "react": "npm:^18.0.0" },
      "peerDependenciesMeta": { "react": { "optional": true } },
      "optionalDependencies": { "@emotion/react": "npm:^11.0.0" },
      "bin": { "backstage-core": "./dist/cli.js" }
    }
  ]
}
```

Note that dependency values in the backstage manifest use the Yarn-resolved
format (`npm:^X.Y.Z`), since they come from `yarn.lock` rather than
`package.json`.

Neither file is included in the OCI artifact — they are build-time
intermediates.

## Why backstage metadata comes from yarn.lock, not the npm registry

The original `generate-backstage-manifest.js` in `sync-midstream.sh` fetched
the Backstage release manifest from `versions.backstage.io` (one HTTP call),
then enriched each of the ~600 packages with dependency metadata from
`registry.npmjs.org` (60+ batched HTTP calls). The result was cached to disk
by Backstage version to amortize the cost across workspaces.

This module takes a different approach: it **extracts backstage package
metadata directly from the workspace's `yarn.lock`**, using the shared
`yarn-lock-parser` (`lib/yarn-lock-parser.ts`).

### Rationale

After `yarn install --immutable` (which runs before this module), the
`yarn.lock` already contains the resolved version and full dependency metadata
for every `@backstage/*` package. These entries were created by the Backstage
Yarn plugin, which resolves `backstage:^` by looking up the exact version from
`versions.backstage.io` at install time. So the lockfile is a local cache of
the canonical version mapping, enriched with the dependency metadata that npm
registry calls would have provided.

**Benefits:**

- **Zero npm registry calls.** The original script made hundreds of HTTP
  requests. This module reads local files only (plus one validation fetch).
- **No caching needed.** The original script cached results to `/tmp/` to
  avoid redundant fetches across workspaces in the same `sync-midstream.sh`
  run. In the new per-workspace CI model (separate workflow run per
  workspace), there's no shared filesystem to cache to. Since we read from the
  lockfile, there's nothing to cache.
- **More accurate.** The lockfile reflects what was actually resolved for this
  specific workspace, not a generic npm registry response.

**Validation:** The module fetches the Backstage release manifest from
`versions.backstage.io` (a single HTTP call) and compares each extracted
version against the canonical manifest. A mismatch throws — indicating a stale
lockfile or unexpected inconsistency. This is a defensive check; by
construction, `yarn install --immutable` guarantees the lockfile is consistent
with the Backstage Yarn plugin's resolution.

### Why the versions are guaranteed to match

The `backstage:^` protocol is resolved by the Backstage Yarn plugin, which:

1. Reads `backstage.json` to get the target release version
2. Fetches `versions.backstage.io/v1/releases/<version>/manifest.json`
3. Resolves each `backstage:^` to the exact version from that manifest
4. Writes the result to `yarn.lock`

After `yarn install --immutable`, the lockfile entries for `backstage:^` are
by construction the same versions as the canonical manifest. The validation
fetch is belt-and-suspenders — it catches corruption, plugin bugs, or manual
lockfile edits that should never happen in CI.

## Why upstream fetching is no longer needed

The original `generate-workspace-manifest.js` fetched versions from GitHub for
packages that didn't exist locally — these were packages referenced by
`workspace:^` but deleted by scrubbing before the manifest was generated. The
manifest tagged these entries with `path: 'upstream'` and `source: 'upstream'`
so that downstream consumers (`createTypeShimsPackage` in `update-workspace.js`)
could distinguish them from packages that were once local.

In the new pipeline, this entire mechanism is unnecessary because manifest
generation runs **before** `plugin-removal`. All workspace packages are still
on disk, so every entry in the manifest has a real `path`. When
`protocol-resolution` later needs to distinguish surviving from scrubbed
packages, it simply checks `fs.existsSync(dirname(pkg.path))` — exactly as the
old `update-workspace.js` already does (lines 1722, 1736, 1799). The
`path === 'upstream'` marker is never needed.

## Differences from sync-midstream.sh

| Aspect                    | Original (sync-midstream.sh)                                | New (this module)                                           |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Upstream version fetching | Fetches missing `workspace:` deps from GitHub raw URLs      | Not needed — all packages are local (runs before scrubbing) |
| Backstage metadata source | `versions.backstage.io` + npm registry (~600 HTTP calls)    | `yarn.lock` extraction + one validation fetch               |
| Caching                   | `/tmp/backstage-manifest-cache/` (shared across workspaces) | None needed                                                 |
| Error handling            | Swallowed (`\|\| true`, stderr discarded)                   | Throws on error (pipeline aborts)                           |
| Package discovery         | Recursive scan with skip-list heuristics                    | `workspaces` field glob resolution + filter                 |
| `bin` normalization       | String → object (same)                                      | String → object (same)                                      |
| yarn.lock parsing         | N/A (backstage manifest came from npm)                      | Shared `yarn-lock-parser` (`lib/yarn-lock-parser.ts`)       |

## Log messages

Log messages are aligned with the original scripts for familiarity:

| Log                                               | When                              |
| ------------------------------------------------- | --------------------------------- |
| `Scanning for package.json files...`              | Always (start of module)          |
| `Found N local packages`                          | Always                            |
| `  - @scope/pkg@1.2.3`                            | Per package                       |
| `Manifest written to: manifest.json`              | Always                            |
| `No backstage:^ dependencies found, skipping`     | No `backstage:^` in any dep field |
| `Backstage version: X.Y.Z`                        | Backstage manifest path           |
| `Extracted N @backstage/* entries from yarn.lock` | After lockfile parsing            |
| `Validating against <url>`                        | Before validation fetch           |
| `All N entries validated against Backstage X.Y.Z` | After successful validation       |
| `Written: backstage-manifest.json (N packages)`   | Backstage manifest written        |

## Error conditions

| Condition                                                        | Behavior                                    |
| ---------------------------------------------------------------- | ------------------------------------------- |
| No `backstage:^` deps in any `package.json`                      | Skip — no `backstage-manifest.json` written |
| Has `backstage:^` deps but no `backstage.json`                   | Throw                                       |
| `backstage.json` exists but has no `version` field               | Throw                                       |
| `yarn.lock` missing (when backstage manifest needed)             | Throw                                       |
| Version mismatch between `yarn.lock` and `versions.backstage.io` | Throw with details                          |
| Failed to fetch `versions.backstage.io`                          | Throw with HTTP status                      |
