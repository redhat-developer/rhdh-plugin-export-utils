import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ModuleContext } from "../../pipeline.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_CLI_PACKAGE = "@red-hat-developer-hub/cli";
const CACHE_DIR = ".yarn/cache";

export interface PackDependencies {
  /**
   * Download `packageName@version` into `destDir` as an npm pack tarball.
   * Defaults to `npm pack`. Injected in tests to avoid network access.
   */
  pack: (packageName: string, version: string, destDir: string) => Promise<void>;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function withSortedKeys(record: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted((a, b) => a.localeCompare(b))) {
    sorted[key] = record[key];
  }
  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(raw)) {
    throw new Error(`Expected a JSON object in '${filePath}'`);
  }
  return raw;
}

/** Walk from `startDir` upward until `versions.json` is found. */
export function findVersionsJson(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, "versions.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`versions.json not found walking up from '${startDir}'`);
    }
    dir = parent;
  }
}

export interface CliVersions {
  packageName: string;
  version: string;
}

/** Read CLI package name + version from an overlays `versions.json`. */
export function readCliVersions(versionsPath: string): CliVersions {
  const raw = readJsonObject(versionsPath);
  const version = raw.cli;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`Field "cli" must be a non-empty string in '${versionsPath}'`);
  }
  const packageName =
    typeof raw.cliPackage === "string" && raw.cliPackage.length > 0
      ? raw.cliPackage
      : DEFAULT_CLI_PACKAGE;
  return { packageName, version };
}

/**
 * npm pack names scoped packages by stripping `@` and replacing `/` with `-`.
 * e.g. `@red-hat-developer-hub/cli@2.0.0` → `red-hat-developer-hub-cli-2.0.0.tgz`
 */
export function tarballFileName(packageName: string, version: string): string {
  const unscoped = packageName.startsWith("@") ? packageName.slice(1) : packageName;
  return `${unscoped.replaceAll("/", "-")}-${version}.tgz`;
}

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/** Default pack implementation — `exec` is injectable for unit tests. */
export async function npmPack(
  packageName: string,
  version: string,
  destDir: string,
  exec: ExecFileAsync = execFileAsync,
): Promise<void> {
  try {
    // Run from destDir so a caller cwd (e.g. prepare-sources/) cannot impose
    // that package's devEngines on `npm pack` of the CLI tarball.
    await exec("npm", ["pack", `${packageName}@${version}`, `--pack-destination=${destDir}`], {
      encoding: "utf8",
      cwd: destDir,
    });
  } catch (cause) {
    throw new Error(`Failed to download ${packageName}@${version}`, { cause });
  }
}

const defaultDeps: PackDependencies = { pack: npmPack };

/**
 * Make `rhdh-cli` available offline in the workspace for hermetic Konflux builds:
 * cache the npm pack tarball under `.yarn/cache/` and add a `file:` devDependency.
 */
export async function run(ctx: ModuleContext): Promise<void> {
  return runWithDeps(ctx, defaultDeps);
}

/** Testable entry point with injectable pack dependency. */
export async function runWithDeps(ctx: ModuleContext, deps: PackDependencies): Promise<void> {
  const versionsPath = findVersionsJson(ctx.overlayPath);
  const { packageName, version } = readCliVersions(versionsPath);
  ctx.log(`using ${packageName}@${version} from ${versionsPath}`);

  const cacheDir = path.join(ctx.workspacePath, CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });

  const tarballName = tarballFileName(packageName, version);
  const tarballPath = path.join(cacheDir, tarballName);
  if (!fs.existsSync(tarballPath)) {
    ctx.log(`downloading ${packageName}@${version} into ${CACHE_DIR}/`);
    await deps.pack(packageName, version, cacheDir);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(
        `Expected tarball '${tarballName}' after pack into '${cacheDir}', but it was not found`,
      );
    }
  } else {
    ctx.log(`tarball already present: ${CACHE_DIR}/${tarballName}`);
  }

  const pkgPath = path.join(ctx.workspacePath, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`Workspace package.json not found at '${pkgPath}'`);
  }

  const pkg = readJsonObject(pkgPath);
  const fileRef = `file:${CACHE_DIR}/${tarballName}`;
  const devDependencies = isRecord(pkg.devDependencies) ? pkg.devDependencies : {};
  pkg.devDependencies = withSortedKeys({ ...devDependencies, [packageName]: fileRef });
  writeJson(pkgPath, pkg);
  ctx.log(`set devDependencies["${packageName}"] = "${fileRef}"`);
}
