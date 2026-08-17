import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";

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

// ---------------------------------------------------------------------------
// .yarn/ directory merge
// ---------------------------------------------------------------------------

function mergeYarnDir(ctx: ModuleContext, repoRoot: string): void {
  const rootYarnDir = path.join(repoRoot, ".yarn");
  if (!fs.existsSync(rootYarnDir)) {
    ctx.log("no .yarn/ at repo root, skipping directory merge");
    return;
  }

  const wsYarnDir = path.join(ctx.workspacePath, ".yarn");
  ctx.log("merging .yarn/ from repo root");
  copyDirRecursive(rootYarnDir, wsYarnDir, /* skipExisting */ true);
}

/**
 * Recursively copy `src` into `dest`.
 * When `skipExisting` is true, files already present at `dest` are not
 * overwritten (workspace takes precedence over root).
 */
function copyDirRecursive(src: string, dest: string, skipExisting: boolean): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, skipExisting);
    } else {
      if (skipExisting && fs.existsSync(destPath)) continue;
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// .yarnrc.yml merge
// ---------------------------------------------------------------------------

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
 * Merge two YAML files by top-level key, without a YAML library.
 *
 * Each file is split into "blocks" keyed by unindented `key:` lines.
 * Everything from that line until the next unindented key (or EOF) belongs
 * to the block. The merge keeps `primary` blocks and appends any
 * `secondary`-only blocks.
 *
 * This matches the bash:
 *   cat workspace.yarnrc.yml root.yarnrc.yml | yq 'to_entries | unique_by(.key) | from_entries'
 * where workspace (primary) keys win over root (secondary) keys.
 */
export function mergeYamlByTopLevelKey(primary: string, secondary: string): string {
  const primaryBlocks = parseTopLevelBlocks(primary);
  const secondaryBlocks = parseTopLevelBlocks(secondary);

  const merged = new Map(primaryBlocks);
  for (const [key, value] of secondaryBlocks) {
    if (!merged.has(key)) {
      merged.set(key, value);
    }
  }

  return [...merged.values()].join("\n") + "\n";
}

/**
 * Parse a YAML string into an ordered map of top-level key → block text.
 *
 * A "top-level key" is an unindented line matching `key:` (with optional value).
 * Lines that are blank, comments, or indented belong to the preceding block.
 */
function parseTopLevelBlocks(content: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let currentKey = "";
  let currentLines: string[] = [];

  for (const line of content.split("\n")) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/);
    if (match?.[1] !== undefined) {
      if (currentKey) {
        blocks.set(currentKey, trimTrailingBlanks(currentLines).join("\n"));
      }
      currentKey = match[1];
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentKey) {
    blocks.set(currentKey, trimTrailingBlanks(currentLines).join("\n"));
  }

  return blocks;
}

function trimTrailingBlanks(lines: string[]): string[] {
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last === undefined || last.trim() !== "") break;
    lines.pop();
  }
  return lines;
}

// ---------------------------------------------------------------------------
// yarnPath validation
// ---------------------------------------------------------------------------

function validateYarnPath(ctx: ModuleContext): void {
  const yarnrcPath = path.join(ctx.workspacePath, ".yarnrc.yml");
  if (!fs.existsSync(yarnrcPath)) return;

  const content = fs.readFileSync(yarnrcPath, "utf8");
  const match = content.match(/^yarnPath\s*:\s*(.+)$/m);
  if (match?.[1] === undefined) return;

  const yarnPath = match[1].trim().replace(/^["']|["']$/g, "");
  const resolved = path.resolve(ctx.workspacePath, yarnPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `yarnPath "${yarnPath}" in .yarnrc.yml resolves to ${resolved} which does not exist. ` +
        `The workspace cannot run yarn independently.`,
    );
  }

  ctx.log(`yarnPath validated: ${yarnPath}`);
}
