import fs from "node:fs";
import path from "node:path";
import type { WorkspaceManifest } from "../../manifest-types.ts";
import {
  EXTRA_RUNTIME_TYPES,
  HOST_DEPS,
  INTERNAL_PROTOCOLS,
  TYPE_SHIMS_DIR,
  TYPE_SHIMS_NAME,
} from "./constants.ts";
import { parseSyml, stringifySyml } from "@yarnpkg/parsers";
import type { ParsedLockfile } from "../../yarn-lock-helpers.ts";
import { buildWorkspaceSoftEntry } from "./yarn-lock-metadata.ts";
import { writeJson } from "./utils.ts";

/** @internal — exported for unit testing */
export function typesPackageToRuntime(name: string): string | null {
  if (!name.startsWith("@types/")) return null;
  const raw = name.slice("@types/".length);
  if (raw.includes("__")) {
    const [scope, ...rest] = raw.split("__");
    return `@${scope}/${rest.join("__")}`;
  }
  return raw;
}

function collectTsconfigTypes(workspacePath: string): Set<string> {
  const types = new Set<string>();
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return types;
  try {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
    if (tsconfig.compilerOptions?.types) {
      for (const t of tsconfig.compilerOptions.types) types.add(t);
    }
  } catch /* v8 ignore next */ {
    // ignore parse errors
  }
  return types;
}

/**
 * Match a bare package name (scoped or unscoped) from an import specifier.
 * @internal — exported for unit testing
 */
export function extractPackageName(specifier: string): string | null {
  if (specifier.startsWith("@")) {
    const match = /^@[^'"/]+\/[^'"/]+/.exec(specifier);
    return match ? match[0] : null;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const match = /^[^'"/]+/.exec(specifier);
  return match ? match[0] : null;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-dynamic", ".git", "build", "coverage"]);

/* v8 ignore start -- filesystem walk: defensive checks for missing dirs and skip patterns */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string): void {
    if (!fs.existsSync(d)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
    }
  }
  walk(dir);
  return files;
}
/* v8 ignore stop */

const IMPORT_REGEXES = [
  /(?:from|import)\s+['"]([^'"]+)['"]/gm,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
];

function extractImportsFromFile(filePath: string, imports: Set<string>): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch /* v8 ignore next */ {
    return;
  }
  for (const regex of IMPORT_REGEXES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      /* v8 ignore next -- null fallback: regex capture group always present */
      const pkg = extractPackageName(match[1] ?? "");
      if (pkg) imports.add(pkg);
    }
  }
}

function collectImportsFromSurvivingFiles(dirs: string[]): Set<string> {
  const imports = new Set<string>();

  for (const dir of dirs) {
    const files = collectSourceFiles(dir);
    for (const file of files) {
      extractImportsFromFile(file, imports);
    }
  }
  return imports;
}

function survivingCodeUsesAssetTypes(dirs: string[]): boolean {
  const assetExtensions =
    /\.(module\.css|css|scss|sass|svg|png|jpe?g|gif|bmp|ico|woff2?|ttf|eot|yaml|md)$/;
  const importPathRe = /(?:from|import)\s+['"](\.[^'"]*)['"]/gm;

  for (const dir of dirs) {
    for (const file of collectSourceFiles(dir)) {
      try {
        const content = fs.readFileSync(file, "utf8");
        importPathRe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = importPathRe.exec(content)) !== null) {
          /* v8 ignore next -- defensive: regex capture group always present when match succeeds */
          if (assetExtensions.test(match[1] ?? "")) return true;
        }
      } catch /* v8 ignore next */ {
        continue;
      }
    }
  }
  return false;
}

function tsconfigHasAssetTypes(workspacePath: string): boolean {
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return false;
  try {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
    return (tsconfig.files ?? []).some((f: string) => f.includes("asset-types"));
  } catch /* v8 ignore next */ {
    return false;
  }
}

function addTypeShimsToRootPackageJson(
  workspacePath: string,
  log: (message: string) => void,
): void {
  const rootPkgPath = path.join(workspacePath, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

  /* v8 ignore next 3 -- defensive: root package.json always has workspaces */
  if (!rootPkg.workspaces) {
    rootPkg.workspaces = { packages: [] };
  }

  /* v8 ignore next 3 -- null fallback and array type check */
  const pkgsList = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces.packages ?? []);

  /* v8 ignore next -- always true on first call */
  if (!pkgsList.includes(TYPE_SHIMS_DIR)) {
    pkgsList.push(TYPE_SHIMS_DIR);
    if (Array.isArray(rootPkg.workspaces)) {
      rootPkg.workspaces = pkgsList;
    } else {
      rootPkg.workspaces.packages = pkgsList;
    }
    writeJson(rootPkgPath, rootPkg);
    log(`added ${TYPE_SHIMS_DIR} to root package.json workspaces`);
  }
}

function addTypeShimsToTsconfigReferences(
  workspacePath: string,
  log: (message: string) => void,
): void {
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  /* v8 ignore next -- defensive: tsconfig.json always present in type-shims fixtures */
  if (!fs.existsSync(tsconfigPath)) return;

  try {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
    /* v8 ignore next -- defensive: references always present in fixtures */
    if (!tsconfig.references) tsconfig.references = [];

    /* v8 ignore next -- idempotency guard: type-shims reference is always added fresh */
    if (!tsconfig.references.some((r: { path: string }) => r.path === TYPE_SHIMS_DIR)) {
      tsconfig.references.push({ path: TYPE_SHIMS_DIR });
      writeJson(tsconfigPath, tsconfig);
      log(`added ${TYPE_SHIMS_DIR} to root tsconfig.json references`);
    }
  } catch (error) /* v8 ignore next 2 -- defensive: tsconfig parse failure */ {
    log(`warning: could not update tsconfig.json references: ${String(error)}`);
  }
}

function preWireTypeShimsInYarnLock(
  workspacePath: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
  log: (message: string) => void,
): void {
  const yarnLockPath = path.join(workspacePath, "yarn.lock");
  /* v8 ignore next 4 -- defensive: yarn.lock always present in type-shims fixtures */
  if (!fs.existsSync(yarnLockPath)) {
    log("warning: yarn.lock not found, skipping type-shims pre-wiring");
    return;
  }

  const lockfile: ParsedLockfile = parseSyml(fs.readFileSync(yarnLockPath, "utf8"));
  const descriptorKey = `${TYPE_SHIMS_NAME}@workspace:${TYPE_SHIMS_DIR}`;

  /* v8 ignore next 4 -- defensive: pre-wire only runs once per fixture */
  if (descriptorKey in lockfile) {
    log("type-shims yarn.lock entry already exists, skipping pre-wire");
    return;
  }

  const { key, entry } = buildWorkspaceSoftEntry(TYPE_SHIMS_NAME, TYPE_SHIMS_DIR, deps, devDeps);
  lockfile[key] = entry;
  fs.writeFileSync(yarnLockPath, stringifySyml(lockfile));
  log(`pre-wired ${TYPE_SHIMS_NAME} entry in yarn.lock`);
}

type SurvivingPackageInfo = {
  dirs: string[];
  peerDeps: Set<string>;
  deps: Set<string>;
  alreadyProvided: Set<string>;
};

function addKeysToSet(target: Set<string>, ...maps: (Record<string, string> | undefined)[]): void {
  for (const map of maps) {
    if (map) Object.keys(map).forEach((n) => target.add(n));
  }
}

/* v8 ignore start -- one-sided branches: path/existence checks */
function collectSurvivingPackageInfo(
  workspacePath: string,
  manifest: WorkspaceManifest,
): SurvivingPackageInfo {
  const dirs: string[] = [];
  const peerDeps = new Set<string>();
  const deps = new Set<string>();
  const alreadyProvided = new Set<string>();

  for (const pkg of manifest.packages) {
    if (!pkg.path || pkg.path === "upstream") continue;
    const pkgDir = path.dirname(path.join(workspacePath, pkg.path));
    if (!fs.existsSync(pkgDir)) continue;
    dirs.push(pkgDir);
    addKeysToSet(peerDeps, pkg.peerDependencies);
    addKeysToSet(deps, pkg.dependencies);
    addKeysToSet(alreadyProvided, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies);
  }

  const rootPkg = JSON.parse(fs.readFileSync(path.join(workspacePath, "package.json"), "utf8"));
  addKeysToSet(alreadyProvided, rootPkg.dependencies, rootPkg.devDependencies);

  return { dirs, peerDeps, deps, alreadyProvided };
}
/* v8 ignore stop */

/** @internal — exported for unit testing */
export function isNeededDevDep(
  name: string,
  version: string,
  runtimeSets: ReadonlySet<string>[],
  alreadyProvided: Set<string>,
): boolean {
  if (INTERNAL_PROTOCOLS.some((p) => version.startsWith(p))) return false;
  if (alreadyProvided.has(name)) return false;
  if (runtimeSets.some((s) => s.has(name))) return true;

  if (name.startsWith("@types/")) {
    const runtimePkg = typesPackageToRuntime(name);
    if (runtimePkg && runtimeSets.some((s) => s.has(runtimePkg))) return true;
    if (runtimePkg && EXTRA_RUNTIME_TYPES.has(runtimePkg)) return true;
  }
  return false;
}

function aggregateDepsFromScrubbedPackages(
  workspacePath: string,
  manifest: WorkspaceManifest,
  runtimeSets: ReadonlySet<string>[],
  alreadyProvided: Set<string>,
): { deps: Record<string, string>; devDeps: Record<string, string> } {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};

  for (const pkg of manifest.packages) {
    if (!pkg.path || pkg.path === "upstream") continue;
    const pkgDir = path.dirname(path.join(workspacePath, pkg.path));
    if (fs.existsSync(pkgDir)) continue;
    collectHostDeps(pkg.path, pkg.dependencies, deps);
    collectNeededDevDeps(pkg, devDeps, runtimeSets, alreadyProvided);
  }

  return { deps, devDeps };
}

function collectHostDeps(
  pkgPath: string,
  pkgDependencies: Record<string, string> | undefined,
  deps: Record<string, string>,
): void {
  const pkgDir = path.dirname(pkgPath);
  const folderName = path.basename(pkgDir);
  if (!["app", "app-next"].includes(folderName) || !pkgDependencies) return;
  for (const dep of HOST_DEPS) {
    if (pkgDependencies[dep] && !deps[dep]) deps[dep] = pkgDependencies[dep];
  }
}

function collectNeededDevDeps(
  pkg: WorkspaceManifest["packages"][number],
  devDeps: Record<string, string>,
  runtimeSets: ReadonlySet<string>[],
  alreadyProvided: Set<string>,
): void {
  if (!pkg.devDependencies) return;
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    if (!devDeps[name] && isNeededDevDep(name, version, runtimeSets, alreadyProvided)) {
      devDeps[name] = version;
    }
  }
}

function buildShimContent(
  needsAssetTypes: boolean,
  needsThemeAugmentation: boolean,
  aggregatedDevDeps: Record<string, string>,
): string {
  let shim = "";
  if (needsAssetTypes) shim += "import '@backstage/cli/asset-types';\n";
  if (needsThemeAugmentation) shim += "import '@backstage/theme';\n";

  const extraTypeRefs = Object.keys(aggregatedDevDeps)
    .filter((n) => n.startsWith("@types/"))
    .map((n) => typesPackageToRuntime(n))
    .filter((rt): rt is string => rt !== null && EXTRA_RUNTIME_TYPES.has(rt));

  for (const rt of extraTypeRefs) {
    shim += `import '${rt}';\n`;
  }
  return shim;
}

function writeShimPackage(
  workspacePath: string,
  aggregatedDeps: Record<string, string>,
  aggregatedDevDeps: Record<string, string>,
  shim: string,
  log: (message: string) => void,
): void {
  const shimDir = path.join(workspacePath, TYPE_SHIMS_DIR);
  fs.mkdirSync(shimDir, { recursive: true });

  const pkgJson: Record<string, unknown> = {
    name: TYPE_SHIMS_NAME,
    version: "0.0.0-use.local",
    private: true,
  };
  /* v8 ignore start -- always true: type-shims package is only created when deps exist */
  if (Object.keys(aggregatedDeps).length > 0) pkgJson.dependencies = aggregatedDeps;
  if (Object.keys(aggregatedDevDeps).length > 0) pkgJson.devDependencies = aggregatedDevDeps;
  /* v8 ignore stop */
  writeJson(path.join(shimDir, "package.json"), pkgJson);

  if (shim) {
    const srcDir = path.join(shimDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "global-augments.d.ts"), shim);
    log(`created ${path.relative(workspacePath, srcDir)}/global-augments.d.ts`);
  }

  writeJson(path.join(shimDir, "tsconfig.json"), {
    extends: "../../tsconfig.json",
    compilerOptions: { composite: true },
    include: ["src"],
  });
}

/**
 * Create `packages/type-shims` aggregating host deps and @types/* from scrubbed packages.
 */
export function createTypeShimsPackage(
  workspacePath: string,
  manifest: WorkspaceManifest,
  log: (message: string) => void,
): void {
  const surviving = collectSurvivingPackageInfo(workspacePath, manifest);

  const tsconfigTypes = collectTsconfigTypes(workspacePath);
  log("scanning surviving source files for imports...");
  const survivingImports = collectImportsFromSurvivingFiles(surviving.dirs);
  log(`found ${survivingImports.size} unique import targets`);

  const rootDevDeps = new Set(
    Object.keys(
      JSON.parse(fs.readFileSync(path.join(workspacePath, "package.json"), "utf8"))
        .devDependencies ?? {},
    ),
  );
  const runtimeSets: ReadonlySet<string>[] = [
    survivingImports,
    surviving.peerDeps,
    surviving.deps,
    rootDevDeps,
    tsconfigTypes,
  ];

  const needsAssetTypes =
    !tsconfigHasAssetTypes(workspacePath) &&
    !survivingImports.has("@backstage/cli/asset-types") &&
    survivingCodeUsesAssetTypes(surviving.dirs);

  const needsThemeAugmentation =
    survivingImports.has("@mui/styles") &&
    !survivingImports.has("@backstage/core-components") &&
    !survivingImports.has("@backstage/theme");

  const { deps: aggregatedDeps, devDeps: aggregatedDevDeps } = aggregateDepsFromScrubbedPackages(
    workspacePath,
    manifest,
    runtimeSets,
    surviving.alreadyProvided,
  );

  if (
    Object.keys(aggregatedDeps).length === 0 &&
    Object.keys(aggregatedDevDeps).length === 0 &&
    !needsAssetTypes &&
    !needsThemeAugmentation
  ) {
    log("no type-shims package needed");
    return;
  }

  const shim = buildShimContent(needsAssetTypes, needsThemeAugmentation, aggregatedDevDeps);
  writeShimPackage(workspacePath, aggregatedDeps, aggregatedDevDeps, shim, log);

  log(
    `created ${TYPE_SHIMS_DIR} (${TYPE_SHIMS_NAME}): ` +
      `${Object.keys(aggregatedDeps).length} deps, ${Object.keys(aggregatedDevDeps).length} devDeps`,
  );

  addTypeShimsToRootPackageJson(workspacePath, log);
  addTypeShimsToTsconfigReferences(workspacePath, log);
  preWireTypeShimsInYarnLock(workspacePath, aggregatedDeps, aggregatedDevDeps, log);
}
