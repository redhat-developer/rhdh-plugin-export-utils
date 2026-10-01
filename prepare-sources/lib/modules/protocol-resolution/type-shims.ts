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
import { parseLockfile, serializeLockfile } from "../../yarn-lock-parser.ts";
import { buildWorkspaceSoftBlock } from "./yarn-lock-metadata.ts";
import { writeJson } from "./utils.ts";

function typesPackageToRuntime(name: string): string | null {
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
  } catch {
    // ignore parse errors
  }
  return types;
}

function collectImportsFromSurvivingFiles(dirs: string[]): Set<string> {
  const imports = new Set<string>();
  const importRegex = /(?<=(?:from|import)\s+['"])(@[^'"/]+\/[^'"/]+|[^'"./][^'"/]*)/gm;
  const requireRegex = /(?<=require\s*\(\s*['"])(@[^'"/]+\/[^'"/]+|[^'"./][^'"/]*)(?=['"]\s*\))/gm;

  for (const dir of dirs) {
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
        if (
          ["node_modules", "dist", "dist-dynamic", ".git", "build", "coverage"].includes(entry.name)
        ) {
          continue;
        }
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
      }
    }
    walk(dir);

    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const regex of [importRegex, requireRegex]) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          imports.add(match[0]);
        }
      }
    }
  }
  return imports;
}

function survivingCodeUsesAssetTypes(dirs: string[]): boolean {
  const assetRe =
    /(?:from|import)\s+['"]\..*\.(module\.css|css|scss|sass|svg|png|jpg|jpeg|gif|bmp|ico|woff|woff2|ttf|eot|yaml|md)['"]/;

  for (const dir of dirs) {
    function walk(d: string): boolean {
      if (!fs.existsSync(d)) return false;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (
          ["node_modules", "dist", "dist-dynamic", ".git", "build", "coverage"].includes(entry.name)
        ) {
          continue;
        }
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (walk(full)) return true;
        } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
          let content: string;
          try {
            content = fs.readFileSync(full, "utf8");
          } catch {
            continue;
          }
          if (assetRe.test(content)) return true;
        }
      }
      return false;
    }
    if (walk(dir)) return true;
  }
  return false;
}

function tsconfigHasAssetTypes(workspacePath: string): boolean {
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return false;
  try {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
    return (tsconfig.files ?? []).some((f: string) => f.includes("asset-types"));
  } catch {
    return false;
  }
}

function addTypeShimsToRootPackageJson(
  workspacePath: string,
  log: (message: string) => void,
): void {
  const rootPkgPath = path.join(workspacePath, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

  if (!rootPkg.workspaces) {
    rootPkg.workspaces = { packages: [] };
  }

  const pkgsList = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces.packages ?? []);

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
  if (!fs.existsSync(tsconfigPath)) return;

  try {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
    if (!tsconfig.references) tsconfig.references = [];

    if (!tsconfig.references.some((r: { path: string }) => r.path === TYPE_SHIMS_DIR)) {
      tsconfig.references.push({ path: TYPE_SHIMS_DIR });
      writeJson(tsconfigPath, tsconfig);
      log(`added ${TYPE_SHIMS_DIR} to root tsconfig.json references`);
    }
  } catch (error) {
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
  if (!fs.existsSync(yarnLockPath)) {
    log("warning: yarn.lock not found, skipping type-shims pre-wiring");
    return;
  }

  const lockfile = parseLockfile(fs.readFileSync(yarnLockPath, "utf8"));
  const descriptor = `${TYPE_SHIMS_NAME}@workspace:${TYPE_SHIMS_DIR}`;

  if (lockfile.blocks.some((b) => b.descriptors.includes(descriptor))) {
    log("type-shims yarn.lock entry already exists, skipping pre-wire");
    return;
  }

  lockfile.blocks.push(buildWorkspaceSoftBlock(TYPE_SHIMS_NAME, TYPE_SHIMS_DIR, deps, devDeps));
  fs.writeFileSync(yarnLockPath, serializeLockfile(lockfile));
  log(`pre-wired ${TYPE_SHIMS_NAME} entry in yarn.lock`);
}

/**
 * Create `packages/type-shims` aggregating host deps and @types/* from scrubbed packages.
 */
export function createTypeShimsPackage(
  workspacePath: string,
  manifest: WorkspaceManifest,
  log: (message: string) => void,
): void {
  const survivingPeerDeps = new Set<string>();
  const survivingDeps = new Set<string>();
  const survivingDirs: string[] = [];

  for (const pkg of manifest.packages) {
    if (!pkg.path || pkg.path === "upstream") continue;
    const pkgDir = path.dirname(path.join(workspacePath, pkg.path));
    if (!fs.existsSync(pkgDir)) continue;
    survivingDirs.push(pkgDir);
    if (pkg.peerDependencies) {
      Object.keys(pkg.peerDependencies).forEach((n) => survivingPeerDeps.add(n));
    }
    if (pkg.dependencies) {
      Object.keys(pkg.dependencies).forEach((n) => survivingDeps.add(n));
    }
  }

  const alreadyProvided = new Set<string>();
  for (const pkg of manifest.packages) {
    if (!pkg.path || pkg.path === "upstream") continue;
    const pkgDir = path.dirname(path.join(workspacePath, pkg.path));
    if (!fs.existsSync(pkgDir)) continue;
    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      if (pkg[section]) Object.keys(pkg[section]).forEach((n) => alreadyProvided.add(n));
    }
  }

  const rootPkgPath = path.join(workspacePath, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
  const rootDevDeps = new Set(Object.keys(rootPkg.devDependencies ?? {}));
  for (const section of ["dependencies", "devDependencies"] as const) {
    if (rootPkg[section]) Object.keys(rootPkg[section]).forEach((n) => alreadyProvided.add(n));
  }

  const tsconfigTypes = collectTsconfigTypes(workspacePath);
  log("scanning surviving source files for imports...");
  const survivingImports = collectImportsFromSurvivingFiles(survivingDirs);
  log(`found ${survivingImports.size} unique import targets`);

  const needsAssetTypes =
    !tsconfigHasAssetTypes(workspacePath) &&
    !survivingImports.has("@backstage/cli/asset-types") &&
    survivingCodeUsesAssetTypes(survivingDirs);

  const needsThemeAugmentation =
    survivingImports.has("@mui/styles") &&
    !survivingImports.has("@backstage/core-components") &&
    !survivingImports.has("@backstage/theme");

  function isNeededDevDep(name: string, version: string): boolean {
    if (INTERNAL_PROTOCOLS.some((p) => version.startsWith(p))) return false;
    if (alreadyProvided.has(name)) return false;
    if (survivingImports.has(name)) return true;

    if (name.startsWith("@types/")) {
      const runtimePkg = typesPackageToRuntime(name);
      if (runtimePkg) {
        if (survivingImports.has(runtimePkg)) return true;
        if (survivingPeerDeps.has(runtimePkg)) return true;
        if (survivingDeps.has(runtimePkg)) return true;
        if (rootDevDeps.has(runtimePkg)) return true;
        if (tsconfigTypes.has(runtimePkg)) return true;
        if (EXTRA_RUNTIME_TYPES.has(runtimePkg)) return true;
      }
    }
    return false;
  }

  const aggregatedDeps: Record<string, string> = {};
  const aggregatedDevDeps: Record<string, string> = {};

  for (const pkg of manifest.packages) {
    if (!pkg.path || pkg.path === "upstream") continue;
    const pkgDir = path.dirname(path.join(workspacePath, pkg.path));
    if (fs.existsSync(pkgDir)) continue;

    const folderName = path.basename(pkgDir);

    if (["app", "app-next"].includes(folderName) && pkg.dependencies) {
      for (const dep of HOST_DEPS) {
        if (pkg.dependencies[dep] && !aggregatedDeps[dep]) {
          aggregatedDeps[dep] = pkg.dependencies[dep];
        }
      }
    }

    if (pkg.devDependencies) {
      for (const [name, version] of Object.entries(pkg.devDependencies)) {
        if (!aggregatedDevDeps[name] && isNeededDevDep(name, version)) {
          aggregatedDevDeps[name] = version;
        }
      }
    }
  }

  if (
    Object.keys(aggregatedDeps).length === 0 &&
    Object.keys(aggregatedDevDeps).length === 0 &&
    !needsAssetTypes &&
    !needsThemeAugmentation
  ) {
    log("no type-shims package needed");
    return;
  }

  const shimDir = path.join(workspacePath, TYPE_SHIMS_DIR);
  fs.mkdirSync(shimDir, { recursive: true });

  const pkgJson: Record<string, unknown> = {
    name: TYPE_SHIMS_NAME,
    version: "0.0.0-use.local",
    private: true,
  };
  if (Object.keys(aggregatedDeps).length > 0) pkgJson.dependencies = aggregatedDeps;
  if (Object.keys(aggregatedDevDeps).length > 0) pkgJson.devDependencies = aggregatedDevDeps;
  writeJson(path.join(shimDir, "package.json"), pkgJson);

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

  log(
    `created ${TYPE_SHIMS_DIR} (${TYPE_SHIMS_NAME}): ` +
      `${Object.keys(aggregatedDeps).length} deps, ${Object.keys(aggregatedDevDeps).length} devDeps`,
  );

  addTypeShimsToRootPackageJson(workspacePath, log);
  addTypeShimsToTsconfigReferences(workspacePath, log);
  preWireTypeShimsInYarnLock(workspacePath, aggregatedDeps, aggregatedDevDeps, log);
}
