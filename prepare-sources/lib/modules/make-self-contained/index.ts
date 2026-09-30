import fs from "node:fs";
import path from "node:path";
import { Document, isMap, parseDocument, YAMLMap } from "yaml";
import type { ModuleContext } from "../../pipeline.ts";
import { skipExistingFile } from "../../fs-utils.ts";

/**
 * Makes a workspace directory self-contained so it can be built independently
 * of the parent monorepo.
 *
 * For non-flat repos, the Yarn configuration (`.yarn/` directory and
 * `.yarnrc.yml`) lives at the repo root. This module copies the root `.yarn/`
 * contents into the workspace's own `.yarn/` directory and merges `.yarnrc.yml`
 * keys (workspace values take precedence).
 *
 * For flat repos the workspace IS the repo root — nothing to do.
 */
export async function run(ctx: ModuleContext): Promise<void> {
  if (ctx.source["repo-flat"]) {
    ctx.log("flat repo, skipping");
    return;
  }

  const repoRoot = path.resolve(ctx.workspacePath, "../..");
  ctx.log(`repo root: ${repoRoot}`);

  mergeYarnDir(ctx, repoRoot);
  mergeYarnrcYml(ctx, repoRoot);
  validateYarnPath(ctx);
}

function mergeYarnDir(ctx: ModuleContext, repoRoot: string): void {
  const rootYarnDir = path.join(repoRoot, ".yarn");
  if (!fs.existsSync(rootYarnDir)) {
    ctx.log("no .yarn/ at repo root, skipping directory merge");
    return;
  }

  const wsYarnDir = path.join(ctx.workspacePath, ".yarn");
  ctx.log("merging .yarn/ from repo root");
  fs.cpSync(rootYarnDir, wsYarnDir, { recursive: true, filter: skipExistingFile });
}

function mergeYarnrcYml(ctx: ModuleContext, repoRoot: string): void {
  const rootFile = path.join(repoRoot, ".yarnrc.yml");
  const wsFile = path.join(ctx.workspacePath, ".yarnrc.yml");
  const rootExists = fs.existsSync(rootFile);
  const wsExists = fs.existsSync(wsFile);

  if (!rootExists) {
    ctx.log("no .yarnrc.yml at repo root, skipping config merge");
    return;
  }

  if (!wsExists) {
    ctx.log("copying .yarnrc.yml from repo root (workspace has none)");
    fs.copyFileSync(rootFile, wsFile);
    return;
  }

  ctx.log("merging .yarnrc.yml (workspace keys take precedence)");
  const rootContent = fs.readFileSync(rootFile, "utf8");
  const wsContent = fs.readFileSync(wsFile, "utf8");
  const merged = mergeYamlByTopLevelKey(wsContent, rootContent);
  fs.writeFileSync(wsFile, merged);
}

/**
 * Merge two YAML documents by top-level key.
 *
 * Keeps `primary` values for overlapping keys and appends any `secondary`-only
 * keys, so workspace (primary) keys win over root (secondary) keys.
 *
 * @param primary - Preferred YAML (e.g. workspace `.yarnrc.yml`).
 * @param secondary - YAML to fill in missing keys from (e.g. repo-root `.yarnrc.yml`).
 */
export function mergeYamlByTopLevelKey(primary: string, secondary: string): string {
  const primaryDoc = parseDocument(primary);
  const secondaryDoc = parseDocument(secondary);
  const primaryMap = isMap(primaryDoc.contents) ? primaryDoc.contents : new YAMLMap();

  if (isMap(secondaryDoc.contents)) {
    for (const pair of secondaryDoc.contents.items) {
      if (!primaryMap.has(pair.key)) {
        primaryMap.add(pair);
      }
    }
  }

  if (primaryMap.items.length === 0) {
    return "\n";
  }

  return new Document(primaryMap).toString({ lineWidth: 0 });
}

function validateYarnPath(ctx: ModuleContext): void {
  const yarnrcPath = path.join(ctx.workspacePath, ".yarnrc.yml");
  if (!fs.existsSync(yarnrcPath)) return;

  const yarnPath = parseDocument(fs.readFileSync(yarnrcPath, "utf8")).get("yarnPath");
  if (typeof yarnPath !== "string") return;

  const resolved = path.resolve(ctx.workspacePath, yarnPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `yarnPath "${yarnPath}" in .yarnrc.yml resolves to ${resolved} which does not exist. ` +
        `The workspace cannot run yarn independently.`,
    );
  }

  ctx.log(`yarnPath validated: ${yarnPath}`);
}
