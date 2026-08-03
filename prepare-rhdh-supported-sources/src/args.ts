import { parseArgs as parse } from "node:util";

export type CliArgs =
  | { listModules: true }
  | {
      listModules: false;
      workspacePath: string;
      overlayPath: string;
      startFrom?: string;
      stopAfter?: string;
    };

const USAGE = `Usage:
  prepare-rhdh-supported-sources --list-modules
  prepare-rhdh-supported-sources --workspace-path <path> --overlay-path <path> [--start-from=<module>] [--stop-after=<module>]`;

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
    throw new Error(USAGE);
  }

  // --list-modules short-circuits; other flags are ignored.
  if (values["list-modules"]) {
    return { listModules: true };
  }

  const workspacePath = values["workspace-path"];
  const overlayPath = values["overlay-path"];
  if (!workspacePath || !overlayPath) {
    throw new Error(`Missing required --workspace-path and --overlay-path\n\n${USAGE}`);
  }

  return {
    listModules: false,
    workspacePath,
    overlayPath,
    startFrom: values["start-from"],
    stopAfter: values["stop-after"],
  };
}
