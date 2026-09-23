import type { BackstageManifest, WorkspaceManifest } from "../../manifest-types.ts";
import type { Lockfile, LockfileBlock } from "../../yarn-lock-parser.ts";
import {
  blockLinkType,
  hasDescriptorSpecifier,
  hasNpmResolutionBlock,
} from "../../yarn-lock-helpers.ts";
import {
  buildResolutionBlock,
  fetchNpmMetadataForBlock,
  getDependenciesFromManifests,
  mergeOptionalIntoDependencies,
  type PackageLockMetadata,
} from "./yarn-lock-metadata.ts";

type ResolutionBlocksContext = {
  lockfile: Lockfile;
  versionMap: Map<string, string>;
  deletedWorkspaceBlocks: Map<string, string[]>;
  workspaceManifest: WorkspaceManifest;
  backstageManifest: BackstageManifest | null;
  log: (message: string) => void;
  skipNpmFallback: boolean;
};

export type ResolutionBlocksParams = {
  lockfile: Lockfile;
  transformedPackages: Map<string, string>;
  versionMap: Map<string, string>;
  deletedWorkspaceBlocks: Map<string, string[]>;
  workspaceManifest: WorkspaceManifest;
  backstageManifest: BackstageManifest | null;
  log: (message: string) => void;
  skipNpmFallback?: boolean;
};

export async function createMissingResolutionBlocks(
  params: ResolutionBlocksParams,
): Promise<number> {
  const ctx: ResolutionBlocksContext = {
    lockfile: params.lockfile,
    versionMap: params.versionMap,
    deletedWorkspaceBlocks: params.deletedWorkspaceBlocks,
    workspaceManifest: params.workspaceManifest,
    backstageManifest: params.backstageManifest,
    log: params.log,
    skipNpmFallback: params.skipNpmFallback ?? false,
  };

  let updateCount = 0;
  const npmFetchFailures: string[] = [];
  const inconsistentBlocks: string[] = [];

  for (const [packageName, version] of params.transformedPackages) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: each block may depend on prior results
    const result = await processOnePackage(ctx, packageName, version, inconsistentBlocks);
    if (result === "skip") continue;
    if (result === "fetch-failed") {
      npmFetchFailures.push(`${packageName}@${version}`);
      continue;
    }
    updateCount += result;
  }

  throwOnFailures(npmFetchFailures, inconsistentBlocks);
  return updateCount;
}

function throwOnFailures(npmFetchFailures: string[], inconsistentBlocks: string[]): void {
  const totalFailures = npmFetchFailures.length + inconsistentBlocks.length;
  if (totalFailures > 0) {
    const failedPkgs = [...npmFetchFailures, ...inconsistentBlocks];
    throw new Error(`Cannot produce consistent yarn.lock: ${failedPkgs.join(", ")}`);
  }
}

async function processOnePackage(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
  inconsistentBlocks: string[],
): Promise<number | "skip" | "fetch-failed"> {
  if (hasNpmResolutionBlock(ctx.lockfile, packageName, version)) {
    flagInconsistentSoftBlocks(ctx, packageName, version, inconsistentBlocks);
    return "skip";
  }

  const resolved = await resolveMetadata(ctx, packageName, version);
  if (resolved === "fetch-failed") return "fetch-failed";

  const { metadata, fromCache } = resolved;
  mergeOptionalIntoDependencies(metadata);

  return appendBlock(ctx, packageName, version, metadata, fromCache, inconsistentBlocks);
}

function flagInconsistentSoftBlocks(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
  inconsistentBlocks: string[],
): void {
  const npmBlocks = ctx.lockfile.blocks.filter((b) =>
    b.descriptors.some((d) => d.includes(`${packageName}@npm:`)),
  );
  for (const block of npmBlocks) {
    if (blockLinkType(block) === "soft") {
      ctx.log(
        `yarn.lock: warning: surviving block for ${packageName} has linkType: soft — inconsistent with npm key`,
      );
      inconsistentBlocks.push(`${packageName}@${version} (surviving block has linkType: soft)`);
    }
  }
}

async function resolveMetadata(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
): Promise<{ metadata: PackageLockMetadata; fromCache: boolean } | "fetch-failed"> {
  let metadata = await getDependenciesFromManifests(
    packageName,
    version,
    ctx.workspaceManifest,
    ctx.backstageManifest,
    ctx.log,
  );

  let fromCache = true;

  if (metadata) {
    const result = handleManifestMetadata(ctx, packageName, version, metadata);
    if (result === "cleared") {
      metadata = null;
      fromCache = false;
    }
  } else {
    fromCache = false;
  }

  if (!metadata && !ctx.skipNpmFallback) {
    ctx.log(`yarn.lock: fetching npm metadata for ${packageName}@${version}...`);
    metadata = await fetchNpmMetadataForBlock(packageName, version, ctx.log);
  }

  if (!metadata) {
    return resolveEmptyMetadata(ctx, packageName, version);
  }

  return { metadata, fromCache };
}

function handleManifestMetadata(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
  metadata: PackageLockMetadata,
): "ok" | "cleared" {
  const hasSubstance =
    metadata.dependencies ||
    metadata.optionalDependencies ||
    metadata.peerDependencies ||
    metadata.bin;

  if (hasSubstance) {
    ctx.log(`yarn.lock: using cached metadata for ${packageName}@${version}`);
    return "ok";
  }

  if (ctx.skipNpmFallback) {
    ctx.log(
      `yarn.lock: manifest entry for ${packageName}@${version} has no deps — using empty metadata`,
    );
    return "ok";
  }

  ctx.log(
    `yarn.lock: manifest entry for ${packageName}@${version} has no deps — falling through to npm`,
  );
  return "cleared";
}

function resolveEmptyMetadata(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
): { metadata: PackageLockMetadata; fromCache: boolean } | "fetch-failed" {
  if (ctx.skipNpmFallback) {
    ctx.log(
      `yarn.lock: no metadata for local package ${packageName}@${version} — creating minimal block`,
    );
    return { metadata: {}, fromCache: true };
  }
  return "fetch-failed";
}

function appendBlock(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
  metadata: PackageLockMetadata,
  fromCache: boolean,
  inconsistentBlocks: string[],
): number | "skip" {
  const wasDeletedWorkspaceBlock = ctx.deletedWorkspaceBlocks.has(packageName);
  const allSpecifiers = collectSpecifiers(ctx, packageName, version, wasDeletedWorkspaceBlock);

  if (allSpecifiers.length === 0) {
    return handleNoSpecifiers(
      ctx,
      packageName,
      version,
      wasDeletedWorkspaceBlock,
      inconsistentBlocks,
    );
  }

  const uniqueSpecifiers = [...new Set(allSpecifiers)];
  const block = buildResolutionBlock(
    packageName,
    version,
    uniqueSpecifiers,
    metadata,
    fromCache ? ctx.versionMap : null,
  );
  ctx.lockfile.blocks.push(block);

  ctx.log(
    `yarn.lock: created resolution block for ${uniqueSpecifiers.toSorted((a, b) => a.localeCompare(b)).join(", ")}`,
  );
  return wasDeletedWorkspaceBlock ? 0 : 1;
}

function collectSpecifiers(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
  wasDeletedWorkspaceBlock: boolean,
): string[] {
  const newSpecifier = `${packageName}@npm:^${version}`;
  const specCandidates = [newSpecifier];
  if (wasDeletedWorkspaceBlock) {
    const preserved = ctx.deletedWorkspaceBlocks.get(packageName);
    if (preserved && preserved.length > 0) specCandidates.push(...preserved);
  }

  const allSpecifiers: string[] = [];
  for (const spec of specCandidates) {
    if (!hasDescriptorSpecifier(ctx.lockfile, spec)) {
      allSpecifiers.push(spec);
    } else {
      ctx.log(`yarn.lock: dropping specifier ${spec} — already satisfied by a surviving block`);
    }
  }
  return allSpecifiers;
}

function handleNoSpecifiers(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
  wasDeletedWorkspaceBlock: boolean,
  inconsistentBlocks: string[],
): "skip" {
  if (wasDeletedWorkspaceBlock) {
    warnIfSoftBlockSurvives(ctx, packageName, version, inconsistentBlocks);
  }
  ctx.log(
    `yarn.lock: all specifiers for ${packageName}@${version} already satisfied — skipping block creation`,
  );
  return "skip";
}

function warnIfSoftBlockSurvives(
  ctx: ResolutionBlocksContext,
  packageName: string,
  version: string,
  inconsistentBlocks: string[],
): void {
  const softBlock = findSoftNpmBlock(ctx.lockfile, packageName);
  if (softBlock) {
    ctx.log(
      `yarn.lock: warning: surviving block for ${packageName} has linkType: soft — may produce wrong dependency ranges`,
    );
    inconsistentBlocks.push(`${packageName}@${version} (surviving block has linkType: soft)`);
  }
}

function findSoftNpmBlock(lockfile: Lockfile, packageName: string): LockfileBlock | undefined {
  return lockfile.blocks.find(
    (b) =>
      b.descriptors.some((d) => d.includes(`${packageName}@npm:`)) && blockLinkType(b) === "soft",
  );
}
