import type { ModuleContext, PipelineModule } from "./pipeline.ts";

async function notImplemented(ctx: ModuleContext): Promise<void> {
  ctx.log("not yet implemented");
}

/** Order is the contract. Replace `notImplemented` with a real module import when implementing. */
export const MODULES: readonly PipelineModule[] = [
  { name: "seed-frontend-lockfiles", run: notImplemented },
  { name: "make-self-contained", run: notImplemented },
  { name: "generate-manifests", run: notImplemented },
  { name: "plugin-removal", run: notImplemented },
  { name: "file-cleanup", run: notImplemented },
  { name: "protocol-resolution", run: notImplemented },
  { name: "package-cleanup", run: notImplemented },
  { name: "hermetic-prep", run: notImplemented },
  { name: "inject-build-tools", run: notImplemented },
  { name: "build", run: notImplemented },
  { name: "re-export", run: notImplemented },
  { name: "validate", run: notImplemented },
  { name: "construct-artifact", run: notImplemented },
];
