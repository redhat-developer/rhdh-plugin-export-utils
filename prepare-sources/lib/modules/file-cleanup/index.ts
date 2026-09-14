import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";

/** Directory basenames removed wholesale (sync-midstream.sh find -type d). */
export const REMOVABLE_DIR_NAMES = new Set(["dev", "e2e-tests", "__tests__", "__mocks__"]);

const TEST_FILE_PATTERNS = [/\.test\.ts$/, /\.test\.tsx$/, /\.spec\.ts$/, /\.spec\.tsx$/];

/** True when a relative workspace path is under node_modules or dist-dynamic. */
export function isExcludedPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized.includes("/node_modules/") || normalized.includes("/dist-dynamic/");
}

export function shouldRemoveDir(dirName: string): boolean {
  return REMOVABLE_DIR_NAMES.has(dirName);
}

export function shouldRemoveFile(fileName: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function walkEntries(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    results.push(fullPath);
    if (entry.isDirectory()) {
      results.push(...walkEntries(fullPath));
    }
  }
  return results;
}

export function findRemovablePaths(workspacePath: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entryPath of walkEntries(workspacePath)) {
    const rel = path.relative(workspacePath, entryPath);
    if (isExcludedPath(rel)) continue;

    const stat = fs.statSync(entryPath);
    const baseName = path.basename(entryPath);

    if (stat.isDirectory() && shouldRemoveDir(baseName)) {
      dirs.push(entryPath);
    } else if (stat.isFile() && shouldRemoveFile(baseName)) {
      files.push(entryPath);
    }
  }

  dirs.sort((a, b) => b.length - a.length);
  return { dirs, files };
}

/**
 * Removes test, mock, and dev-only files from surviving workspace packages.
 * Matches sync-midstream.sh lines 917–924.
 */
export function run(ctx: ModuleContext): Promise<void> {
  const { dirs, files } = findRemovablePaths(ctx.workspacePath);

  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.log(`removed ${path.relative(ctx.workspacePath, dir)}/`);
  }

  for (const file of files) {
    // Files under removed dirs were already deleted with their parent.
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    ctx.log(`removed ${path.relative(ctx.workspacePath, file)}`);
  }

  return Promise.resolve();
}
