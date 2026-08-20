import { describe, expect, it } from "vite-plus/test";

import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("parses --list-modules", () => {
    expect(parseArgs(["--list-modules"])).toEqual({ listModules: true });
  });

  it("parses required run paths", () => {
    expect(parseArgs(["--workspace-path", "/tmp/ws", "--overlay-path", "/tmp/overlay"])).toEqual({
      listModules: false,
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
      listModules: false,
      workspacePath: "/tmp/ws",
      overlayPath: "/tmp/overlay",
      startFrom: "plugin-removal",
      stopAfter: "validate",
    });
  });

  it("requires workspace and overlay paths for run mode", () => {
    expect(() => parseArgs([])).toThrow(/workspace-path/);
    expect(() => parseArgs(["--workspace-path", "/tmp/ws"])).toThrow(/overlay-path/);
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
    ).toEqual({ listModules: true });
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow();
  });
});
