import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../pipeline.ts";

const SUPPORTED_PACKAGES_FILE = "rhdh-supported-packages.txt";
const PLUGINS_LIST_FILE = "plugins-list.yaml";

/** Normalize workspace path entries (strips a trailing `/.` used for flat repos). */
export function normalizeWorkspacePath(entry: string): string {
  return entry.replace(/\/\.$/, "");
}

/** Parse non-comment, non-empty lines from a tier list text file. */
export function parseTierListFile(content: string): string[] {
  const entries: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    entries.push(normalizeWorkspacePath(trimmed));
  }
  return entries;
}

export type PluginsListEntry = {
  /** Full line as written in plugins-list.yaml (path + optional CLI args). */
  rawLine: string;
  /** Plugin path relative to the workspace root (before `:`). */
  pluginPath: string;
};

/**
 * Parse `plugins-list.yaml` lines. Comment and blank lines are skipped.
 * Lines may end with `:` and optional export CLI arguments.
 */
export function parsePluginsListYaml(content: string): PluginsListEntry[] {
  const entries: PluginsListEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutListMarker = trimmed.replace(/^-\s*/, "");
    const pluginPath = withoutListMarker.split(":")[0]?.trim();
    if (!pluginPath || pluginPath.includes(" ")) continue;
    entries.push({ rawLine: line, pluginPath });
  }
  return entries;
}

/**
 * Keep plugins-list entries whose `workspace/pluginPath` appears in the supported tier list.
 */
export function filterPluginsListBySupported(
  entries: PluginsListEntry[],
  workspaceName: string,
  supportedPaths: ReadonlySet<string>,
): PluginsListEntry[] {
  return entries.filter((entry) => {
    const fullPath = normalizeWorkspacePath(`${workspaceName}/${entry.pluginPath}`);
    return supportedPaths.has(fullPath);
  });
}

function readPackageName(filePath: string): string | undefined {
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (typeof raw === "object" && raw !== null && "name" in raw && typeof raw.name === "string") {
    return raw.name;
  }
  return undefined;
}

/** Collect npm package names from dist-dynamic embedded package.json files under the workspace. */
export function collectEmbeddedPackageNames(workspacePath: string): Set<string> {
  const names = new Set<string>();
  const pattern = path.join(workspacePath, "**/dist-dynamic/embedded/*/package.json");
  for (const pkgPath of fs.globSync(pattern)) {
    try {
      const name = readPackageName(pkgPath);
      if (name) names.add(name);
    } catch {
      // skip malformed package.json — same tolerance as sync-midstream jq
    }
  }
  return names;
}

/** Discover `package.json` files at least two directory levels below the workspace root. */
export function findPackageJsonDirs(workspacePath: string): string[] {
  const results: string[] = [];
  for (const pkgPath of fs.globSync(path.join(workspacePath, "**/package.json"))) {
    const rel = path.relative(workspacePath, pkgPath);
    const segments = rel.split(path.sep);
    if (segments.length < 3) continue;
    results.push(path.dirname(pkgPath));
  }
  return results.toSorted((a, b) => a.localeCompare(b));
}

export function shouldKeepPackageDir(
  packageDir: string,
  workspacePath: string,
  keepPluginPaths: ReadonlySet<string>,
  embeddedNames: ReadonlySet<string>,
): boolean {
  const relDir = path.relative(workspacePath, packageDir);
  for (const keepPath of keepPluginPaths) {
    if (relDir === keepPath || relDir === `${keepPath}/dist-dynamic`) {
      return true;
    }
  }
  const pkgJson = path.join(packageDir, "package.json");
  if (!fs.existsSync(pkgJson)) return false;
  try {
    const name = readPackageName(pkgJson);
    return name !== undefined && embeddedNames.has(name);
  } catch {
    return false;
  }
}

/** Remove infrastructure directories not needed for supported plugin builds. */
export function removeInfrastructureDirs(workspacePath: string, log: (msg: string) => void): void {
  const examplesDir = path.join(workspacePath, "examples");
  if (fs.existsSync(examplesDir) && fs.statSync(examplesDir).isDirectory()) {
    fs.rmSync(examplesDir, { recursive: true, force: true });
    log("removed examples/");
  }

  const infraPatterns = [
    path.join(workspacePath, "**/packages/backend"),
    path.join(workspacePath, "**/packages/app"),
    path.join(workspacePath, "**/packages/app-next"),
    path.join(workspacePath, "**/.storybook"),
    path.join(workspacePath, "**/node_modules"),
  ];
  for (const pattern of infraPatterns) {
    for (const dir of fs.globSync(pattern)) {
      if (!fs.statSync(dir).isDirectory()) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      log(`removed ${path.relative(workspacePath, dir)}`);
    }
  }
}

/**
 * Rewrite `plugins-list.yaml` keeping comments and blank lines intact,
 * removing only uncommented plugin entries that didn't survive filtering.
 */
function writePluginsList(
  overlayPath: string,
  originalContent: string,
  surviving: PluginsListEntry[],
): void {
  const survivingRawLines = new Set(surviving.map((e) => e.rawLine));
  const outputLines: string[] = [];
  for (const line of originalContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      outputLines.push(line);
      continue;
    }
    if (survivingRawLines.has(line)) {
      outputLines.push(line);
    }
  }
  fs.writeFileSync(path.join(overlayPath, PLUGINS_LIST_FILE), outputLines.join("\n"));
}

/**
 * Removes non-supported plugin source from the workspace and rewrites
 * `plugins-list.yaml` to list only surviving supported plugins.
 */
export function run(ctx: ModuleContext): Promise<void> {
  const workspaceName = path.basename(ctx.overlayPath);
  const supportedFile = path.join(ctx.overlayRepoRoot, SUPPORTED_PACKAGES_FILE);
  const pluginsListPath = path.join(ctx.overlayPath, PLUGINS_LIST_FILE);

  if (!fs.existsSync(supportedFile)) {
    return Promise.reject(new Error(`${SUPPORTED_PACKAGES_FILE} not found at overlay repo root`));
  }
  if (!fs.existsSync(pluginsListPath)) {
    return Promise.reject(new Error(`${PLUGINS_LIST_FILE} not found in overlay path`));
  }

  const supportedPaths = new Set(parseTierListFile(fs.readFileSync(supportedFile, "utf8")));
  const pluginsListContent = fs.readFileSync(pluginsListPath, "utf8");
  const allListEntries = parsePluginsListYaml(pluginsListContent);
  const survivingList = filterPluginsListBySupported(allListEntries, workspaceName, supportedPaths);

  ctx.log(
    `plugins-list.yaml: ${survivingList.length}/${allListEntries.length} entries supported for workspace ${workspaceName}`,
  );

  const keepPluginPaths = new Set(
    survivingList.map((entry) => normalizeWorkspacePath(entry.pluginPath)),
  );
  const embeddedNames = collectEmbeddedPackageNames(ctx.workspacePath);
  if (embeddedNames.size > 0) {
    ctx.log(
      `embedded packages to preserve: ${[...embeddedNames].toSorted((a, b) => a.localeCompare(b)).join(", ")}`,
    );
  }

  removeInfrastructureDirs(ctx.workspacePath, ctx.log);

  for (const packageDir of findPackageJsonDirs(ctx.workspacePath)) {
    if (shouldKeepPackageDir(packageDir, ctx.workspacePath, keepPluginPaths, embeddedNames)) {
      continue;
    }
    const rel = path.relative(ctx.workspacePath, packageDir);
    fs.rmSync(packageDir, { recursive: true, force: true });
    ctx.log(`removed ${rel}`);
  }

  writePluginsList(ctx.overlayPath, pluginsListContent, survivingList);
  ctx.log(`written filtered ${PLUGINS_LIST_FILE}`);
  return Promise.resolve();
}
