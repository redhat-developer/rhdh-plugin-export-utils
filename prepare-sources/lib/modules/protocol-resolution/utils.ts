import fs from "node:fs";
import path from "node:path";
import { IGNORE_DIRS } from "./constants.ts";

export function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/** Discover all package.json files under the workspace (excluding build output dirs). */
export function findPackageJsonFiles(workspacePath: string): string[] {
  const results: string[] = [];

  function search(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) search(fullPath);
      } else if (entry.isFile() && entry.name === "package.json") {
        results.push(fullPath);
      }
    }
  }

  search(path.resolve(workspacePath));
  return results;
}

/**
 * Find a package version by scanning workspace package.json files.
 * Limits recursion depth to avoid runaway traversal.
 */
export function findPackageVersion(
  packageName: string,
  workspacePath: string,
  maxDepth = 5,
): string | null {
  const searchDirs = [workspacePath, path.join(workspacePath, "plugins")];

  function searchRecursive(dir: string, depth: number): string | null {
    if (depth > maxDepth || !fs.existsSync(dir)) return null;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        entry.name !== "dist-dynamic"
      ) {
        const found = searchRecursive(fullPath, depth + 1);
        if (found) return found;
      } else if (entry.isFile() && entry.name === "package.json") {
        try {
          const pkg = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          if (pkg.name === packageName && pkg.version) return pkg.version;
        } catch {
          // skip invalid JSON
        }
      }
    }
    return null;
  }

  for (const searchDir of searchDirs) {
    const version = searchRecursive(searchDir, 0);
    if (version) return version;
  }
  return null;
}

/** Extract package name from a yarn.lock block key specifier segment. */
export function extractPackageNameFromSpecifier(specifier: string): string | null {
  const match = specifier.match(/^(?:@[^@/]+\/)?[^@"]+/);
  return match ? match[0] : null;
}
