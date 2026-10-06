import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";
import type {
  BackstageManifest,
  BackstagePackageEntry,
  WorkspaceManifest,
  WorkspacePackageEntry,
} from "../../manifest-types.ts";
import { parseDescriptor, parseRange, stringifyIdent } from "@yarnpkg/core/structUtils";
import { parseSyml } from "@yarnpkg/parsers";

const VERSIONS_BACKSTAGE_IO = "https://versions.backstage.io/v1/releases";

const EXCLUDE_DIRS = new Set(["node_modules", "dist-dynamic", "dist-scalprum", "dist", "build"]);

/**
 * Generates `manifest.json` (workspace package inventory) and optionally
 * `backstage-manifest.json` (Backstage release packages with dependency
 * metadata, extracted from `yarn.lock` and validated against
 * `versions.backstage.io`).
 *
 * Must run before scrubbing so that versions of to-be-scrubbed packages are
 * captured. Not included in the OCI artifact.
 */
export async function run(ctx: ModuleContext): Promise<void> {
  ctx.log("Scanning for package.json files...");
  const workspaceManifest = generateWorkspaceManifest(ctx);

  ctx.log(`Found ${workspaceManifest.packages.length} local packages`);
  for (const pkg of workspaceManifest.packages) {
    ctx.log(`  - ${pkg.name}@${pkg.version}`);
  }

  const manifestPath = path.join(ctx.workspacePath, "manifest.json");
  writeJson(manifestPath, workspaceManifest);
  ctx.log(`Manifest written to: manifest.json`);

  if (!manifestHasBackstageDeps(workspaceManifest)) {
    ctx.log("No backstage:^ dependencies found, skipping");
    return;
  }

  const backstageManifest = await generateBackstageManifest(ctx);
  const backstagePath = path.join(ctx.workspacePath, "backstage-manifest.json");
  writeJson(backstagePath, backstageManifest);
  ctx.log(`Written: backstage-manifest.json (${backstageManifest.packages.length} packages)`);
}

function manifestHasBackstageDeps(manifest: WorkspaceManifest): boolean {
  return manifest.packages.some((pkg) => {
    const allDeps = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
      pkg.optionalDependencies,
    ];
    return allDeps.some((deps) => deps && Object.values(deps).includes("backstage:^"));
  });
}

// ---------------------------------------------------------------------------
// Workspace manifest
// ---------------------------------------------------------------------------

function generateWorkspaceManifest(ctx: ModuleContext): WorkspaceManifest {
  const packageJsonPaths = findWorkspacePackageJsonFiles(ctx.workspacePath);
  const packages: WorkspacePackageEntry[] = [];

  for (const pkgPath of packageJsonPaths) {
    const entry = extractPackageInfo(pkgPath, ctx.workspacePath);
    if (entry) packages.push(entry);
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { packages };
}

/**
 * Discover workspace package.json files using the `workspaces` field from
 * the root package.json, filtered to exclude build output directories.
 * For flat repos (no `workspaces` field), returns just the root.
 */
export function findWorkspacePackageJsonFiles(workspacePath: string): string[] {
  const rootPkgPath = path.join(workspacePath, "package.json");
  if (!fs.existsSync(rootPkgPath)) return [];

  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
  const patterns: string[] = rootPkg.workspaces ?? [];
  const results = [rootPkgPath];

  for (const pattern of patterns) {
    const matches = fs.globSync(pattern, { cwd: workspacePath });
    for (const match of matches) {
      if (match.split(path.sep).some((seg) => EXCLUDE_DIRS.has(seg))) continue;
      const pkgPath = path.join(workspacePath, match, "package.json");
      if (fs.existsSync(pkgPath)) results.push(pkgPath);
    }
  }

  return results;
}

const DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "devDependencies",
] as const;

export function extractPackageInfo(
  packageJsonPath: string,
  baseDir: string,
): WorkspacePackageEntry | null {
  const content = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (!content.name || !content.version) return null;

  const entry: WorkspacePackageEntry = {
    name: content.name,
    version: content.version,
    path: path.relative(path.resolve(baseDir), packageJsonPath),
  };

  for (const field of DEP_FIELDS) {
    if (content[field] && Object.keys(content[field]).length > 0) {
      (entry as Record<string, unknown>)[field] = content[field];
    }
  }

  if (content.bin) {
    entry.bin = normalizeBin(content.name, content.bin);
  }

  return entry;
}

/**
 * Normalize the `bin` field to always be an object.
 * String form `"./cli.js"` becomes `{ "<unscoped-name>": "./cli.js" }`.
 */
export function normalizeBin(
  packageName: string,
  bin: string | Record<string, string>,
): Record<string, string> | undefined {
  if (typeof bin === "string") {
    const slashPos = packageName.lastIndexOf("/");
    const unscopedName = slashPos === -1 ? packageName : packageName.substring(slashPos + 1);
    return { [unscopedName]: bin };
  }
  if (Object.keys(bin).length > 0) return bin;
  return undefined;
}

// ---------------------------------------------------------------------------
// Backstage manifest
// ---------------------------------------------------------------------------

async function generateBackstageManifest(ctx: ModuleContext): Promise<BackstageManifest> {
  const backstageVersion = getBackstageVersion(ctx.workspacePath);
  ctx.log(`Backstage version: ${backstageVersion}`);

  const yarnLockPath = path.join(ctx.workspacePath, "yarn.lock");
  if (!fs.existsSync(yarnLockPath)) {
    throw new Error("yarn.lock not found — cannot extract backstage package metadata");
  }

  const lockContent = fs.readFileSync(yarnLockPath, "utf8");
  const entries = extractBackstageEntries(lockContent);
  ctx.log(`Extracted ${entries.length} @backstage/* entries from yarn.lock`);

  await validateBackstageVersions(entries, backstageVersion, ctx);

  return {
    backstageVersion,
    packages: entries.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Read the Backstage version from `backstage.json` in the workspace.
 * Throws if `backstage:^` deps exist but no `backstage.json` is found.
 */
export function getBackstageVersion(workspacePath: string): string {
  const backstageJsonPath = path.join(workspacePath, "backstage.json");
  if (!fs.existsSync(backstageJsonPath)) {
    throw new Error(
      "workspace has backstage:^ dependencies but no backstage.json — " +
        "cannot determine Backstage version",
    );
  }
  const content = JSON.parse(fs.readFileSync(backstageJsonPath, "utf8"));
  if (!content.version) {
    throw new Error("backstage.json exists but has no 'version' field");
  }
  return content.version;
}

// ---------------------------------------------------------------------------
// yarn.lock extraction
// ---------------------------------------------------------------------------

const BACKSTAGE_PROTOCOL = "backstage:";

/**
 * Splits a compound lockfile descriptor key into individual descriptor strings.
 */
function splitDescriptorKey(lockfileKey: string): string[] {
  return lockfileKey.split(/ *, */);
}

/**
 * Extract `@backstage/*` package entries resolved via `backstage:^` from a
 * yarn.lock string. Returns structured entries with version and dependency
 * metadata.
 */
export function extractBackstageEntries(lockContent: string): BackstagePackageEntry[] {
  const parsed = parseSyml(lockContent);
  const entries: BackstagePackageEntry[] = [];

  for (const [key, raw] of Object.entries(parsed)) {
    if (key === "__metadata") continue;
    const entry = toBackstageEntry(key, raw);
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Maps a yarn.lock entry to a {@link BackstagePackageEntry}.
 *
 * @param key - Compound descriptor key for a single top-level yarn.lock entry.
 * @param raw - Parsed YAML body (`version`, `dependencies`, etc.).
 * @returns Metadata when this row resolves an `@backstage/*` package from the
 *   workspace `backstage:^` range; `undefined` otherwise.
 */
function toBackstageEntry(key: string, raw: unknown): BackstagePackageEntry | undefined {
  if (!isRecord(raw)) return undefined;

  const name = backstagePackageName(key);
  if (!name) return undefined;

  const version = raw.version;
  if (typeof version !== "string") return undefined;

  return {
    name,
    version,
    dependencies: stringRecord(raw.dependencies),
    peerDependencies: stringRecord(raw.peerDependencies),
    peerDependenciesMeta: peerMetaRecord(raw.peerDependenciesMeta),
    optionalDependencies: stringRecord(raw.optionalDependencies),
    bin: stringRecord(raw.bin),
  };
}

/**
 * Resolves the npm package name for a yarn.lock entry from its compound descriptor key.
 *
 * @param key - Compound descriptor key for a single top-level yarn.lock entry.
 * @returns Package name from the `backstage:` alias in `key`, or `undefined`
 *   when `key` does not denote an `@backstage/*` `backstage:^` dependency.
 */
function backstagePackageName(key: string): string | undefined {
  for (const descriptorString of splitDescriptorKey(key)) {
    const descriptor = parseDescriptor(descriptorString);
    // Only `@backstage/*` packages (aliases in a key share the same scope and name).
    if (descriptor.scope !== "backstage") continue;
    // Compound keys can list several aliases; only the `backstage:` one counts here.
    if (parseRange(descriptor.range).protocol !== BACKSTAGE_PROTOCOL) continue;
    return stringifyIdent(descriptor);
  }
  return undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue;
    result[key] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function peerMetaRecord(value: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const converted: Record<string, Record<string, unknown>> = {};
  for (const [pkg, props] of Object.entries(value)) {
    if (!isRecord(props)) continue;
    const record: Record<string, unknown> = {};
    for (const [prop, raw] of Object.entries(props)) {
      record[prop] = raw === "true" ? true : raw === "false" ? false : raw;
    }
    converted[pkg] = record;
  }
  return Object.keys(converted).length > 0 ? converted : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Backstage version validation
// ---------------------------------------------------------------------------

async function validateBackstageVersions(
  entries: BackstagePackageEntry[],
  backstageVersion: string,
  ctx: ModuleContext,
): Promise<void> {
  const url = `${VERSIONS_BACKSTAGE_IO}/${backstageVersion}/manifest.json`;
  ctx.log(`Validating against ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `failed to fetch Backstage manifest for ${backstageVersion}: HTTP ${response.status}`,
    );
  }

  const manifest: unknown = await response.json();
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("packages" in manifest) ||
    !Array.isArray(manifest.packages)
  ) {
    throw new Error(`invalid Backstage manifest response from ${url}`);
  }
  const versionMap = new Map<string, string>();
  for (const pkg of manifest.packages) {
    if (
      typeof pkg === "object" &&
      pkg !== null &&
      "name" in pkg &&
      "version" in pkg &&
      typeof pkg.name === "string" &&
      typeof pkg.version === "string"
    ) {
      versionMap.set(pkg.name, pkg.version);
    }
  }

  const mismatches: string[] = [];
  for (const entry of entries) {
    const expected = versionMap.get(entry.name);
    if (expected && expected !== entry.version) {
      mismatches.push(`${entry.name}: yarn.lock has ${entry.version}, manifest has ${expected}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `backstage version mismatch between yarn.lock and versions.backstage.io:\n` +
        mismatches.join("\n"),
    );
  }

  ctx.log(`All ${entries.length} entries validated against Backstage ${backstageVersion}`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}
