import type { BackstageManifest, WorkspaceManifest } from "../../manifest-types.ts";
import type { LockfileBlock, MapField, NestedMapField } from "../../yarn-lock-parser.ts";
import { buildMapField } from "../../yarn-lock-helpers.ts";
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
    if (pkg) {
      return {
        dependencies: pkg.dependencies ?? null,
        peerDependencies: pkg.peerDependencies ?? null,
      };
    }
  }

  const metadata = await fetchNpmPackageMetadata(packageName, version, log);
  if (!metadata) return null;
  return {
    dependencies: metadata.dependencies ?? null,
    peerDependencies: metadata.peerDependencies ?? null,
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
    const pkg = workspaceManifest.packages.find((p) => p.name === packageName);
    if (pkg) {
      const result: PackageLockMetadata = {
        dependencies: pkg.dependencies ? { ...pkg.dependencies } : null,
        optionalDependencies: pkg.optionalDependencies ?? null,
        peerDependencies: pkg.peerDependencies ? { ...pkg.peerDependencies } : null,
        peerDependenciesMeta: pkg.peerDependenciesMeta ?? null,
        bin: pkg.bin ?? null,
      };

      if (hasProtocolRefs(result.dependencies) || hasProtocolRefs(result.peerDependencies)) {
        const npmRanges = await getNpmPublishedRanges(packageName, version, backstageManifest, log);
        if (npmRanges) {
          replaceProtocolRanges(result.dependencies, npmRanges.dependencies);
          replaceProtocolRanges(result.peerDependencies, npmRanges.peerDependencies);
        }
      }
      return result;
    }
  }

  if (backstageManifest) {
    const pkg = backstageManifest.packages.find(
      (p) => p.name === packageName && p.version === version,
    );
    if (pkg) {
      return {
        dependencies: pkg.dependencies ?? null,
        optionalDependencies: pkg.optionalDependencies ?? null,
        peerDependencies: pkg.peerDependencies ?? null,
        peerDependenciesMeta: pkg.peerDependenciesMeta ?? null,
        bin: pkg.bin ?? null,
      };
    }
  }

  return null;
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
// Structured lockfile block builders (used with yarn-lock-parser)
// ---------------------------------------------------------------------------

export function buildDependenciesMapField(
  deps: Record<string, string>,
  versionMap: Map<string, string> | null,
): { field: MapField | null; emittedKeys: Set<string> } {
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
    entries[`"${name}"`] = `"${npmVersion}"`;
    emittedKeys.add(name);
  }

  if (Object.keys(entries).length === 0) return { field: null, emittedKeys };
  return { field: buildMapField(entries), emittedKeys };
}

function buildPeerDependenciesMapField(
  peerDeps: Record<string, string>,
  versionMap: Map<string, string> | null,
): MapField | null {
  const entries: Record<string, string> = {};
  for (const [name, version] of Object.entries(peerDeps).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const resolved = resolveMonorepoProtocol(version, name, versionMap);
    entries[`"${name}"`] = `"${resolved !== null ? resolved : version}"`;
  }
  if (Object.keys(entries).length === 0) return null;
  return buildMapField(entries);
}

function buildDependenciesMetaField(
  depsMeta: Record<string, Record<string, unknown>>,
): NestedMapField | null {
  const entries: Record<string, Record<string, string>> = {};
  for (const [name, meta] of Object.entries(depsMeta).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    entries[name] = {};
    for (const [key, value] of Object.entries(meta)) {
      entries[name][key] = String(value);
    }
  }
  if (Object.keys(entries).length === 0) return null;
  return { kind: "nested-map", entries };
}

function buildPeerDependenciesMetaField(
  peerDepsMeta: Record<string, Record<string, unknown>>,
): NestedMapField | null {
  const entries: Record<string, Record<string, string>> = {};
  for (const [name, meta] of Object.entries(peerDepsMeta).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const entry: Record<string, string> = {};
    entries[`"${name}"`] = entry;
    for (const [key, value] of Object.entries(meta)) {
      entry[key] = String(value);
    }
  }
  if (Object.keys(entries).length === 0) return null;
  return { kind: "nested-map", entries };
}

function buildBinMapField(
  bin: Record<string, string> | string,
  packageName: string,
): MapField | null {
  let binObj: Record<string, string>;
  if (typeof bin === "string") {
    const unscopedName = packageName.replace(/^@[^/]+\//, "");
    binObj = { [unscopedName]: bin };
  } else {
    binObj = bin;
  }
  if (Object.keys(binObj).length === 0) return null;
  const entries: Record<string, string> = {};
  for (const [name, binPath] of Object.entries(binObj).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    entries[name] = binPath;
  }
  return buildMapField(entries);
}

/** Build a complete npm resolution block for appending to a parsed lockfile. */
export function buildResolutionBlock(
  packageName: string,
  version: string,
  descriptors: string[],
  metadata: PackageLockMetadata,
  versionMap: Map<string, string> | null,
): LockfileBlock {
  const fields: LockfileBlock["fields"] = {
    version: { kind: "scalar", raw: version },
    resolution: { kind: "scalar", raw: `"${packageName}@npm:${version}"` },
  };

  let emittedDepKeys: Set<string> | null = null;
  if (metadata.dependencies) {
    const depsResult = buildDependenciesMapField(metadata.dependencies, versionMap);
    if (depsResult.field) {
      fields.dependencies = depsResult.field;
      emittedDepKeys = depsResult.emittedKeys;
    }
  }
  if (metadata.peerDependencies) {
    const peersField = buildPeerDependenciesMapField(metadata.peerDependencies, versionMap);
    if (peersField) fields.peerDependencies = peersField;
  }
  if (metadata.dependenciesMeta) {
    let filteredMeta = metadata.dependenciesMeta;
    if (emittedDepKeys) {
      filteredMeta = {};
      for (const [key, value] of Object.entries(metadata.dependenciesMeta)) {
        if (emittedDepKeys.has(key)) filteredMeta[key] = value;
      }
    }
    const metaField = buildDependenciesMetaField(filteredMeta);
    if (metaField) fields.dependenciesMeta = metaField;
  }
  if (metadata.peerDependenciesMeta) {
    const peersMetaField = buildPeerDependenciesMetaField(metadata.peerDependenciesMeta);
    if (peersMetaField) fields.peerDependenciesMeta = peersMetaField;
  }
  if (metadata.bin) {
    const binField = buildBinMapField(metadata.bin, packageName);
    if (binField) fields.bin = binField;
  }

  fields.languageName = { kind: "scalar", raw: "node" };
  fields.linkType = { kind: "scalar", raw: "hard" };

  return {
    descriptors: [...descriptors].toSorted((a, b) => a.localeCompare(b)),
    fields,
  };
}

/** Build a soft-linked workspace block (e.g. type-shims pre-wire entry). */
export function buildWorkspaceSoftBlock(
  packageName: string,
  workspacePath: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): LockfileBlock {
  const fields: LockfileBlock["fields"] = {
    version: { kind: "scalar", raw: "0.0.0-use.local" },
    resolution: {
      kind: "scalar",
      raw: `"${packageName}@workspace:${workspacePath}"`,
    },
    languageName: { kind: "scalar", raw: "unknown" },
    linkType: { kind: "scalar", raw: "soft" },
  };

  if (Object.keys(deps).length > 0) {
    const entries: Record<string, string> = {};
    for (const [name, version] of Object.entries(deps).toSorted((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const npmVersion = version.startsWith("npm:") ? version : `npm:${version}`;
      entries[`"${name}"`] = `"${npmVersion}"`;
    }
    fields.dependencies = buildMapField(entries);
  }

  if (Object.keys(devDeps).length > 0) {
    const entries: Record<string, string> = {};
    for (const [name, version] of Object.entries(devDeps).toSorted((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const npmVersion = version.startsWith("npm:") ? version : `npm:${version}`;
      entries[`"${name}"`] = `"${npmVersion}"`;
    }
    fields.devDependencies = buildMapField(entries);
  }

  return {
    descriptors: [`${packageName}@workspace:${workspacePath}`],
    fields,
  };
}
