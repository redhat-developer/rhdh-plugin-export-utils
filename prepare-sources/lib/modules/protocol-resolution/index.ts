import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";
import { updatePackageJsonProtocols } from "./package-json.ts";
import { createTypeShimsPackage } from "./type-shims.ts";
import { findPackageJsonFiles } from "./utils.ts";
import { buildVersionMap, loadBackstageManifest, loadWorkspaceManifest } from "./version-map.ts";
import { updateYarnLock } from "./yarn-lock-update.ts";

/**
 * Resolves `workspace:^` and `backstage:^` protocol references to concrete npm
 * semver ranges in `package.json` and `yarn.lock`, and creates `packages/type-shims`
 * when surviving code needs types from scrubbed packages.
 *
 * Equivalent to `update-workspace.js --update` plus the type-shims portion of `--delete`.
 * Lockfile entry deletion for scrubbed packages is handled by `package-cleanup`.
 */
export async function run(ctx: ModuleContext): Promise<void> {
  const workspaceManifest = loadWorkspaceManifest(ctx.workspacePath);
  const backstageManifest = loadBackstageManifest(ctx.workspacePath);
  const versionMap = buildVersionMap(workspaceManifest, backstageManifest);

  ctx.log(`version map: ${versionMap.size} entries`);

  const yarnLockPath = path.join(ctx.workspacePath, "yarn.lock");
  if (!fs.existsSync(yarnLockPath)) {
    throw new Error("yarn.lock not found at workspace root");
  }

  const packageJsonFiles = findPackageJsonFiles(ctx.workspacePath);
  ctx.log(`processing ${packageJsonFiles.length} package.json file(s)`);

  let totalReplacements = 0;
  let yarnLockProcessed = false;

  for (const pkgPath of packageJsonFiles) {
    const result = updatePackageJsonProtocols(pkgPath, ctx.workspacePath, versionMap, ctx.log);
    totalReplacements += result.replacements;

    if (!yarnLockProcessed) {
      await updateYarnLock(
        yarnLockPath,
        versionMap,
        workspaceManifest,
        backstageManifest,
        ctx.workspacePath,
        ctx.log,
      );
      yarnLockProcessed = true;
    }
  }

  ctx.log(
    `package.json: ${totalReplacements} replacement(s); yarn.lock ${yarnLockProcessed ? "updated" : "skipped"}`,
  );

  ctx.log("creating type-shims package if needed...");
  createTypeShimsPackage(ctx.workspacePath, workspaceManifest, ctx.log);
}
