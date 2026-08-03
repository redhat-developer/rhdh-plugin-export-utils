import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { PipelineInputs } from "./types.ts";
import { type PipelineModule, loadPipelineInputs, runPipeline, selectModules } from "./pipeline.ts";

const inputs: PipelineInputs = {
  workspacePath: "/tmp/ws",
  overlayPath: "/tmp/overlay",
  source: {
    repo: "https://example.com/repo",
    "repo-ref": "main",
    "repo-flat": false,
    "repo-backstage-version": "1.45.1",
  },
};

function fakeModules(names: string[], failing?: string): PipelineModule[] {
  return names.map((name) => ({
    name,
    run: vi.fn(async () => {
      if (name === failing) {
        throw new Error(`boom from ${name}`);
      }
    }),
  }));
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-sources-"));
  tempDirs.push(dir);
  return dir;
}

describe("loadPipelineInputs", () => {
  it("loads source.json from the overlay path", () => {
    const workspacePath = tempDir();
    const overlayPath = tempDir();
    fs.writeFileSync(
      path.join(overlayPath, "source.json"),
      JSON.stringify({
        repo: "https://github.com/example/repo",
        "repo-ref": "abc123",
        "repo-flat": true,
        "repo-backstage-version": "1.45.1",
      }),
    );

    const result = loadPipelineInputs(workspacePath, overlayPath);
    expect(result.source.repo).toBe("https://github.com/example/repo");
    expect(result.source["repo-flat"]).toBe(true);
    expect(result.source["repo-backstage-version"]).toBe("1.45.1");
    expect(result.source["repo-ref"]).toBe("abc123");
    expect(result.workspacePath).toBe(workspacePath);
    expect(result.overlayPath).toBe(overlayPath);
  });

  it("throws when workspace path does not exist", () => {
    expect(() => loadPipelineInputs("/nonexistent", tempDir())).toThrow(
      "workspace path does not exist",
    );
  });

  it("throws when overlay path does not exist", () => {
    expect(() => loadPipelineInputs(tempDir(), "/nonexistent")).toThrow(
      "overlay path does not exist",
    );
  });

  it("throws when source.json is missing or invalid JSON", () => {
    expect(() => loadPipelineInputs(tempDir(), tempDir())).toThrow();
    const overlayPath = tempDir();
    fs.writeFileSync(path.join(overlayPath, "source.json"), "{");
    expect(() => loadPipelineInputs(tempDir(), overlayPath)).toThrow();
  });
});

describe("selectModules", () => {
  const modules = fakeModules(["a", "b", "c", "d"]);

  it("defaults to the full list", () => {
    expect(selectModules(modules).map((m) => m.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("slices inclusively", () => {
    expect(selectModules(modules, "b", "c").map((m) => m.name)).toEqual(["b", "c"]);
  });

  it("rejects unknown names and inverted ranges", () => {
    expect(() => selectModules(modules, "nope")).toThrow(/--list-modules/);
    expect(() => selectModules(modules, "c", "b")).toThrow(/after/);
  });
});

describe("runPipeline", () => {
  it("runs modules in order and aborts on failure", async () => {
    const modules = fakeModules(["a", "b", "c"], "b");
    await expect(runPipeline(modules, inputs)).rejects.toThrow("boom from b");
    expect(vi.mocked(modules[0]!.run)).toHaveBeenCalledOnce();
    expect(vi.mocked(modules[1]!.run)).toHaveBeenCalledOnce();
    expect(vi.mocked(modules[2]!.run)).not.toHaveBeenCalled();
  });

  it("honors start/stop bounds", async () => {
    const modules = fakeModules(["a", "b", "c", "d"]);
    await runPipeline(modules, inputs, "b", "c");
    expect(vi.mocked(modules[0]!.run)).not.toHaveBeenCalled();
    expect(vi.mocked(modules[1]!.run)).toHaveBeenCalledOnce();
    expect(vi.mocked(modules[2]!.run)).toHaveBeenCalledOnce();
    expect(vi.mocked(modules[3]!.run)).not.toHaveBeenCalled();
  });

  it("binds ctx.log to the module name", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const modules: PipelineModule[] = [
      {
        name: "example",
        run: async (ctx) => {
          ctx.log("hello");
        },
      },
    ];
    await runPipeline(modules, inputs);
    expect(error).toHaveBeenCalledWith("[example]   hello");
    error.mockRestore();
  });

  it("runs notImplemented modules without error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn(async () => {});
    const realInputs: PipelineInputs = {
      ...inputs,
      workspacePath: tempDir(),
      overlayPath: tempDir(),
    };
    const stub = async (ctx: { log: (msg: string) => void }) => {
      ctx.log("not yet implemented");
    };
    const modules: PipelineModule[] = [
      { name: "stub", run: stub },
      { name: "real", run: after },
    ];
    await runPipeline(modules, realInputs);
    expect(error).toHaveBeenCalledWith("[stub]   not yet implemented");
    expect(after).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
