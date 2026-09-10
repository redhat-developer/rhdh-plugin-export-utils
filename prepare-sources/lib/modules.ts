import type { ModuleContext, PipelineModule } from "./pipeline.ts";
import { run as hermeticPrep } from "./modules/hermetic-prep/index.ts";
import { run as makeSelfContained } from "./modules/make-self-contained/index.ts";
import { run as generateManifests } from "./modules/generate-manifests/index.ts";
import { run as pluginRemoval } from "./modules/plugin-removal/index.ts";

async function notImplemented(ctx: ModuleContext): Promise<void> {
  ctx.log("not yet implemented");
}

/** Order is the contract. Replace `notImplemented` with a real module import when implementing. */
export const MODULES: readonly PipelineModule[] = [
  { name: "seed-frontend-lockfiles", run: notImplemented },
  { name: "make-self-contained", run: makeSelfContained },
  { name: "generate-manifests", run: generateManifests },
  { name: "plugin-removal", run: pluginRemoval },
  { name: "file-cleanup", run: notImplemented },
  { name: "protocol-resolution", run: notImplemented },
  { name: "package-cleanup", run: notImplemented },
  { name: "hermetic-prep", run: hermeticPrep },
  { name: "inject-build-tools", run: notImplemented },
  { name: "build", run: notImplemented },
  { name: "re-export", run: notImplemented },
  { name: "validate", run: notImplemented },
  { name: "construct-artifact", run: notImplemented },
];
