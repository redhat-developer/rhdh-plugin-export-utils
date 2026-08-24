import { describe, expect, it } from "vite-plus/test";

import { parseArgs } from "./cli.ts";

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
