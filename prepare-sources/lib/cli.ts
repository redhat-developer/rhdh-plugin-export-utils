import { parseArgs as parse } from "node:util";
import { MODULES } from "./modules.ts";
import { loadPipelineInputs, runPipeline } from "./pipeline.ts";

interface HelpArgs {
  command: "help";
}

interface ListModulesArgs {
  command: "list-modules";
}

interface RunArgs {
  command: "run";
  workspacePath: string;
  overlayPath: string;
  startFrom?: string;
  stopAfter?: string;
}

export type CliArgs = HelpArgs | ListModulesArgs | RunArgs;

const USAGE = `Usage: prepare-sources --workspace-path=PATH --overlay-path=PATH [OPTION]...
  or:  prepare-sources --list-modules

Options:
      --workspace-path=PATH   path to the workspace directory
      --overlay-path=PATH     path to the overlay directory
      --start-from=MODULE     start pipeline from MODULE
      --stop-after=MODULE     stop pipeline after MODULE
      --list-modules          list available pipeline modules and exit
  -h, --help                  display this help and exit`;

export function parseArgs(argv: string[]): CliArgs {
  const { values } = parse({
    args: argv,
    options: {
      "list-modules": { type: "boolean", default: false },
      "workspace-path": { type: "string" },
      "overlay-path": { type: "string" },
      "start-from": { type: "string" },
      "stop-after": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    return { command: "help" };
  }

  if (values["list-modules"]) {
    return { command: "list-modules" };
  }

  const workspacePath = values["workspace-path"];
  const overlayPath = values["overlay-path"];

  if (!workspacePath || !overlayPath) {
    const missing = [
      ...(!workspacePath ? ["--workspace-path"] : []),
      ...(!overlayPath ? ["--overlay-path"] : []),
    ];
    const list = new Intl.ListFormat("en", { type: "conjunction" });
    throw new Error(`Missing required ${list.format(missing)}`);
  }

  return {
    command: "run",
    workspacePath,
    overlayPath,
    startFrom: values["start-from"],
    stopAfter: values["stop-after"],
  };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    console.log(USAGE);
  } else if (args.command === "list-modules") {
    for (const { name } of MODULES) {
      console.log(name);
    }
  } else if (args.command === "run") {
    const inputs = loadPipelineInputs(args.workspacePath, args.overlayPath);
    await runPipeline(MODULES, inputs, args.startFrom, args.stopAfter);
  }
}

if (import.meta.main) {
  await main();
}
