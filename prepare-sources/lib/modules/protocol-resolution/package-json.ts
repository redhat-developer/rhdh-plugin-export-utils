import fs from "node:fs";
import path from "node:path";
import { DEP_SECTIONS } from "./constants.ts";
import { findPackageVersion, writeJson } from "./utils.ts";

export type PackageJsonUpdateResult = {
  replacements: number;
  changed: boolean;
};

function isProtocolRef(version: string): boolean {
  return version.startsWith("workspace:") || version === "backstage:^";
}

/**
 * Replace workspace:^ and backstage:^ references in a single package.json.
 * Preserves workspace:^ for packages that still exist locally on disk.
 */
export function updatePackageJsonProtocols(
  packageJsonPath: string,
  workspacePath: string,
  versionMap: Map<string, string>,
  log: (message: string) => void,
): PackageJsonUpdateResult {
  const content = fs.readFileSync(packageJsonPath, "utf8");
  const updated = JSON.parse(content);
  let replacements = 0;

  for (const section of DEP_SECTIONS) {
    const deps = updated[section];
    if (!deps || typeof deps !== "object") continue;

    const toDelete: string[] = [];

    for (const [packageName, version] of Object.entries(deps)) {
      if (typeof version !== "string" || !isProtocolRef(version)) continue;

      if (version.startsWith("workspace:")) {
        if (findPackageVersion(packageName, workspacePath) !== null) continue;
      }

      const isBackstageDep = version === "backstage:^";
      let newVersion =
        versionMap.get(packageName) ??
        (isBackstageDep ? versionMap.get(packageName) : undefined) ??
        findPackageVersion(packageName, workspacePath);

      if (newVersion) {
        log(
          `${path.relative(workspacePath, packageJsonPath)} ${section}: ${packageName}: ${version} → ^${newVersion}`,
        );
        deps[packageName] = `^${newVersion}`;
        replacements++;
      } else if (findPackageVersion(packageName, workspacePath) === null) {
        log(
          `${path.relative(workspacePath, packageJsonPath)} ${section}: removing stale dependency ${packageName}`,
        );
        toDelete.push(packageName);
        replacements++;
      } else {
        log(`warning: no version found for ${packageName} in manifests`);
      }
    }

    for (const name of toDelete) {
      delete deps[name];
    }
  }

  if (replacements > 0) {
    writeJson(packageJsonPath, updated);
  }

  return { replacements, changed: replacements > 0 };
}
