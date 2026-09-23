import fs from "node:fs";
import path from "node:path";
import type { BackstageManifest, WorkspaceManifest } from "../../manifest-types.ts";

export function loadWorkspaceManifest(workspacePath: string): WorkspaceManifest {
  const manifestPath = path.join(workspacePath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json not found — run generate-manifests first");
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function loadBackstageManifest(workspacePath: string): BackstageManifest | null {
  const manifestPath = path.join(workspacePath, "backstage-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

/** Build a version map from workspace and backstage manifests. */
export function buildVersionMap(
  workspaceManifest: WorkspaceManifest,
  backstageManifest: BackstageManifest | null,
): Map<string, string> {
  const versionMap = new Map<string, string>();

  for (const pkg of workspaceManifest.packages) {
    if (pkg.name && pkg.version) versionMap.set(pkg.name, pkg.version);
  }

  if (backstageManifest) {
    for (const pkg of backstageManifest.packages) {
      if (!versionMap.has(pkg.name) && pkg.version) {
        versionMap.set(pkg.name, pkg.version);
      }
    }
  }

  return versionMap;
}
