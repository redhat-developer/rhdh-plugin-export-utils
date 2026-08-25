import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { readSourceFile } from "./source.ts";
import type { ModuleContext } from "./types.ts";

/** Assertion helpers scoped to a single directory. */
export interface DirAssertions {
  readFile(relativePath: string): string;
  expectFile(relativePath: string, expected: string): void;
  expectNoFile(relativePath: string): void;
  listFiles(): string[];
  expectMatchesDir(expectedDir: string): void;
}

export interface ModuleFixture extends Disposable {
  ctx: ModuleContext;
  workspace: DirAssertions;
  overlay: DirAssertions;
  /**
   * Assert that workspace and overlay match the `output/workspace/` and
   * `output/overlay/` directories in the fixture (when present).
   */
  expectMatchesExpected(): void;
}

export interface TempDir extends Disposable {
  readonly path: string;
}

export function makeTempDir(): TempDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-sources-"));
  return {
    path: dir,
    [Symbol.dispose]() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function listFilesRecursive(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function readAllFiles(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of listFilesRecursive(dir)) {
    result[file] = fs.readFileSync(path.join(dir, file), "utf8");
  }
  return result;
}

function copyDirRecursive(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function dirAssertions(baseDir: string): DirAssertions {
  return {
    readFile(relativePath: string): string {
      return fs.readFileSync(path.join(baseDir, relativePath), "utf8");
    },
    expectFile(relativePath: string, expected: string): void {
      const fullPath = path.join(baseDir, relativePath);
      expect(fs.existsSync(fullPath), `expected ${relativePath} to exist`).toBe(true);
      expect(fs.readFileSync(fullPath, "utf8")).toBe(expected);
    },
    expectNoFile(relativePath: string): void {
      const fullPath = path.join(baseDir, relativePath);
      expect(fs.existsSync(fullPath), `expected ${relativePath} not to exist`).toBe(false);
    },
    listFiles(): string[] {
      return listFilesRecursive(baseDir);
    },
    expectMatchesDir(expectedDir: string): void {
      expect(readAllFiles(baseDir)).toEqual(readAllFiles(expectedDir));
    },
  };
}

/**
 * Load a test fixture from `__fixtures__/<name>/` relative to the test file.
 *
 * Convention — each subdirectory under `__fixtures__/` is a test case:
 *
 * ```
 * __fixtures__/<name>/
 * ├── input/
 * │   ├── workspace/        → copied into a temp workspace dir
 * │   └── overlay/          → copied into a temp overlay dir
 * │       └── source.json   → parsed into ctx.source
 * └── output/
 *     ├── workspace/        → asserted against workspace after run
 *     └── overlay/          → asserted against overlay after run
 * ```
 *
 * `source.json` lives in `input/overlay/` — same as in production.
 * `output/` is optional. For each side (workspace, overlay):
 * - If `output/<side>/` exists → assert it matches that directory.
 * - If `output/<side>/` is absent → assert no changes from `input/<side>/`.
 *
 * @param testDir      Pass `import.meta.dirname` from your test file.
 * @param name         Fixture subdirectory name under the fixtures dir.
 * @param fixturesDir  Subdirectory name containing fixtures (default: `__fixtures__`).
 */
export function loadFixture(
  testDir: string,
  name: string,
  fixturesDir = "__fixtures__",
): ModuleFixture {
  const fixtureDir = path.join(testDir, fixturesDir, name);
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`fixture not found: '${fixtureDir}'`);
  }

  const workspaceDir = makeTempDir();
  const overlayDir = makeTempDir();

  const inputWorkspace = path.join(fixtureDir, "input", "workspace");
  if (fs.existsSync(inputWorkspace)) copyDirRecursive(inputWorkspace, workspaceDir.path);

  const inputOverlay = path.join(fixtureDir, "input", "overlay");
  if (fs.existsSync(inputOverlay)) copyDirRecursive(inputOverlay, overlayDir.path);

  const sourcePath = path.join(overlayDir.path, "source.json");
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`fixture ${name} is missing input/overlay/source.json`);
  }
  const source = readSourceFile(sourcePath);

  const ctx: ModuleContext = {
    workspacePath: workspaceDir.path,
    overlayPath: overlayDir.path,
    source,
    log: vi.fn(),
  };

  const workspace = dirAssertions(workspaceDir.path);
  const overlay = dirAssertions(overlayDir.path);

  return {
    ctx,
    workspace,
    overlay,
    expectMatchesExpected(): void {
      const outputDir = path.join(fixtureDir, "output");
      const expectedWorkspace = path.join(outputDir, "workspace");
      if (fs.existsSync(expectedWorkspace)) {
        workspace.expectMatchesDir(expectedWorkspace);
      } else if (fs.existsSync(inputWorkspace)) {
        workspace.expectMatchesDir(inputWorkspace);
      }

      const expectedOverlay = path.join(outputDir, "overlay");
      if (fs.existsSync(expectedOverlay)) {
        overlay.expectMatchesDir(expectedOverlay);
      } else if (fs.existsSync(inputOverlay)) {
        overlay.expectMatchesDir(inputOverlay);
      }
    },
    [Symbol.dispose]() {
      workspaceDir[Symbol.dispose]();
      overlayDir[Symbol.dispose]();
    },
  };
}

/**
 * Auto-generate test cases from all `__fixtures__/<name>/` directories.
 *
 * Each fixture becomes a distinct `it()` test case named after the directory.
 * - If `output/` exists → runs the module and asserts output matches.
 * - If `output/` is absent → runs and asserts no changes to input.
 * - If an `error` file exists → asserts the module rejects with that message.
 *
 * Use this as the standard test body for a module. For cases needing extra
 * assertions (e.g. checking log calls), add explicit tests alongside using
 * `loadFixture` directly.
 *
 * @param testDir  Pass `import.meta.dirname` from your test file.
 * @param run      The module's `run` function.
 */
export function testInputOutputExpectations(
  testDir: string,
  run: (ctx: ModuleContext) => Promise<void>,
): void {
  const fixturesDir = path.join(testDir, "__fixtures__");
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(`__fixtures__/ not found at '${fixturesDir}'`);
  }

  const fixtures = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  describe("fixtures", () => {
    for (const name of fixtures) {
      it(name, async () => {
        using fixture = loadFixture(testDir, name);
        const errorFile = path.join(fixturesDir, name, "error");

        if (fs.existsSync(errorFile)) {
          const raw = fs.readFileSync(errorFile, "utf8").trim();
          const expected =
            raw.startsWith("/") && raw.endsWith("/") ? new RegExp(raw.slice(1, -1)) : raw;
          await expect(run(fixture.ctx)).rejects.toThrow(expected);
        } else {
          await run(fixture.ctx);
          fixture.expectMatchesExpected();
        }
      });
    }
  });
}
