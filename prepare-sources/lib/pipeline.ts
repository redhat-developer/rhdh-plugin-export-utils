import fs from "node:fs";
import path from "node:path";
import { readSourceFile, type SourceJson } from "./source.ts";

/** Shared state loaded once: paths + parsed source.json. */
export interface PipelineInputs {
  workspacePath: string;
  overlayPath: string;
  source: SourceJson;
}

/** What each module receives: pipeline inputs + a name-prefixed logger. */
export interface ModuleContext extends PipelineInputs {
  log: (message: string) => void;
}

export interface PipelineModule {
  name: string;
  run: (ctx: ModuleContext) => Promise<void>;
}

export function loadPipelineInputs(workspacePath: string, overlayPath: string): PipelineInputs {
  const resolved = {
    workspacePath: path.resolve(workspacePath),
    overlayPath: path.resolve(overlayPath),
  };

  if (!fs.existsSync(resolved.workspacePath)) {
    throw new Error(`Workspace path does not exist: '${resolved.workspacePath}'`);
  }

  if (!fs.existsSync(resolved.overlayPath)) {
    throw new Error(`Overlay path does not exist: '${resolved.overlayPath}'`);
  }

  const source = readSourceFile(path.join(resolved.overlayPath, "source.json"));

  return { ...resolved, source };
}

export function selectModules(
  modules: readonly PipelineModule[],
  startFrom?: string,
  stopAfter?: string,
): PipelineModule[] {
  const indexOf = (name: string, flag: string): number => {
    const index = modules.findIndex((m) => m.name === name);
    if (index === -1) {
      throw new Error(
        `Unknown module "${name}" for ${flag}. Use --list-modules to see valid names.`,
      );
    }
    return index;
  };

  const start = startFrom !== undefined ? indexOf(startFrom, "--start-from") : 0;
  const stop = stopAfter !== undefined ? indexOf(stopAfter, "--stop-after") : modules.length - 1;

  if (start > stop) {
    throw new Error(
      `Invalid module range: --start-from=${startFrom} is after --stop-after=${stopAfter}`,
    );
  }

  return modules.slice(start, stop + 1);
}

function createModuleLog(name: string): (message: string) => void {
  return (message) => {
    console.info(`[${name}] ${message}`);
  };
}

export async function runPipeline(
  modules: readonly PipelineModule[],
  inputs: PipelineInputs,
  startFrom?: string,
  stopAfter?: string,
): Promise<void> {
  console.info("Pipeline starting");
  console.info(`  workspace: ${inputs.workspacePath}`);
  console.info(`  overlay:   ${inputs.overlayPath}`);
  console.info(`  repo:      ${inputs.source.repo} @ ${inputs.source["repo-ref"]}`);

  for (const mod of selectModules(modules, startFrom, stopAfter)) {
    const log = createModuleLog(mod.name);
    const ctx: ModuleContext = { ...inputs, log: (msg) => log(`  ${msg}`) };

    log("starting");
    try {
      await mod.run(ctx);
    } catch (cause) {
      throw new Error(`Module '${mod.name}' failed`, { cause });
    }
    log("done");
  }
}
