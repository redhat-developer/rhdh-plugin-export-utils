import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";

/** Pattern that marks a postinstall as monorepo-root install (fails in isolated workspace). */
const MONOREPO_POSTINSTALL = "cd ../../ && yarn install";

const YARN_VERSION_RE = /^yarn@(\d+\.\d+\.\d+)$/;

export interface HermeticPrepDeps {
  /**
   * Download a Yarn classic/berry CLI binary. Defaults to fetching from
   * repo.yarnpkg.com (same URL as sync-midstream.sh). Injected in tests.
   */
  downloadYarn?: (version: string, destPath: string) => Promise<void>;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
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

function hasMonorepoPostinstall(
  pkgPath: string,
  scripts: Record<string, unknown> | undefined,
): boolean {
  const val = scripts?.postinstall;
  if (typeof val !== "string") {
    return false;
  }
  if (val.includes(MONOREPO_POSTINSTALL)) {
    return true;
  }
  if (!val.startsWith("./")) {
    return false;
  }
  const scriptPath = path.join(path.dirname(pkgPath), val);
  return (
    fs.existsSync(scriptPath) && fs.readFileSync(scriptPath, "utf8").includes(MONOREPO_POSTINSTALL)
  );
}

function walkPackageJson(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkPackageJson(full));
    } else if (entry.name === "package.json") {
      found.push(full);
    }
  }
  return found;
}

/** Line-oriented yarnPath reader — avoid `.+` / `\s*` backtracking (Sonar S8786). */
const YARN_PATH_LINE_RE = /^yarnPath:[ \t]*([^\n\r]+)$/m;
const YARN_PATH_KEY_RE = /^yarnPath:/m;

function readYarnPath(yarnrcContent: string): string | undefined {
  const match = YARN_PATH_LINE_RE.exec(yarnrcContent);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function setYarnPath(yarnrcContent: string, yarnPath: string): string {
  if (YARN_PATH_KEY_RE.test(yarnrcContent)) {
    return yarnrcContent.replace(YARN_PATH_LINE_RE, `yarnPath: ${yarnPath}`);
  }
  const trimmed = yarnrcContent.replace(/[ \t\n\r]*$/, "");
  return `${trimmed}${trimmed.length > 0 ? "\n" : ""}yarnPath: ${yarnPath}\n`;
}

async function defaultDownloadYarn(version: string, destPath: string): Promise<void> {
  const url = `https://repo.yarnpkg.com/${version}/packages/yarnpkg-cli/bin/yarn.js`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Yarn ${version} from ${url}: HTTP ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, body);
}

/**
 * Ensure `.yarnrc.yml` `yarnPath` points at an on-disk binary.
 *
 * Matches sync-midstream.sh Loop 2: if yarnPath is missing or the binary is
 * absent, derive the version from `packageManager` (`yarn@X.Y.Z`), download
 * the binary, and set yarnPath — before `packageManager` is stripped.
 */
export async function ensureYarnBinary(
  ctx: ModuleContext,
  deps: HermeticPrepDeps = {},
): Promise<void> {
  const downloadYarn = deps.downloadYarn ?? defaultDownloadYarn;
  const yarnrcPath = path.join(ctx.workspacePath, ".yarnrc.yml");
  const yarnrcContent = fs.existsSync(yarnrcPath) ? fs.readFileSync(yarnrcPath, "utf8") : "";
  const yarnPathValue = readYarnPath(yarnrcContent);

  if (yarnPathValue !== undefined) {
    const resolved = path.resolve(ctx.workspacePath, yarnPathValue);
    if (fs.existsSync(resolved)) {
      ctx.log(`Yarn binary: ${yarnPathValue}`);
      return;
    }
  }

  const rootPkgPath = path.join(ctx.workspacePath, "package.json");
  let pkgManager = "";
  if (fs.existsSync(rootPkgPath)) {
    const pkg = readJsonObject(rootPkgPath);
    if (typeof pkg.packageManager === "string") {
      pkgManager = pkg.packageManager;
    }
  }
  const versionMatch = YARN_VERSION_RE.exec(pkgManager);
  if (versionMatch?.[1] === undefined) {
    throw new Error(
      "No usable yarnPath in .yarnrc.yml and no packageManager (yarn@X.Y.Z) in package.json",
    );
  }

  const yarnVersion = versionMatch[1];
  const yarnBinary = `.yarn/releases/yarn-${yarnVersion}.cjs`;
  const destPath = path.join(ctx.workspacePath, yarnBinary);
  ctx.log(`downloading yarn ${yarnVersion} from repo.yarnpkg.com`);
  await downloadYarn(yarnVersion, destPath);

  const nextYarnrc = setYarnPath(yarnrcContent.length > 0 ? yarnrcContent : "", yarnBinary);
  fs.writeFileSync(yarnrcPath, nextYarnrc.endsWith("\n") ? nextYarnrc : `${nextYarnrc}\n`);
  ctx.log(`set yarnPath to ${yarnBinary} (from packageManager: ${pkgManager})`);
}

/**
 * Prepare the workspace for hermetic Konflux builds:
 * - Ensure Yarn is available via yarnPath (download from packageManager if needed).
 * - Remove `packageManager` from the workspace root `package.json` (corepack would download).
 * - Remove monorepo-pattern `postinstall` scripts that reference the parent monorepo root.
 */
export async function run(ctx: ModuleContext): Promise<void> {
  return runWithDeps(ctx, {});
}

/** Testable entry point with injectable Yarn download. */
export async function runWithDeps(ctx: ModuleContext, deps: HermeticPrepDeps): Promise<void> {
  await ensureYarnBinary(ctx, deps);

  const rootPkgPath = path.join(ctx.workspacePath, "package.json");
  if (fs.existsSync(rootPkgPath)) {
    const pkg = readJsonObject(rootPkgPath);
    if (pkg.packageManager !== undefined) {
      delete pkg.packageManager;
      writeJson(rootPkgPath, pkg);
      ctx.log("removed packageManager from package.json");
    }
  }

  for (const pkgPath of walkPackageJson(ctx.workspacePath)) {
    const pkg = readJsonObject(pkgPath);
    const scripts = isRecord(pkg.scripts) ? pkg.scripts : undefined;
    if (!scripts || !hasMonorepoPostinstall(pkgPath, scripts)) {
      continue;
    }
    delete scripts.postinstall;
    writeJson(pkgPath, pkg);
    ctx.log(`removed monorepo postinstall from ${path.relative(ctx.workspacePath, pkgPath)}`);
  }
}
