# generate-manifests

Builds `manifest.json` and (when needed) `backstage-manifest.json`: package
inventories used to resolve `workspace:^` and `backstage:^` to concrete semver
ranges.

## Problem

Downstream steps need a name → version (and dependency metadata) lookup for
every workspace package and for Backstage release packages. That snapshot must
be captured while all workspace packages are still on disk, because entries in
`package.json` and `yarn.lock` can still reference packages that are removed
later in the pipeline.

## What the module does

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

## Why Backstage metadata from `yarn.lock`

`yarn.lock` already holds resolved `@backstage/*` versions and dependency
metadata after install. The [Backstage Yarn plugin](https://github.com/backstage/backstage/tree/master/packages/yarn-plugin) maps each `backstage:^`
dependency to a concrete npm version (from `backstage.json` and the release
manifest on `versions.backstage.io`); Yarn records the result in the lockfile.
This module extracts that metadata from the lockfile for
`backstage-manifest.json`.

**Benefits:**

- **No npm registry fan-out.** Dependency metadata for hundreds of
  `@backstage/*` packages comes from the lockfile, not per-package registry
  requests.
- **Workspace-accurate.** The manifest reflects versions and dependency trees
  Yarn actually resolved for this repo, not a generic registry view.

**Release-line validation:** `backstage.json` names a single Backstage release
(for example `1.42.5`). The manifest at
`versions.backstage.io/v1/releases/<version>/manifest.json` lists every
`@backstage/*` package version on that line. After extraction, the module
fetches that manifest once and checks each lockfile package against it. A
mismatch means the lockfile is not a coherent set for the claimed release —
for example `backstage.json` was bumped without `yarn install`, a bad merge in
`yarn.lock`, or a `resolutions` entry pinning a package off the release line.
The build fails with per-package details instead of writing a
`backstage-manifest.json` that downstream resolution would trust.
