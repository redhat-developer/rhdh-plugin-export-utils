import { assert, describe, expect, it, vi } from "vite-plus/test";

import { MODULES } from "./modules.ts";

describe("MODULES", () => {
  it("exposes the expected pipeline order", () => {
    expect(MODULES.map((m) => m.name)).toEqual([
      "seed-frontend-lockfiles",
      "make-self-contained",
      "generate-manifests",
      "plugin-removal",
      "file-cleanup",
      "protocol-resolution",
      "package-cleanup",
      "hermetic-prep",
      "inject-build-tools",
      "build",
      "re-export",
      "validate",
      "construct-artifact",
    ]);
  });

  it("logs from notImplemented stub modules", async () => {
    const stub = MODULES.find((m) => m.name === "seed-frontend-lockfiles");
    assert.isDefined(stub);

    const log = vi.fn();
    await stub.run({
      workspacePath: "/tmp/ws",
      overlayPath: "/tmp/overlay",
      source: {
        repo: "https://github.com/example/repo",
        "repo-ref": "main",
        "repo-flat": true,
        "repo-backstage-version": "1.0.0",
      },
      log,
    });

    expect(log).toHaveBeenCalledWith("not yet implemented");
  });
});
