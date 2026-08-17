import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { loadFixture, testInputOutputExpectations } from "../../test-utils.ts";
import { run, mergeYamlByTopLevelKey } from "./index.ts";

describe("make-self-contained", () => {
  testInputOutputExpectations(import.meta.dirname, run);

  // --- Behavioral assertions ---

  it("logs skip message for flat repos", async () => {
    using fixture = loadFixture(import.meta.dirname, "flat-repo-noop");
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith("flat repo, skipping");
  });

  it("logs merge messages for basic merge", async () => {
    using fixture = loadFixture(import.meta.dirname, "non-flat-basic-merge");
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith("merging .yarn/ from repo root");
    expect(fixture.ctx.log).toHaveBeenCalledWith(
      "copying .yarnrc.yml from repo root (workspace has none)",
    );
  });

  it("workspace .yarn/ files take precedence over root files", async () => {
    using fixture = loadFixture(import.meta.dirname, "non-flat-merge-with-overlap");
    await run(fixture.ctx);
    const binary = fs.readFileSync(
      path.join(fixture.ctx.workspacePath, ".yarn/releases/yarn-4.9.2.cjs"),
      "utf8",
    );
    expect(binary).toContain("workspace");
    expect(binary).not.toContain("root");
  });

  it("workspace keys override root keys in yarnrc merge", async () => {
    using fixture = loadFixture(import.meta.dirname, "non-flat-yarnrc-merge");
    await run(fixture.ctx);
    const content = fs.readFileSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), "utf8");
    expect(content).toContain("nodeLinker: pnp");
    expect(content).not.toContain("nodeLinker: node-modules");
  });

  it("workspace plugins array takes precedence in multiline merge", async () => {
    using fixture = loadFixture(import.meta.dirname, "non-flat-yarnrc-multiline");
    await run(fixture.ctx);
    const content = fs.readFileSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), "utf8");
    expect(content).toContain("plugin-interactive-tools");
    expect(content).not.toContain("plugin-workspace-tools");
  });

  it("logs skip messages when root has no config", async () => {
    using fixture = loadFixture(import.meta.dirname, "non-flat-workspace-already-self-contained");
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith(
      "no .yarn/ at repo root, skipping directory merge",
    );
    expect(fixture.ctx.log).toHaveBeenCalledWith(
      "no .yarnrc.yml at repo root, skipping config merge",
    );
  });

  // --- Unit tests for mergeYamlByTopLevelKey ---

  describe("mergeYamlByTopLevelKey", () => {
    it("keeps primary keys over secondary for same key", () => {
      const primary = "nodeLinker: pnp\n";
      const secondary = "nodeLinker: node-modules\n";
      const result = mergeYamlByTopLevelKey(primary, secondary);
      expect(result).toContain("nodeLinker: pnp");
      expect(result).not.toContain("node-modules");
    });

    it("appends secondary-only keys", () => {
      const primary = "nodeLinker: pnp\n";
      const secondary = "enableGlobalCache: false\n";
      const result = mergeYamlByTopLevelKey(primary, secondary);
      expect(result).toContain("nodeLinker: pnp");
      expect(result).toContain("enableGlobalCache: false");
    });

    it("preserves multi-line values as blocks", () => {
      const primary = "plugins:\n  - path: a.cjs\n    spec: a\n";
      const secondary = "plugins:\n  - path: b.cjs\n    spec: b\nyarnPath: x\n";
      const result = mergeYamlByTopLevelKey(primary, secondary);
      expect(result).toContain("path: a.cjs");
      expect(result).not.toContain("path: b.cjs");
      expect(result).toContain("yarnPath: x");
    });

    it("produces trailing newline", () => {
      const result = mergeYamlByTopLevelKey("a: 1\n", "b: 2\n");
      expect(result).toMatch(/\n$/);
    });

    it("handles nested object values (npmScopes-style)", () => {
      const primary = "npmScopes:\n  backstage:\n    npmRegistryServer: https://custom.registry\n";
      const secondary =
        "npmScopes:\n  backstage:\n    npmRegistryServer: https://default.registry\nyarnPath: .yarn/releases/yarn.cjs\n";
      const result = mergeYamlByTopLevelKey(primary, secondary);
      expect(result).toContain("https://custom.registry");
      expect(result).not.toContain("https://default.registry");
      expect(result).toContain("yarnPath: .yarn/releases/yarn.cjs");
    });

    it("preserves key ordering: primary keys first, then secondary-only keys", () => {
      const primary = "b: 2\na: 1\n";
      const secondary = "c: 3\na: 9\nd: 4\n";
      const result = mergeYamlByTopLevelKey(primary, secondary);
      const lines = result.trim().split("\n");
      expect(lines).toEqual(["b: 2", "a: 1", "c: 3", "d: 4"]);
    });

    it("handles simple array values", () => {
      const primary = 'unsafeHttpWhitelist:\n  - "*.example.com"\n  - localhost\n';
      const secondary = 'unsafeHttpWhitelist:\n  - "*.other.com"\nyarnPath: x\n';
      const result = mergeYamlByTopLevelKey(primary, secondary);
      expect(result).toContain("*.example.com");
      expect(result).not.toContain("*.other.com");
      expect(result).toContain("yarnPath: x");
    });
  });
});
