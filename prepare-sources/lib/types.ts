import type { SourceJson } from "./source.ts";

/** Shared state loaded once: paths + parsed source.json. */
export type PipelineInputs = {
  workspacePath: string;
  overlayPath: string;
  source: SourceJson;
};

/** What each module receives: pipeline inputs + a name-prefixed logger. */
export type ModuleContext = PipelineInputs & {
  log: (message: string) => void;
};
