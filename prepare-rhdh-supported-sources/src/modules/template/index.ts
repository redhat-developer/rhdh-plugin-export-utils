import fs from "node:fs";
import path from "node:path";
import type { ModuleContext } from "../../types.ts";

/**
 * Template module — copy this directory to `modules/<name>/` to start a new module.
 *
 * This implementation exercises all 6 fixture conventions so the template
 * test suite serves as a reference. Each branch is annotated with the
 * fixture pattern(s) it demonstrates.
 *
 * The module receives:
 * - `ctx.workspacePath` — absolute path to the source workspace
 * - `ctx.overlayPath`   — absolute path to the overlay workspace
 * - `ctx.source`        — parsed `source.json` metadata
 * - `ctx.log(message)`  — logger prefixed with the module name
 *
 * Throw an Error to abort the pipeline.
 */
export async function run(ctx: ModuleContext): Promise<void> {
  // Fixture patterns: error-string, error-regex
  const pluginsList = path.join(ctx.overlayPath, "plugins-list.yaml");
  if (!fs.existsSync(pluginsList)) {
    throw new Error("precondition failed: plugins-list.yaml missing from overlay");
  }

  // Fixture pattern: success-with-overlay-mutation, success-with-both-mutations
  const configPath = path.join(ctx.overlayPath, "config.yaml");
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(configPath, content.replace("processed: false", "processed: true"));
    ctx.log(`modified ${configPath}`);
  }

  // Fixture pattern: success-without-mutation (no package.json → early return)
  const pkgPath = path.join(ctx.workspacePath, "package.json");
  if (!fs.existsSync(pkgPath)) {
    ctx.log("no package.json at workspace root, skipping");
    return;
  }

  // Fixture patterns: success-with-workspace-mutation, success-with-both-mutations
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.addedByModule = true;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  ctx.log(`modified ${pkgPath}`);
}
