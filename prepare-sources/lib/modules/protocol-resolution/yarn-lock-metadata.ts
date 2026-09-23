import type { BackstageManifest, WorkspaceManifest } from "../../manifest-types.ts";
import type { LockfileEntry } from "../../yarn-lock-helpers.ts";
import { joinDescriptorKey } from "../../yarn-lock-helpers.ts";
import { fetchNpmPackageMetadata } from "./npm-metadata.ts";

export type PackageLockMetadata = {
  dependencies?: Record<string, string> | null;
  optionalDependencies?: Record<string, string> | null;
  dependenciesMeta?: Record<string, Record<string, unknown>> | null;
  peerDependencies?: Record<string, string> | null;
  peerDependenciesMeta?: Record<string, Record<string, unknown>> | null;
  bin?: Record<string, string> | string | null;
};

function hasProtocolRefs(deps: Record<string, string> | null | undefined): boolean {
  return (
    deps != null &&
    Object.values(deps).some((v) => v.startsWith("workspace:") || v === "backstage:^")
  );
}

function replaceProtocolRanges(
  target: Record<string, string> | null | undefined,
  source: Record<string, string> | null | undefined,
): void {
  if (!target || !source) return;
  for (const [name, range] of Object.entries(target)) {
    /* v8 ignore next 3 -- defensive: source always has matching entries */
    if (range.startsWith("workspace:") || range === "backstage:^") {
      if (source[name]) target[name] = source[name];
    }
  }
}

async function getNpmPublishedRanges(
  packageName: string,
  version: string,
  backstageManifest: BackstageManifest | null,
  log: (message: string) => void,
): Promise<Pick<PackageLockMetadata, "dependencies" | "peerDependencies"> | null> {
  if (backstageManifest) {
    const pkg = backstageManifest.packages.find(
      (p) => p.name === packageName && p.version === version,
    );
    /* v8 ignore next 5 -- null fallbacks: manifest packages have dependency fields */
    if (pkg) {
      return {
        dependencies: pkg.dependencies ?? null,
        peerDependencies: pkg.peerDependencies ?? null,
      };
    }
  }

  const metadata = await fetchNpmPackageMetadata(packageName, version, log);
  if (!metadata) return null;
  /* v8 ignore next 4 -- null fallbacks: npm metadata has dependency fields */
  return {
    dependencies: metadata.dependencies ?? null,
    peerDependencies: metadata.peerDependencies ?? null,
  };
}

async function lookupFromWorkspaceManifest(
  packageName: string,
  version: string,
  workspaceManifest: WorkspaceManifest,
  backstageManifest: BackstageManifest | null,
  log: (message: string) => void,
): Promise<PackageLockMetadata | null> {
  const pkg = workspaceManifest.packages.find((p) => p.name === packageName);
  if (!pkg) return null;

  const result: PackageLockMetadata = {
    dependencies: pkg.dependencies ? { ...pkg.dependencies } : null,
    optionalDependencies: pkg.optionalDependencies ?? null,
    peerDependencies: pkg.peerDependencies ? { ...pkg.peerDependencies } : null,
    peerDependenciesMeta: pkg.peerDependenciesMeta ?? null,
    bin: pkg.bin ?? null,
  };

  if (!hasProtocolRefs(result.dependencies) && !hasProtocolRefs(result.peerDependencies)) {
    return result;
  }

  const npmRanges = await getNpmPublishedRanges(packageName, version, backstageManifest, log);
  if (npmRanges) {
    replaceProtocolRanges(result.dependencies, npmRanges.dependencies);
    replaceProtocolRanges(result.peerDependencies, npmRanges.peerDependencies);
  }
  return result;
}

function lookupFromBackstageManifest(
  packageName: string,
  version: string,
  backstageManifest: BackstageManifest | null,
): PackageLockMetadata | null {
  const pkg = backstageManifest?.packages.find(
    (p) => p.name === packageName && p.version === version,
  );
  if (!pkg) return null;
  return {
    dependencies: pkg.dependencies ?? null,
    optionalDependencies: pkg.optionalDependencies ?? null,
    peerDependencies: pkg.peerDependencies ?? null,
    peerDependenciesMeta: pkg.peerDependenciesMeta ?? null,
    bin: pkg.bin ?? null,
  };
}

export async function getDependenciesFromManifests(
  packageName: string,
  version: string,
  workspaceManifest: WorkspaceManifest,
  backstageManifest: BackstageManifest | null,
  log: (message: string) => void,
  options: { skipWorkspaceManifest?: boolean } = {},
): Promise<PackageLockMetadata | null> {
  if (!options.skipWorkspaceManifest) {
    const result = await lookupFromWorkspaceManifest(
      packageName,
      version,
      workspaceManifest,
      backstageManifest,
      log,
    );
    if (result) return result;
  }

  return lookupFromBackstageManifest(packageName, version, backstageManifest);
}

export function resolveMonorepoProtocol(
  version: string,
  name: string,
  versionMap: Map<string, string> | null,
): string | null {
  if (!version.startsWith("workspace:") && version !== "backstage:^") return null;
  const mapped = versionMap?.get(name);
  if (mapped === undefined) return null;
  const rangeSpecifier = version.replace(/^workspace:/, "").replace(/^backstage:/, "");
  const prefix = rangeSpecifier === "^" || rangeSpecifier === "~" ? rangeSpecifier : "";
  return `${prefix}${mapped}`;
}

export async function fetchNpmMetadataForBlock(
  packageName: string,
  version: string,
  log: (message: string) => void,
): Promise<PackageLockMetadata | null> {
  const npmMetadata = await fetchNpmPackageMetadata(packageName, version, log);
  if (!npmMetadata) return null;

  let mergedDeps = npmMetadata.dependencies ? { ...npmMetadata.dependencies } : null;
  let depsMeta: Record<string, Record<string, unknown>> | null = null;

  if (npmMetadata.optionalDependencies) {
    if (!mergedDeps) mergedDeps = {};
    for (const [optName, optRange] of Object.entries(npmMetadata.optionalDependencies)) {
      mergedDeps[optName] = optRange;
    }
    depsMeta = {};
    for (const optName of Object.keys(npmMetadata.optionalDependencies)) {
      depsMeta[optName] = { optional: true };
    }
  }

  return {
    dependencies: mergedDeps,
    dependenciesMeta: depsMeta,
    peerDependencies: npmMetadata.peerDependencies ?? null,
    peerDependenciesMeta: npmMetadata.peerDependenciesMeta ?? null,
    bin: npmMetadata.bin ?? null,
  };
}

export function mergeOptionalIntoDependencies(metadata: PackageLockMetadata): void {
  if (!metadata.optionalDependencies) return;
  if (!metadata.dependencies) metadata.dependencies = {};
  if (!metadata.dependenciesMeta) metadata.dependenciesMeta = {};
  for (const [optName, optRange] of Object.entries(metadata.optionalDependencies)) {
    metadata.dependencies[optName] = optRange;
    metadata.dependenciesMeta[optName] = { optional: true };
  }
  delete metadata.optionalDependencies;
}

// ---------------------------------------------------------------------------
// Structured lockfile entry builders (used with @yarnpkg/parsers)
// ---------------------------------------------------------------------------

export function buildDependenciesField(
  deps: Record<string, string>,
  versionMap: Map<string, string> | null,
): { field: Record<string, string> | null; emittedKeys: Set<string> } {
  const entries: Record<string, string> = {};
  const emittedKeys = new Set<string>();

  for (const [name, version] of Object.entries(deps).toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const resolved = resolveMonorepoProtocol(version, name, versionMap);
    let npmVersion: string;
    if (resolved !== null) {
      npmVersion = `npm:${resolved}`;
    } else if (version.startsWith("workspace:") || version === "backstage:^") {
      continue;
    } else if (version.startsWith("npm:")) {
      npmVersion = version;
    } else {
      npmVersion = `npm:${version}`;
    }
    entries[name] = npmVersion;
    emittedKeys.add(name);
  }

  if (Object.keys(entries).length === 0) return { field: null, emittedKeys };
  return { field: entries, emittedKeys };
}

function buildPeerDependenciesField(
  peerDeps: Record<string, string>,
  versionMap: Map<string, string> | null,
): Record<string, string> | null {
  const entries: Record<string, string> = {};
  for (const [name, version] of Object.entries(peerDeps).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const resolved = resolveMonorepoProtocol(version, name, versionMap);
    entries[name] = resolved ?? version;
  }
  if (Object.keys(entries).length === 0) return null;
  return entries;
}

function stringifyMetaValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function buildDependenciesMetaField(
  depsMeta: Record<string, Record<string, unknown>>,
): Record<string, Record<string, string>> | null {
  const entries: Record<string, Record<string, string>> = {};
  for (const [name, meta] of Object.entries(depsMeta).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    entries[name] = {};
    for (const [key, value] of Object.entries(meta)) {
      entries[name][key] = stringifyMetaValue(value);
    }
  }
  if (Object.keys(entries).length === 0) return null;
  return entries;
}

function buildPeerDependenciesMetaField(
  peerDepsMeta: Record<string, Record<string, unknown>>,
): Record<string, Record<string, string>> | null {
  const entries: Record<string, Record<string, string>> = {};
  for (const [name, meta] of Object.entries(peerDepsMeta).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const entry: Record<string, string> = {};
    entries[name] = entry;
    for (const [key, value] of Object.entries(meta)) {
      entry[key] = stringifyMetaValue(value);
    }
  }
  if (Object.keys(entries).length === 0) return null;
  return entries;
}

function buildBinField(
  bin: Record<string, string> | string,
  packageName: string,
): Record<string, string> | null {
  let binObj: Record<string, string>;
  if (typeof bin === "string") {
    const unscopedName = packageName.replace(/^@[^/]+\//, "");
    binObj = { [unscopedName]: bin };
  } else {
    binObj = bin;
  }
  if (Object.keys(binObj).length === 0) return null;
  return binObj;
}

function filterDepsMeta(
  depsMeta: Record<string, Record<string, unknown>>,
  emittedDepKeys: Set<string> | null,
): Record<string, Record<string, unknown>> {
  if (!emittedDepKeys) return depsMeta;
  const filtered: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(depsMeta)) {
    if (emittedDepKeys.has(key)) filtered[key] = value;
  }
  return filtered;
}

function populateMetadataFields(
  entry: LockfileEntry,
  packageName: string,
  metadata: PackageLockMetadata,
  versionMap: Map<string, string> | null,
): void {
  let emittedDepKeys: Set<string> | null = null;
  if (metadata.dependencies) {
    const depsResult = buildDependenciesField(metadata.dependencies, versionMap);
    if (depsResult.field) {
      entry.dependencies = depsResult.field;
      emittedDepKeys = depsResult.emittedKeys;
    }
  }

  const peersField = metadata.peerDependencies
    ? buildPeerDependenciesField(metadata.peerDependencies, versionMap)
    : null;
  if (peersField) entry.peerDependencies = peersField;

  if (metadata.dependenciesMeta) {
    const metaField = buildDependenciesMetaField(
      filterDepsMeta(metadata.dependenciesMeta, emittedDepKeys),
    );
    if (metaField) entry.dependenciesMeta = metaField;
  }

  const peersMetaField = metadata.peerDependenciesMeta
    ? buildPeerDependenciesMetaField(metadata.peerDependenciesMeta)
    : null;
  if (peersMetaField) entry.peerDependenciesMeta = peersMetaField;

  const binField = metadata.bin ? buildBinField(metadata.bin, packageName) : null;
  if (binField) entry.bin = binField;
}

/** Build a complete npm resolution entry for appending to a parsed lockfile. */
export function buildResolutionEntry(
  packageName: string,
  version: string,
  descriptors: string[],
  metadata: PackageLockMetadata,
  versionMap: Map<string, string> | null,
): { key: string; entry: LockfileEntry } {
  const entry: LockfileEntry = {
    version,
    resolution: `${packageName}@npm:${version}`,
  };

  populateMetadataFields(entry, packageName, metadata, versionMap);

  entry.languageName = "node";
  entry.linkType = "hard";

  const key = joinDescriptorKey([...descriptors].toSorted((a, b) => a.localeCompare(b)));
  return { key, entry };
}

/** Build a soft-linked workspace entry (e.g. type-shims pre-wire). */
export function buildWorkspaceSoftEntry(
  packageName: string,
  workspacePath: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): { key: string; entry: LockfileEntry } {
  const entry: LockfileEntry = {
    version: "0.0.0-use.local",
    resolution: `${packageName}@workspace:${workspacePath}`,
    languageName: "unknown",
    linkType: "soft",
  };

  if (Object.keys(deps).length > 0) {
    const depsField: Record<string, string> = {};
    for (const [name, version] of Object.entries(deps).toSorted((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      depsField[name] = version.startsWith("npm:") ? version : `npm:${version}`;
    }
    entry.dependencies = depsField;
  }

  if (Object.keys(devDeps).length > 0) {
    const devDepsField: Record<string, string> = {};
    for (const [name, version] of Object.entries(devDeps).toSorted((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      devDepsField[name] = version.startsWith("npm:") ? version : `npm:${version}`;
    }
    entry.devDependencies = devDepsField;
  }

  const key = `${packageName}@workspace:${workspacePath}`;
  return { key, entry };
}
