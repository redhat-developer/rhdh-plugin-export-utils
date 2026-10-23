import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";

/** Directory basenames removed wholesale (sync-midstream.sh find -type d). */
export const REMOVABLE_DIR_NAMES = new Set(["dev", "e2e-tests", "__tests__", "__mocks__"]);

const TEST_FILE_PATTERNS = [/\.test\.ts$/, /\.test\.tsx$/, /\.spec\.ts$/, /\.spec\.tsx$/];

/** Directory names whose subtrees are never cleaned (skipped during traversal). */
const SKIP_DIRS = new Set(["node_modules", "dist-dynamic"]);

export function shouldRemoveDir(dirName: string): boolean {
  return REMOVABLE_DIR_NAMES.has(dirName);
}

export function shouldRemoveFile(fileName: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function findRemovablePaths(workspacePath: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldRemoveDir(entry.name)) {
          dirs.push(fullPath);
        } else {
          walk(fullPath);
        }
      } else if (shouldRemoveFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(workspacePath);
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
    fs.rmSync(file, { force: true });
    ctx.log(`removed ${path.relative(ctx.workspacePath, file)}`);
  }

  return Promise.resolve();
}
