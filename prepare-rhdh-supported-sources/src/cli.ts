import { parseArgs } from "./args.ts";
import { MODULES } from "./modules.ts";
import { loadPipelineInputs, runPipeline } from "./pipeline.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);

    if (args.listModules) {
      for (const { name } of MODULES) {
        console.log(name);
      }
      return 0;
    }

    const inputs = loadPipelineInputs(args.workspacePath, args.overlayPath);
    await runPipeline(MODULES, inputs, args.startFrom, args.stopAfter);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
