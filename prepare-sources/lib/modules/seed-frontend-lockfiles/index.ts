import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";

type PluginType = "frontend" | "backend" | "none";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Determine a plugin's type from its `package.json` `backstage.role` field.
 *
 * Returns `"frontend"` for roles starting with `"frontend"` (covers
 * `frontend-plugin`, `frontend-plugin-module`), `"backend"` for roles
 * starting with `"backend"`, and `"none"` otherwise.
 */
export function getPluginType(packageJsonPath: string): PluginType {
  if (!fs.existsSync(packageJsonPath)) {
    return "none";
  }

  const raw: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (!isRecord(raw)) return "none";

  const backstage = raw.backstage;
  if (!isRecord(backstage)) return "none";

  const role = backstage.role;
  if (typeof role !== "string") return "none";

  if (role.startsWith("frontend")) return "frontend";
  if (role.startsWith("backend")) return "backend";
  return "none";
}

/** Find all `dist-dynamic/` directories under a workspace root. */
export function findDistDynamicDirs(workspacePath: string): string[] {
  const pattern = path.join(workspacePath, "**/dist-dynamic");
  return fs
    .globSync(pattern)
    .filter((p) => fs.statSync(p).isDirectory())
    .toSorted((a, b) => a.localeCompare(b));
}

/** Copy workspace lockfile and run yarn install to filter it for the plugin. */
function seedLockfile(
  distDynamic: string,
  workspaceLockfile: string,
  pluginRel: string,
  workspacePath: string,
  log: (msg: string) => void,
): void {
  if (!fs.existsSync(workspaceLockfile)) {
    throw new Error(
      `Cannot seed dist-dynamic/yarn.lock for ${pluginRel}: workspace yarn.lock not found at ${workspaceLockfile}`,
    );
  }

  log(`${pluginRel}: seeding dist-dynamic/yarn.lock`);
  const lockfileDest = path.join(distDynamic, "yarn.lock");
  fs.copyFileSync(workspaceLockfile, lockfileDest);

  try {
    // prettier-ignore
    execFileSync("yarn", ["install", "--no-immutable"], { cwd: distDynamic, stdio: "pipe" }); // NOSONAR — yarn must be resolved from PATH
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout) : "";
    throw new Error(
      `yarn install failed in ${path.relative(workspacePath, distDynamic)}:\n${stderr}\n${stdout}`.trimEnd(),
      { cause: err },
    );
  }

  log(`${pluginRel}: dist-dynamic/yarn.lock seeded`);
}

/**
 * Seeds `dist-dynamic/yarn.lock` for frontend plugins after the initial export.
 *
 * Backend plugins already have a resolved lockfile from `rhdh-cli plugin export`.
 * Frontend plugins don't — this module copies the workspace `yarn.lock` into each
 * frontend plugin's `dist-dynamic/` and runs `yarn install --no-immutable` to filter
 * it down to the plugin's dependencies.
 */
// prettier-ignore
export async function run(ctx: ModuleContext): Promise<void> { // NOSONAR — async for pipeline interface consistency
  const distDynamicDirs = findDistDynamicDirs(ctx.workspacePath);

  if (distDynamicDirs.length === 0) {
    ctx.log("no dist-dynamic directories found");
    return;
  }

  const workspaceLockfile = path.join(ctx.workspacePath, "yarn.lock");

  for (const distDynamic of distDynamicDirs) {
    const pluginDir = path.dirname(distDynamic);
    const pluginRel = path.relative(ctx.workspacePath, pluginDir);
    const packageJsonPath = path.join(pluginDir, "package.json");
    const pluginType = getPluginType(packageJsonPath);

    if (pluginType !== "frontend") {
      ctx.log(`${pluginRel}: ${pluginType} plugin, skipping`);
      continue;
    }

    if (fs.existsSync(path.join(distDynamic, "yarn.lock"))) {
      ctx.log(`${pluginRel}: dist-dynamic/yarn.lock already exists, skipping`);
      continue;
    }

    seedLockfile(distDynamic, workspaceLockfile, pluginRel, ctx.workspacePath, ctx.log);
  }
}
