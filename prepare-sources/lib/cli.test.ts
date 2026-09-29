import { describe, expect, it, vi } from "vite-plus/test";

import { main, parseArgs } from "./cli.ts";
import { MODULES } from "./modules.ts";
import * as pipeline from "./pipeline.ts";

describe("parseArgs", () => {
  it("parses --help", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
  });

  it("parses -h", () => {
    expect(parseArgs(["-h"])).toEqual({ command: "help" });
  });

  it("parses --list-modules", () => {
    expect(parseArgs(["--list-modules"])).toEqual({ command: "list-modules" });
  });

  it("parses required run paths", () => {
    expect(parseArgs(["--workspace-path", "/tmp/ws", "--overlay-path", "/tmp/overlay"])).toEqual({
      command: "run",
      workspacePath: "/tmp/ws",
      overlayPath: "/tmp/overlay",
      startFrom: undefined,
      stopAfter: undefined,
    });
  });

  it("parses optional slice bounds", () => {
    expect(
      parseArgs([
        "--workspace-path=/tmp/ws",
        "--overlay-path=/tmp/overlay",
        "--start-from=plugin-removal",
        "--stop-after=validate",
      ]),
    ).toEqual({
      command: "run",
      workspacePath: "/tmp/ws",
      overlayPath: "/tmp/overlay",
      startFrom: "plugin-removal",
      stopAfter: "validate",
    });
  });

  it("requires workspace and overlay paths for run mode", () => {
    expect(() => parseArgs([])).toThrow("Missing required --workspace-path and --overlay-path");
    expect(() => parseArgs(["--workspace-path", "/tmp/ws"])).toThrow(
      "Missing required --overlay-path",
    );
    expect(() => parseArgs(["--overlay-path", "/tmp/ov"])).toThrow(
      "Missing required --workspace-path",
    );
  });

  it("lets --list-modules short-circuit other flags", () => {
    expect(
      parseArgs([
        "--list-modules",
        "--workspace-path",
        "/tmp/ws",
        "--overlay-path",
        "/tmp/overlay",
      ]),
    ).toEqual({ command: "list-modules" });
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow();
  });
});

describe("main", () => {
  it("prints usage for help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--help"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage: prepare-sources"));
    log.mockRestore();
  });

  it("lists module names", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--list-modules"]);
    expect(log.mock.calls.map(([line]) => line)).toEqual(MODULES.map((m) => m.name));
    log.mockRestore();
  });

  it("loads inputs and runs the pipeline", async () => {
    const inputs = {
      workspacePath: "/ws",
      overlayPath: "/ov",
      source: {
        repo: "https://github.com/example/repo",
        "repo-ref": "main",
        "repo-flat": true,
        "repo-backstage-version": "1.0.0",
      },
    };
    const load = vi.spyOn(pipeline, "loadPipelineInputs").mockReturnValue(inputs);
    const run = vi.spyOn(pipeline, "runPipeline").mockResolvedValue(undefined);

    await main([
      "--workspace-path=/ws",
      "--overlay-path=/ov",
      "--start-from=make-self-contained",
      "--stop-after=hermetic-prep",
    ]);

    expect(load).toHaveBeenCalledWith("/ws", "/ov");
    expect(run).toHaveBeenCalledWith(MODULES, inputs, "make-self-contained", "hermetic-prep");

    load.mockRestore();
    run.mockRestore();
  });
});
