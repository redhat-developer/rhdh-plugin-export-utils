# plugin-removal — design (grill-with-docs)

Pre-implementation design captured from the [RHIDP-15835](https://redhat.atlassian.net/browse/RHIDP-15835) grilling session. **Implement against this document**; keep `README.md` as the post-implementation module guide.

Related: [source-preparation-design-decisions.md](../../../docs/source-preparation-design-decisions.md) §5, §11.

---

## Language

**Supported plugin:**
A plugin whose `workspace/plugin-path` entry appears in `rhdh-supported-packages.txt`.
_Avoid_: GA plugin, production plugin (support tier is expressed elsewhere).

**Surviving plugin:**
A plugin directory kept on disk after scrubbing — either listed in the filtered `plugins-list.yaml` or preserved as an embedded package.
_Avoid_: exported plugin (export happens again later in `re-export`).

**Embedded package:**
A workspace package whose npm `name` appears under `*/dist-dynamic/embedded/*/package.json` from the initial export. Preserved even when not listed in `plugins-list.yaml`, so re-export does not fall back to npm and drift versions.
_Avoid_: bundled dependency (too vague).

**Infrastructure package:**
App/backend shell directories removed before plugin scanning — not plugin exports. Examples: `packages/app`, `packages/backend`, `packages/app-next`, `.storybook`, top-level `examples/`, `node_modules`.
_Avoid_: scaffold (ambiguous).

## Relationships

- A **Supported plugin** is always a **Surviving plugin**
- An **Embedded package** may be a **Surviving plugin** without being a **Supported plugin**
- **Infrastructure packages** are never **Surviving plugins**
- Filtered `plugins-list.yaml` lists only **Supported plugins** (full lines preserved, including CLI args)

## Example dialogue

> **Dev:** "Why is `plugins/orchestrator-common` still on disk after scrubbing even though it's not in `plugins-list.yaml`?"
>
> **Domain expert:** "Because a surviving exported plugin embedded it — check `dist-dynamic/embedded/`. We preserve **Embedded packages** by npm `name`, not by plugins-list path."
>
> **Dev:** "Should we delete community plugin metadata from the overlay?"
>
> **Domain expert:** "No — that's catalog assembly, not **plugin-removal**. This module only scrubs **plugin source** in the workspace checkout."
>
> **Dev:** "Does `rhdh-community-packages.txt` filter metadata YAML inside a workspace?"
>
> **Domain expert:** "No. Per-file metadata filtering uses `spec.support` in `remove-pre-GA-entities.js`, driven by `rhdh-supported-packages.txt` and `default.packages.yaml` — not the community list. Community tier is used elsewhere (compatibility checks, wiki badges, mandatory PR labeling)."

## Flagged ambiguities

- RHIDP-15835 mentions "community-tier plugins (filtered by the support-tier files)" — for **source scrubbing**, community plugins are excluded because they are **not** on the supported whitelist. `rhdh-community-packages.txt` is **not** an input to this module.
- Test/dev cleanup (`*.test.ts`, `__tests__/`, `dev/`, `e2e-tests/`) lives in `file-cleanup` per design doc §11, even though `sync-midstream.sh` runs it in the same loop (lines 917–924).
- Catalog / metadata preservation is out of scope — overlay `metadata/*.yaml` and `catalog-entities/` are untouched.

---

## Resolved decisions

### 1. Whitelist from `rhdh-supported-packages.txt` only

Keep plugins whose `workspace/plugin-path` is in `rhdh-supported-packages.txt`. Do not read `rhdh-community-packages.txt` for source scrubbing.

`sync-midstream.sh` also has a separate community blacklist pass (lines 1066–1094) at repo scope; in the per-workspace pipeline the whitelist intersection is sufficient.

### 2. `overlayRepoRoot` on `PipelineInputs`

Tier list files live at the overlay **repository** root (`rhdh-supported-packages.txt`), while `ctx.overlayPath` is `overlay-repo/workspaces/<name>/`.

Expose `ctx.overlayRepoRoot` on `PipelineInputs`, derived in `loadPipelineInputs` as `path.resolve(overlayPath, '../..')`. Do **not** traverse with `../..` inside the module (security scanner / linter concerns).

### 3. Pipeline starts after initial export

The CLI runs after `export-dynamic.yaml` has completed an initial `rhdh-cli plugin export`. At `plugin-removal` time, `dist-dynamic/` and `dist-dynamic/embedded/` already exist.

Embedded preservation mirrors `sync-midstream.sh` lines 857–870: scan **all** `dist-dynamic/embedded/*/package.json` under the workspace **before** deleting package directories.

### 4. Single pass (not sparse-checkout stages)

`sync-midstream.sh` filtered `plugins-list.yaml` early (lines 691–714) to drive sparse checkout, then scrubbed directories later (886–915). In the overlay workflow the workspace is fully on disk — filter `plugins-list.yaml` and remove directories in **one** module pass.

### 5. Preserve full `plugins-list.yaml` lines

Surviving entries are written back with their complete text, including trailing `:` and export CLI arguments (`--embed-package`, `--suppress-native-package`, etc.).

### 6. Flat-repo path normalization

Supported-packages entries may use a trailing `/.` for flat repos (e.g. `pagerduty/.`). Normalize by stripping `/.` on both tier-list entries and constructed paths before comparison. No current entries use this, but the bash handles it defensively.

### 7. Package directory matching

A directory is kept when its path relative to the workspace:

- equals a surviving plugins-list path, or
- equals `path/dist-dynamic`, or
- its `package.json` `name` matches an embedded package name

Scan `package.json` at mindepth 2 (exclude workspace root `package.json`), same as `sync-midstream.sh` line 916.

### 8. Scope split vs `file-cleanup`

| Concern                                                                      | Module           |
| ---------------------------------------------------------------------------- | ---------------- |
| Infrastructure dirs, non-supported plugin dirs, filtered `plugins-list.yaml` | `plugin-removal` |
| Test/dev files within surviving packages                                     | `file-cleanup`   |

Infrastructure patterns from bash (lines 878–884): `examples/` (depth 1), `packages/app`, `packages/backend`, `packages/app-next`, `.storybook`, `node_modules`.

### 9. Out of scope

- Metadata YAML filtering (`remove-pre-GA-entities.js`)
- `rhdh-community-packages.txt` as scrub input
- `protocol-resolution` / `package-cleanup` (lockfile and package.json rewriting)

---

## Algorithm (implementation contract)

1. Read `plugins-list.yaml` from `ctx.overlayPath`
2. Read `rhdh-supported-packages.txt` from `ctx.overlayRepoRoot`
3. Workspace name = `path.basename(ctx.overlayPath)`
4. Surviving list = plugins-list entries whose `workspaceName/pluginPath` is in the supported set
5. Collect embedded npm names from all `**/dist-dynamic/embedded/*/package.json`
6. Remove infrastructure directories
7. For each `package.json` at depth ≥ 2: remove parent dir unless kept by list, `dist-dynamic` path, or embedded name
8. Write filtered `plugins-list.yaml`

## Error handling

| Condition                                                  | Behavior                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `rhdh-supported-packages.txt` missing at overlay repo root | Throw                                                                             |
| `plugins-list.yaml` missing in overlay path                | Throw                                                                             |
| No surviving plugins-list entries                          | Write empty `plugins-list.yaml`; remove all scannable plugin dirs except embedded |

## sync-midstream.sh references

| Behavior                                                     | Lines     |
| ------------------------------------------------------------ | --------- |
| plugins-list ∩ supported (sparse checkout era)               | 691–714   |
| Embedded package collection                                  | 857–870   |
| Infrastructure removal                                       | 878–884   |
| Non-exported plugin removal                                  | 886–915   |
| Community path deletion (repo-wide, **not** replicated here) | 1066–1094 |
| Test/dev removal (**file-cleanup**, not here)                | 917–924   |

## Test fixtures

Use realistic workspace layouts — see
[source-preparation-design-decisions.md](../../../docs/source-preparation-design-decisions.md)
§12 (fixture workspace layout).

**For this module specifically:**

- Exportable plugins under `plugins/<name>/` with `plugins/<name>:` in
  `plugins-list.yaml` (or `packages/<name>:` when mirroring gitlab-style flat
  repos).
- Infrastructure under `packages/app`, `packages/backend`, etc. — not mixed into
  `plugins/`.
- Embedded source as a sibling plugin package (e.g. `plugins/embedded-lib/`) whose
  `package.json` `name` matches `dist-dynamic/embedded/*/package.json`.
- Post-export state: `plugins/<exported>/dist-dynamic/` including
  `embedded/` when testing preservation.
- Tier list in `input/overlay-root/rhdh-supported-packages.txt` with lines like
  `<fixture-name>/plugins/<name>` (fixture name = workspace name via
  `loadFixture`).
