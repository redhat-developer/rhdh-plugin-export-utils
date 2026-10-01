# inject-build-tools

Makes `rhdh-cli` available for offline use in hermetic Konflux builds by
caching its npm pack tarball in the workspace and adding a `file:`
`devDependency`.

Designed as an isolated, removable module — once Konflux can provision the
CLI externally, this step can be deleted.

## Problem

Later pipeline steps (`re-export`) need `@red-hat-developer-hub/cli` to export
dynamic plugins. Hermetic builds have no network, so Yarn cannot download the
CLI from the registry at install time.

## What the module does

1. Walks up from the overlay path to find overlays `versions.json` and reads
   the `cli` version (and optional `cliPackage`, defaulting to
   `@red-hat-developer-hub/cli`).
2. Ensures `.yarn/cache/` exists under the workspace.
3. If `red-hat-developer-hub-cli-<version>.tgz` is missing, downloads it with
   `npm pack` into that cache directory.
4. Sets workspace root `package.json`:

   ```json
   "devDependencies": {
     "@red-hat-developer-hub/cli": "file:.yarn/cache/red-hat-developer-hub-cli-<version>.tgz"
   }
   ```

The `file:` path is relative to the workspace root so the prepared source OCI
artifact stays self-contained (unlike midstream `offline-rhdh-cli.sh`, which
used `file:../../.yarn/cache/...` for a multi-workspace repo layout).
