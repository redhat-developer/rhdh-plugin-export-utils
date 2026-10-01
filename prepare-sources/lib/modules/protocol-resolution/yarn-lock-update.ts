import fs from "node:fs";
import path from "node:path";
import type { BackstageManifest, WorkspaceManifest } from "../../manifest-types.ts";
import type { Lockfile, LockfileBlock } from "../../yarn-lock-parser.ts";
import { parseLockfile, serializeLockfile } from "../../yarn-lock-parser.ts";
import {
  blockHasStaleWorkspacePath,
  blockHasWorkspaceProtocol,
  collectNpmDepReferences,
  extractNpmSpecifiers,
  findLocalPackagePaths,
  packageNameFromDescriptor,
  hasNpmSpecifierBlock,
  replaceProtocolDepValues,
  unquote,
  workspaceProtocolPackageName,
} from "../../yarn-lock-helpers.ts";
import { createMissingResolutionBlocks } from "./yarn-lock-blocks.ts";
import {
  enrichNpmBlockSpecifiers,
  normalizeCombinedKeysForLocalPackage,
} from "./yarn-lock-enrich.ts";
import { findPackageVersion } from "./utils.ts";

export type YarnLockUpdateResult = {
  updates: number;
};

type LockUpdateState = {
  lockfile: Lockfile;
  versionMap: Map<string, string>;
  localPackagePaths: Map<string, string>;
  transformedNonLocalPackages: Map<string, string>;
  deletedWorkspaceBlocks: Map<string, string[]>;
  deletedStalePathPackages: Set<string>;
  processedPackages: Set<string>;
  workspacePath: string;
  log: (message: string) => void;
};

/**
 * Rewrite yarn.lock: delete stale workspace blocks, convert protocol refs to npm,
 * recreate missing resolution blocks, enrich specifiers.
 */
export async function updateYarnLock(
  yarnLockPath: string,
  versionMap: Map<string, string>,
  workspaceManifest: WorkspaceManifest,
  backstageManifest: BackstageManifest | null,
  workspacePath: string,
  log: (message: string) => void,
): Promise<YarnLockUpdateResult> {
  if (!fs.existsSync(yarnLockPath)) {
    throw new Error(`yarn.lock not found at ${yarnLockPath}`);
  }

  const yarnLockDir = path.dirname(yarnLockPath);
  const lockfile = parseLockfile(fs.readFileSync(yarnLockPath, "utf8"));
  const state: LockUpdateState = {
    lockfile,
    versionMap,
    localPackagePaths: findLocalPackagePaths(lockfile, yarnLockDir),
    transformedNonLocalPackages: new Map(),
    deletedWorkspaceBlocks: new Map(),
    deletedStalePathPackages: new Set(),
    processedPackages: new Set(),
    workspacePath,
    log,
  };

  let updateCount = 0;
  updateCount += deleteStaleAndNonLocalWorkspaceBlocks(state, yarnLockDir);
  pruneStaleFromDeletedBlocks(state);
  seedTransformedFromDeleted(state);
  updateCount += applyVersionMapPackageUpdates(state);

  const { remainingPackages, unresolvedPackages } = collectRemainingProtocolRefs(state);
  logUnresolvedPackages(state, unresolvedPackages);
  updateCount += applyRemainingPackageUpdates(state, remainingPackages);

  updateCount += await createMissingResolutionBlocks({
    lockfile,
    transformedPackages: state.transformedNonLocalPackages,
    versionMap,
    deletedWorkspaceBlocks: state.deletedWorkspaceBlocks,
    workspaceManifest,
    backstageManifest,
    log,
  });

  const localPackagesForNpmBlocks = new Map<string, string>();
  for (const [pkgName] of state.localPackagePaths) {
    const version = versionMap.get(pkgName);
    if (version) localPackagesForNpmBlocks.set(pkgName, version);
  }
  if (localPackagesForNpmBlocks.size > 0) {
    updateCount += await createMissingResolutionBlocks({
      lockfile,
      transformedPackages: localPackagesForNpmBlocks,
      versionMap,
      deletedWorkspaceBlocks: state.deletedWorkspaceBlocks,
      workspaceManifest,
      backstageManifest,
      log,
      skipNpmFallback: true,
    });
  }

  const alreadyProcessed = new Set([
    ...state.transformedNonLocalPackages.keys(),
    ...localPackagesForNpmBlocks.keys(),
  ]);
  updateCount += await resolveDanglingDeps(
    state,
    workspaceManifest,
    backstageManifest,
    1,
    alreadyProcessed,
  );

  const enriched = enrichNpmBlockSpecifiers(lockfile, log);
  if (enriched > 0) {
    log(`yarn.lock: enriched ${enriched} npm block specifier(s)`);
    updateCount += enriched;
  }

  if (updateCount > 0) {
    fs.writeFileSync(yarnLockPath, serializeLockfile(lockfile));
  }

  log(`yarn.lock: ${updateCount} updates applied`);
  return { updates: updateCount };
}

/** Pass 1: remove stale-path and scrubbed-package workspace protocol blocks. */
function deleteStaleAndNonLocalWorkspaceBlocks(
  state: LockUpdateState,
  yarnLockDir: string,
): number {
  let updateCount = 0;
  const survivingBlocks: LockfileBlock[] = [];

  for (const block of state.lockfile.blocks) {
    const staleDeleted = tryDeleteStalePathBlock(state, block, yarnLockDir);
    if (staleDeleted !== null) {
      updateCount += staleDeleted;
      continue;
    }

    const nonLocalDeleted = tryDeleteNonLocalWorkspaceBlock(state, block);
    if (nonLocalDeleted !== null) {
      updateCount += nonLocalDeleted;
      continue;
    }

    survivingBlocks.push(block);
  }

  state.lockfile.blocks = survivingBlocks;
  return updateCount;
}

/** @returns update count if deleted, or null if the block should be kept. */
function tryDeleteStalePathBlock(
  state: LockUpdateState,
  block: LockfileBlock,
  yarnLockDir: string,
): number | null {
  if (!blockHasStaleWorkspacePath(block, yarnLockDir)) return null;
  const pkgName =
    workspaceProtocolPackageName(block) ?? packageNameFromDescriptor(block.descriptors[0] ?? "");
  if (!pkgName) return null;

  state.deletedStalePathPackages.add(pkgName);
  state.log(`yarn.lock: deleted stale workspace block for ${pkgName}`);
  return 1;
}

/** @returns update count if deleted, or null if the block should be kept. */
function tryDeleteNonLocalWorkspaceBlock(
  state: LockUpdateState,
  block: LockfileBlock,
): number | null {
  if (!blockHasWorkspaceProtocol(block)) return null;
  const pkgName = workspaceProtocolPackageName(block);
  if (!pkgName || state.localPackagePaths.has(pkgName)) return null;

  if (state.deletedStalePathPackages.has(pkgName)) {
    state.log(`yarn.lock: deleted workspace:^ block for stale package ${pkgName}`);
    return 1;
  }

  if (!state.versionMap.has(pkgName)) {
    state.log(`yarn.lock: warning: no version found for ${pkgName} in version map`);
    return null;
  }

  const npmSpecifiers = extractNpmSpecifiers(block, pkgName);
  const existing = state.deletedWorkspaceBlocks.get(pkgName) ?? [];
  state.deletedWorkspaceBlocks.set(pkgName, [...existing, ...npmSpecifiers]);
  state.log(
    `yarn.lock: deleted workspace block for ${pkgName}` +
      (npmSpecifiers.length ? ` (preserving npm specifiers: ${npmSpecifiers.join(", ")})` : ""),
  );
  return 1;
}

function pruneStaleFromDeletedBlocks(state: LockUpdateState): void {
  for (const stalePkg of state.deletedStalePathPackages) {
    if (!state.deletedWorkspaceBlocks.has(stalePkg)) continue;
    state.log(`yarn.lock: removing ${stalePkg} from workspace block recreation — package is stale`);
    state.deletedWorkspaceBlocks.delete(stalePkg);
  }
}

function seedTransformedFromDeleted(state: LockUpdateState): void {
  for (const [pkgName] of state.deletedWorkspaceBlocks) {
    const version = state.versionMap.get(pkgName);
    if (version) state.transformedNonLocalPackages.set(pkgName, version);
  }
}

/** Pass 2: rewrite protocol deps / normalize combined keys for version-map packages. */
function applyVersionMapPackageUpdates(state: LockUpdateState): number {
  let updateCount = 0;

  for (const [packageName, newVersion] of state.versionMap) {
    state.processedPackages.add(packageName);
    updateCount += updateOneVersionMapPackage(state, packageName, newVersion);
  }

  return updateCount;
}

function updateOneVersionMapPackage(
  state: LockUpdateState,
  packageName: string,
  newVersion: string,
): number {
  const localPath = state.localPackagePaths.get(packageName);
  if (localPath === undefined) {
    const replaced = replaceProtocolDepValues(state.lockfile, packageName, newVersion);
    if (replaced <= 0) return 0;
    state.log(`yarn.lock: updated dependency ${packageName} to npm:${newVersion}`);
    state.transformedNonLocalPackages.set(packageName, newVersion);
    return replaced;
  }

  const normalized = normalizeCombinedKeysForLocalPackage(state.lockfile, packageName, localPath);
  if (normalized <= 0) return 0;
  state.log(`yarn.lock: normalized combined key for local package ${packageName}`);
  return normalized;
}

/** Pass 3 scan: find leftover workspace:/backstage:^ refs not yet processed. */
function collectRemainingProtocolRefs(state: LockUpdateState): {
  remainingPackages: Map<string, string>;
  unresolvedPackages: string[];
} {
  const remainingPackages = new Map<string, string>();
  const unresolvedPackages: string[] = [];

  for (const block of state.lockfile.blocks) {
    collectRefsFromDepMaps(state, block, remainingPackages, unresolvedPackages);
    collectRefFromWorkspaceBlockKey(state, block, remainingPackages, unresolvedPackages);
  }

  return { remainingPackages, unresolvedPackages };
}

function collectRefsFromDepMaps(
  state: LockUpdateState,
  block: LockfileBlock,
  remainingPackages: Map<string, string>,
  unresolvedPackages: string[],
): void {
  for (const field of Object.values(block.fields)) {
    if (field.kind !== "map") continue;
    for (const [depName, rawValue] of Object.entries(field.entries)) {
      const name = unquote(depName);
      const value = unquote(rawValue);
      if (!/^(?:workspace:[*^]?|backstage:\^)$/.exec(value)) continue;
      if (state.processedPackages.has(name) || remainingPackages.has(name)) continue;
      recordResolvedOrUnresolved(state, name, remainingPackages, unresolvedPackages);
    }
  }
}

function collectRefFromWorkspaceBlockKey(
  state: LockUpdateState,
  block: LockfileBlock,
  remainingPackages: Map<string, string>,
  unresolvedPackages: string[],
): void {
  if (!blockHasWorkspaceProtocol(block)) return;
  const pkgName = workspaceProtocolPackageName(block);
  if (!pkgName) return;
  if (state.processedPackages.has(pkgName) || remainingPackages.has(pkgName)) return;
  recordResolvedOrUnresolved(state, pkgName, remainingPackages, unresolvedPackages);
}

function recordResolvedOrUnresolved(
  state: LockUpdateState,
  name: string,
  remainingPackages: Map<string, string>,
  unresolvedPackages: string[],
): void {
  const resolved = state.versionMap.get(name) ?? findPackageVersion(name, state.workspacePath);
  if (resolved) {
    remainingPackages.set(name, resolved);
    return;
  }
  if (!unresolvedPackages.includes(name)) unresolvedPackages.push(name);
}

function logUnresolvedPackages(state: LockUpdateState, unresolvedPackages: string[]): void {
  if (unresolvedPackages.length === 0) return;
  state.log(
    `yarn.lock: warning: ${unresolvedPackages.length} package(s) with workspace:/backstage:^ references could not be resolved`,
  );
  for (const pkg of unresolvedPackages) {
    state.log(`  - ${pkg} (not in versionMap, not found on disk)`);
  }
}

/** Pass 3 apply: rewrite remaining refs and delete leftover workspace blocks. */
function applyRemainingPackageUpdates(
  state: LockUpdateState,
  remainingPackages: Map<string, string>,
): number {
  let updateCount = 0;
  for (const [packageName, version] of remainingPackages) {
    updateCount += applyOneRemainingPackage(state, packageName, version);
  }
  return updateCount;
}

function applyOneRemainingPackage(
  state: LockUpdateState,
  packageName: string,
  version: string,
): number {
  let updateCount = 0;

  const replaced = replaceProtocolDepValues(state.lockfile, packageName, version);
  if (replaced > 0) {
    updateCount += replaced;
    state.log(
      `yarn.lock: updated dependency ${packageName} to npm:^${version} (from remaining scan)`,
    );
    if (!state.localPackagePaths.has(packageName)) {
      state.transformedNonLocalPackages.set(packageName, version);
    }
  }

  updateCount += deleteRemainingWorkspaceBlockIfNeeded(state, packageName, version);
  return updateCount;
}

function deleteRemainingWorkspaceBlockIfNeeded(
  state: LockUpdateState,
  packageName: string,
  version: string,
): number {
  if (state.localPackagePaths.has(packageName)) return 0;
  if (state.deletedStalePathPackages.has(packageName)) return 0;

  const blocksToRemove = state.lockfile.blocks.filter((block) => {
    if (!blockHasWorkspaceProtocol(block)) return false;
    return workspaceProtocolPackageName(block) === packageName;
  });
  if (blocksToRemove.length === 0) return 0;

  const npmSpecifiers = blocksToRemove.flatMap((b) => extractNpmSpecifiers(b, packageName));
  const existing = state.deletedWorkspaceBlocks.get(packageName) ?? [];
  state.deletedWorkspaceBlocks.set(packageName, [...existing, ...npmSpecifiers]);
  state.transformedNonLocalPackages.set(packageName, version);
  state.lockfile.blocks = state.lockfile.blocks.filter((b) => !blocksToRemove.includes(b));
  state.log(
    `yarn.lock: deleted remaining workspace block for ${packageName}` +
      (npmSpecifiers.length ? ` (preserving npm specifiers: ${npmSpecifiers.join(", ")})` : ""),
  );
  return 1;
}

/** Multi-pass: create npm blocks for deps introduced by previously created blocks. */
async function resolveDanglingDeps(
  state: LockUpdateState,
  workspaceManifest: WorkspaceManifest,
  backstageManifest: BackstageManifest | null,
  pass: number,
  alreadyProcessed: Set<string>,
): Promise<number> {
  if (pass > 10) return 0;

  const danglingPackages = collectDanglingPackages(state, alreadyProcessed);
  if (danglingPackages.size === 0) return 0;

  state.log(
    `yarn.lock: dangling-dep pass ${pass}: creating blocks for ${danglingPackages.size} package(s)`,
  );
  const created = await createMissingResolutionBlocks({
    lockfile: state.lockfile,
    transformedPackages: danglingPackages,
    versionMap: state.versionMap,
    deletedWorkspaceBlocks: state.deletedWorkspaceBlocks,
    workspaceManifest,
    backstageManifest,
    log: state.log,
  });

  for (const name of danglingPackages.keys()) {
    alreadyProcessed.add(name);
  }

  return (
    created +
    (await resolveDanglingDeps(
      state,
      workspaceManifest,
      backstageManifest,
      pass + 1,
      alreadyProcessed,
    ))
  );
}

function collectDanglingPackages(
  state: LockUpdateState,
  alreadyProcessed: Set<string>,
): Map<string, string> {
  const danglingPackages = new Map<string, string>();
  const allRefs = collectNpmDepReferences(state.lockfile);

  for (const [depName, ranges] of allRefs) {
    if (alreadyProcessed.has(depName)) continue;
    const version = state.versionMap.get(depName);
    if (version === undefined) continue;

    const needsBlock = [...ranges].some(
      (range) => !hasNpmSpecifierBlock(state.lockfile, depName, range),
    );
    if (needsBlock) danglingPackages.set(depName, version);
  }

  return danglingPackages;
}
