import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";

/** Pattern that marks a postinstall as monorepo-root install (fails in isolated workspace). */
const MONOREPO_POSTINSTALL = "cd ../../ && yarn install";

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

/**
 * Prepare the workspace for hermetic Konflux builds:
 * - Remove `packageManager` from the workspace root `package.json` (corepack would download).
 * - Remove monorepo-pattern `postinstall` scripts that reference the parent monorepo root.
 */
export async function run(ctx: ModuleContext): Promise<void> {
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
