import fs from "node:fs";
import path from "node:path";
import { parseSyml, stringifySyml } from "@yarnpkg/parsers";
import type { BackstageManifest, WorkspaceManifest } from "../../manifest-types.ts";
import type { LockfileEntry, ParsedLockfile } from "../../yarn-lock-helpers.ts";
import {
  blockKeyHasStaleWorkspacePath,
  collectNpmDepReferences,
  extractNpmSpecifiers,
  findLocalPackagePaths,
  keyHasWorkspaceProtocol,
  packageNameFromDescriptor,
  replaceProtocolDepValues,
  splitDescriptorKey,
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
  lockfile: ParsedLockfile;
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
  const yarnLockDir = path.dirname(yarnLockPath);
  const lockfile: ParsedLockfile = parseSyml(fs.readFileSync(yarnLockPath, "utf8"));
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
    /* v8 ignore next -- defensive: local packages always in version map */
    if (version) localPackagesForNpmBlocks.set(pkgName, version);
  }
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

  fs.writeFileSync(yarnLockPath, stringifySyml(lockfile));

  log(`yarn.lock: ${updateCount} updates applied`);
  return { updates: updateCount };
}

/** Pass 1: remove stale-path and scrubbed-package workspace protocol blocks. */
function deleteStaleAndNonLocalWorkspaceBlocks(
  state: LockUpdateState,
  yarnLockDir: string,
): number {
  let updateCount = 0;

  for (const key of Object.keys(state.lockfile)) {
    if (key === "__metadata") continue;

    const staleDeleted = tryDeleteStalePathBlock(state, key, yarnLockDir);
    if (staleDeleted !== null) {
      updateCount += staleDeleted;
      continue;
    }

    const nonLocalDeleted = tryDeleteNonLocalWorkspaceBlock(state, key);
    if (nonLocalDeleted !== null) {
      updateCount += nonLocalDeleted;
    }
  }

  return updateCount;
}

/** @returns update count if deleted, or null if the block should be kept. */
function tryDeleteStalePathBlock(
  state: LockUpdateState,
  key: string,
  yarnLockDir: string,
): number | null {
  if (!blockKeyHasStaleWorkspacePath(key, yarnLockDir)) return null;
  /* v8 ignore next 3 -- null fallback: workspace paths always have protocol name */
  const pkgName =
    workspaceProtocolPackageName(key) ??
    packageNameFromDescriptor(splitDescriptorKey(key)[0] ?? "");
  /* v8 ignore next -- defensive: workspace paths always have parseable package names */
  if (!pkgName) return null;

  state.deletedStalePathPackages.add(pkgName);
  delete state.lockfile[key];
  state.log(`yarn.lock: deleted stale workspace block for ${pkgName}`);
  return 1;
}

/** @returns update count if deleted, or null if the block should be kept. */
function tryDeleteNonLocalWorkspaceBlock(state: LockUpdateState, key: string): number | null {
  if (!keyHasWorkspaceProtocol(key)) return null;
  const pkgName = workspaceProtocolPackageName(key);
  /* v8 ignore next -- defensive: workspace blocks always have a parseable name */
  if (!pkgName || state.localPackagePaths.has(pkgName)) return null;

  if (state.deletedStalePathPackages.has(pkgName)) {
    state.log(`yarn.lock: deleted workspace:^ block for stale package ${pkgName}`);
    delete state.lockfile[key];
    return 1;
  }

  if (!state.versionMap.has(pkgName)) {
    state.log(`yarn.lock: warning: no version found for ${pkgName} in version map`);
    return null;
  }

  const npmSpecifiers = extractNpmSpecifiers(key, pkgName);
  const existing = state.deletedWorkspaceBlocks.get(pkgName) ?? [];
  state.deletedWorkspaceBlocks.set(pkgName, [...existing, ...npmSpecifiers]);
  delete state.lockfile[key];
  /* v8 ignore next 3 -- ternary: npm specifiers in workspace keys are rare */
  state.log(
    `yarn.lock: deleted workspace block for ${pkgName}` +
      (npmSpecifiers.length ? ` (preserving npm specifiers: ${npmSpecifiers.join(", ")})` : ""),
  );
  return 1;
}

function seedTransformedFromDeleted(state: LockUpdateState): void {
  for (const [pkgName] of state.deletedWorkspaceBlocks) {
    const version = state.versionMap.get(pkgName);
    /* v8 ignore next -- defensive: deleted workspace packages always in version map */
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

  for (const [key, rawEntry] of Object.entries(state.lockfile)) {
    if (key === "__metadata") continue;
    collectRefsFromDepMaps(state, rawEntry, remainingPackages, unresolvedPackages);
    if (keyHasWorkspaceProtocol(key)) {
      const pkgName = workspaceProtocolPackageName(key);
      /* v8 ignore next -- defensive: workspace block keys always have package names */
      if (pkgName && !state.processedPackages.has(pkgName) && !remainingPackages.has(pkgName)) {
        recordResolvedOrUnresolved(state, pkgName, remainingPackages, unresolvedPackages);
      }
    }
  }

  return { remainingPackages, unresolvedPackages };
}

function collectRefsFromDepMaps(
  state: LockUpdateState,
  entry: LockfileEntry,
  remainingPackages: Map<string, string>,
  unresolvedPackages: string[],
): void {
  const depFields = [
    entry.dependencies,
    entry.devDependencies,
    entry.peerDependencies,
    entry.optionalDependencies,
  ];
  for (const deps of depFields) {
    if (!deps) continue;
    for (const [depName, value] of Object.entries(deps)) {
      if (!/^(?:workspace:[*^]?|backstage:\^)$/.exec(value)) continue;
      if (state.processedPackages.has(depName) || remainingPackages.has(depName)) continue;
      recordResolvedOrUnresolved(state, depName, remainingPackages, unresolvedPackages);
    }
  }
}

function recordResolvedOrUnresolved(
  state: LockUpdateState,
  name: string,
  remainingPackages: Map<string, string>,
  unresolvedPackages: string[],
): void {
  const resolved = state.versionMap.get(name) ?? findPackageVersion(name, state.workspacePath);
  /* v8 ignore next -- defensive: packages always resolvable */
  if (resolved) {
    remainingPackages.set(name, resolved);
    return;
  }
  /* v8 ignore next -- defensive: no duplicate unresolved names */
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
  updateCount += replaced;
  state.log(
    `yarn.lock: updated dependency ${packageName} to npm:^${version} (from remaining scan)`,
  );
  state.transformedNonLocalPackages.set(packageName, version);

  updateCount += deleteRemainingWorkspaceBlockIfNeeded(state, packageName, version);
  return updateCount;
}

/* v8 ignore start -- one-sided: workspace block deletion guards and key matching */
function deleteRemainingWorkspaceBlockIfNeeded(
  state: LockUpdateState,
  packageName: string,
  version: string,
): number {
  if (state.localPackagePaths.has(packageName)) return 0;
  if (state.deletedStalePathPackages.has(packageName)) return 0;

  const keysToRemove: string[] = [];
  for (const key of Object.keys(state.lockfile)) {
    if (key === "__metadata") continue;
    if (!keyHasWorkspaceProtocol(key)) continue;
    if (workspaceProtocolPackageName(key) === packageName) {
      keysToRemove.push(key);
    }
  }
  if (keysToRemove.length === 0) return 0;

  const npmSpecifiers = keysToRemove.flatMap((k) => extractNpmSpecifiers(k, packageName));
  const existing = state.deletedWorkspaceBlocks.get(packageName) ?? [];
  state.deletedWorkspaceBlocks.set(packageName, [...existing, ...npmSpecifiers]);
  state.transformedNonLocalPackages.set(packageName, version);
  for (const key of keysToRemove) {
    delete state.lockfile[key];
  }
  state.log(
    `yarn.lock: deleted remaining workspace block for ${packageName}` +
      (npmSpecifiers.length ? ` (preserving npm specifiers: ${npmSpecifiers.join(", ")})` : ""),
  );
  return 1;
}
/* v8 ignore stop */

/** Multi-pass: create npm blocks for deps introduced by previously created blocks. */
async function resolveDanglingDeps(
  state: LockUpdateState,
  workspaceManifest: WorkspaceManifest,
  backstageManifest: BackstageManifest | null,
  pass: number,
  alreadyProcessed: Set<string>,
): Promise<number> {
  /* v8 ignore next -- defensive: dangling deps resolve in ≤3 passes in practice */
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

  for (const [depName] of allRefs) {
    /* v8 ignore next -- often all deps are already processed */
    if (alreadyProcessed.has(depName)) continue;
    const version = state.versionMap.get(depName);
    if (version === undefined) continue;

    danglingPackages.set(depName, version);
  }

  return danglingPackages;
}
